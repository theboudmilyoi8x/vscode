/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable, IReader, ISettableObservable, observableFromEvent, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { basename, isEqual } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { MultiDiffEditorInput } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { MultiDiffEditorItem } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { IChatResponseFileChangesService } from '../../../../workbench/contrib/chat/browser/chatResponseFileChangesService.js';
import { IChatEditingService, IEditSessionEntryDiff } from '../../../../workbench/contrib/chat/common/editing/chatEditingService.js';
import { isRequestVM } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { budgetBucketPrompts, MAX_TICKS, PromptItem } from './promptBucketing.js';

/** Aggregated diff stats for the edits a prompt (or bucket) produced. */
export interface PromptDiffStat {
	readonly added: number;
	readonly removed: number;
	readonly fileCount: number;
}

/** A single file changed by a prompt, used by the hover card / diff drill-down. */
export interface PromptFileDiff {
	readonly name: string;
	readonly originalURI: URI;
	readonly modifiedURI: URI;
	readonly added: number;
	readonly removed: number;
}

/** A single tick shown on the prompt timeline rail. */
export interface PromptTick {
	/** Jump target: the request id of the first prompt in the bucket. */
	readonly requestId: string;
	/** Request ids of every prompt this tick represents (for active tracking). */
	readonly allRequestIds: readonly string[];
	/** Preview text (first prompt in the bucket). */
	readonly text: string;
	/** Creation time (ms since epoch) of the first prompt in the bucket. */
	readonly timestamp: number;
	/** How many prompts this tick represents. */
	readonly count: number;
	/** Accessible label announced for the tick. */
	readonly ariaLabel: string;
	/** Diff summary of the edits this tick produced, if any. */
	readonly stat?: PromptDiffStat;
}

const MAX_PREVIEW_LENGTH = 80;

/** First non-empty line of a prompt, trimmed and length-capped for previews. */
function getPromptPreview(text: string): string {
	const firstLine = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
	return firstLine.length <= MAX_PREVIEW_LENGTH ? firstLine : `${firstLine.slice(0, MAX_PREVIEW_LENGTH)}…`;
}

/** Whether two derived prompt lists are equivalent (order, id, text and time). */
function promptsEqual(a: readonly PromptItem[], b: readonly PromptItem[]): boolean {
	return a.length === b.length && a.every((p, i) =>
		p.requestId === b[i].requestId && p.text === b[i].text && p.timestamp === b[i].timestamp);
}

/** A user prompt entry (used by the keyboard "Go to Prompt" picker, independent of rail density). */
export interface PromptEntry {
	readonly requestId: string;
	readonly text: string;
	readonly timestamp: number;
	readonly stat?: PromptDiffStat;
}

/**
 * Derives the prompt timeline (bucketed ticks + the active tick) from a chat
 * widget's view model, and reveals prompts on request.
 */
export class PromptTimelineModel extends Disposable {

	/** All user prompts in the chat, updated as the transcript changes. */
	private readonly _prompts: ISettableObservable<readonly PromptItem[]> = observableValue<readonly PromptItem[]>(this, []);

	/** Maximum ticks the rail can show at >=24px each; lowered as the transcript shrinks. */
	private readonly _displayBudget: ISettableObservable<number> = observableValue<number>(this, MAX_TICKS);

	/** The chat session resource, tracked reactively so the editing session can be resolved. */
	private readonly _sessionResource = observableFromEvent(this, this.widget.onDidChangeViewModel, () => this.widget.viewModel?.sessionResource);

	/** The chat editing session for this chat, if one exists (local or agent-host). */
	private readonly _editingSession = derived(this, reader => {
		const resource = this._sessionResource.read(reader);
		if (!resource) {
			return undefined;
		}
		return this.chatEditingService.editingSessionsObs.read(reader).find(s => isEqual(s.chatSessionResource, resource));
	});

	/** Recency-bucketed ticks, capped to the display budget so each keeps a >=24px slot. */
	private readonly _baseTicks = derived<readonly PromptTick[]>(this, reader => {
		const prompts = this._prompts.read(reader);
		const budget = this._displayBudget.read(reader);
		return budgetBucketPrompts(prompts, Date.now(), budget).map((bucket): PromptTick => ({
			requestId: bucket.prompt.requestId,
			allRequestIds: bucket.prompts.map(p => p.requestId),
			text: bucket.prompt.text,
			timestamp: bucket.prompt.timestamp,
			count: bucket.count,
			ariaLabel: bucket.count === 1
				? localize('promptTimeline.tick', "Prompt: {0}", bucket.prompt.text)
				: localize('promptTimeline.tickGrouped', "{0} prompts starting with: {1}", bucket.count, bucket.prompt.text),
		}));
	});

	/** Ticks decorated with per-prompt diff stats (server per-turn changeset, else editing session). */
	private readonly _ticks = derived<readonly PromptTick[]>(this, reader => {
		const base = this._baseTicks.read(reader);
		return base.map(tick => {
			const stat = this._statForRequests(tick.allRequestIds, reader);
			return stat ? { ...tick, stat } : tick;
		});
	});
	get ticks(): IObservable<readonly PromptTick[]> { return this._ticks; }

	private readonly _activeRequestId: ISettableObservable<string | undefined> = observableValue<string | undefined>(this, undefined);
	get activeRequestId(): IObservable<string | undefined> { return this._activeRequestId; }

	private readonly _viewModelListener = this._register(new MutableDisposable());

	constructor(
		private readonly widget: ChatWidget,
		@IChatEditingService private readonly chatEditingService: IChatEditingService,
		@IChatResponseFileChangesService private readonly chatResponseFileChangesService: IChatResponseFileChangesService,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		this._register(this.widget.onDidChangeViewModel(() => this._bindViewModel()));
		this._register(this.widget.onDidScroll(() => this._updateActive()));
		// Re-evaluate the active tick whenever the ticks change (prompts or budget).
		this._register(autorun(reader => {
			this._baseTicks.read(reader);
			this._updateActive();
		}));
		this._bindViewModel();
	}

	private _bindViewModel(): void {
		this._viewModelListener.value = this.widget.viewModel?.onDidChange(() => this._recompute());
		this._recompute();
	}

	private _recompute(): void {
		const prompts: PromptItem[] = [];
		for (const item of this.widget.viewModel?.getItems() ?? []) {
			if (isRequestVM(item)) {
				prompts.push({ requestId: item.id, text: getPromptPreview(item.messageText), timestamp: item.timestamp });
			}
		}

		// Streaming fires onDidChange for every token; only rebuild ticks when the
		// set of prompts actually changed. Rendered heights still shift, so refresh
		// the active tick either way.
		if (promptsEqual(prompts, this._prompts.get())) {
			this._updateActive();
			return;
		}
		this._prompts.set(prompts, undefined);
	}

	/** Recomputes which tick maps to the prompt currently scrolled into view. */
	private _updateActive(): void {
		const ticks = this._baseTicks.get();
		const items = this.widget.viewModel?.getItems();
		if (!items || ticks.length === 0) {
			this._activeRequestId.set(undefined, undefined);
			return;
		}

		// The active prompt is the last request whose top edge is at or above the
		// viewport top. Offsets accumulate from each item's rendered height.
		const scrollTop = this.widget.scrollTop;
		const threshold = 24;
		let offset = 0;
		let activeRequestId: string | undefined;
		let activeTimestamp = 0;
		for (const item of items) {
			if (isRequestVM(item) && offset <= scrollTop + threshold) {
				activeRequestId = item.id;
				activeTimestamp = item.timestamp;
			}
			offset += item.currentRenderedHeight ?? 0;
		}

		if (activeRequestId === undefined) {
			this._activeRequestId.set(ticks.at(-1)?.requestId, undefined);
			return;
		}

		let activeTick = ticks.find(t => t.allRequestIds.includes(activeRequestId!));
		if (!activeTick) {
			// The active prompt's bucket may have been sampled away; fall back to the
			// nearest surviving tick at or before it (ticks are chronological).
			for (const tick of ticks) {
				if (tick.timestamp <= activeTimestamp) {
					activeTick = tick;
				} else {
					break;
				}
			}
		}
		this._activeRequestId.set((activeTick ?? ticks[ticks.length - 1]).requestId, undefined);
	}

	/** Reveals the request with the given id near the top of the transcript. */
	reveal(requestId: string): void {
		const item = this.widget.viewModel?.getItems().find(i => isRequestVM(i) && i.id === requestId);
		if (item) {
			this.widget.reveal(item, 0);
		}
		// Normalize to the owning tick's representative id so sibling navigation and
		// the active highlight work even when the id is a mid-bucket prompt (picker).
		const owningTick = this._baseTicks.get().find(t => t.allRequestIds.includes(requestId));
		this._activeRequestId.set(owningTick?.requestId ?? requestId, undefined);
	}

	/** The tick before/after the currently active one, for keyboard navigation. */
	getSiblingTick(direction: 'next' | 'previous'): PromptTick | undefined {
		const ticks = this._baseTicks.get();
		if (ticks.length === 0) {
			return undefined;
		}
		const activeId = this._activeRequestId.get();
		const currentIndex = activeId !== undefined ? ticks.findIndex(t => t.requestId === activeId) : -1;
		const nextIndex = direction === 'next'
			? Math.min(ticks.length - 1, currentIndex + 1)
			: Math.max(0, (currentIndex === -1 ? ticks.length : currentIndex) - 1);
		return ticks[nextIndex];
	}

	/** The changed files for a tick's prompts, aggregated per file (for the hover card / drill-down). */
	getRequestFiles(tick: PromptTick): readonly PromptFileDiff[] {
		const byPath = new Map<string, PromptFileDiff>();
		for (const requestId of tick.allRequestIds) {
			for (const diff of this._diffsForRequest(requestId)) {
				if (diff.identical) {
					continue;
				}
				const key = diff.modifiedURI.toString();
				const existing = byPath.get(key);
				if (existing) {
					byPath.set(key, { ...existing, added: existing.added + diff.added, removed: existing.removed + diff.removed });
				} else {
					byPath.set(key, {
						name: basename(diff.modifiedURI),
						originalURI: diff.originalURI,
						modifiedURI: diff.modifiedURI,
						added: diff.added,
						removed: diff.removed,
					});
				}
			}
		}
		return [...byPath.values()];
	}

	/** Opens the per-prompt diff: a single file's diff when given, otherwise a multi-file review. */
	async reviewChanges(tick: PromptTick, file?: URI): Promise<void> {
		const files = this.getRequestFiles(tick);
		if (files.length === 0) {
			return;
		}
		if (file) {
			const target = files.find(f => isEqual(f.modifiedURI, file)) ?? files[0];
			const [originalURI, modifiedURI] = await this._readableSides(target);
			if (!originalURI && !modifiedURI) {
				return;
			}
			if (originalURI && modifiedURI) {
				await this.editorService.openEditor({
					original: { resource: originalURI },
					modified: { resource: modifiedURI },
					label: target.name,
				});
			} else {
				await this.editorService.openEditor({ resource: (modifiedURI ?? originalURI)!, label: target.name });
			}
			return;
		}
		const items: MultiDiffEditorItem[] = [];
		for (const f of files) {
			const [originalURI, modifiedURI] = await this._readableSides(f);
			if (originalURI || modifiedURI) {
				items.push(new MultiDiffEditorItem(originalURI, modifiedURI, undefined));
			}
		}
		if (items.length === 0) {
			return;
		}
		const source = URI.parse(`multi-diff-editor:prompt-timeline/${generateUuid()}`);
		const input = this.instantiationService.createInstance(
			MultiDiffEditorInput,
			source,
			localize('promptTimeline.reviewTitle', "Changes · {0}", tick.text),
			items,
			false,
		);
		await this.editorService.openEditor(input);
	}

	/**
	 * Resolves which sides of a file diff can actually be read. Agent-host
	 * per-turn checkpoints can be missing a blob (e.g. an added file's original),
	 * which would otherwise crash the diff editor; an unreadable side is dropped
	 * so the file still opens as a pure add/delete.
	 */
	private async _readableSides(file: PromptFileDiff): Promise<[URI | undefined, URI | undefined]> {
		// A created file reports the same URI on both sides; show it as a pure add.
		if (isEqual(file.originalURI, file.modifiedURI)) {
			return [undefined, (await this._canRead(file.modifiedURI)) ? file.modifiedURI : undefined];
		}
		const [originalExists, modifiedExists] = await Promise.all([
			this._canRead(file.originalURI),
			this._canRead(file.modifiedURI),
		]);
		return [originalExists ? file.originalURI : undefined, modifiedExists ? file.modifiedURI : undefined];
	}

	private async _canRead(resource: URI): Promise<boolean> {
		// Agent-host git-blob URIs always `stat` successfully even when the blob
		// is missing, so probe with an actual read to detect unreadable sides.
		try {
			await this.fileService.readFile(resource);
			return true;
		} catch {
			return false;
		}
	}

	/** Sets how many ticks the rail can display (so each keeps a >=24px hit target). */
	setDisplayBudget(maxTicks: number): void {
		const clamped = Math.max(1, Math.min(MAX_TICKS, Math.floor(maxTicks)));
		if (clamped !== this._displayBudget.get()) {
			this._displayBudget.set(clamped, undefined);
		}
	}

	/**
	 * All user prompts (with diff stats where available) for the picker,
	 * independent of the rail's display budget. Stats are resolved one-shot, so
	 * agent-host prompts not currently observed by the rail fall back to their
	 * timestamp in the picker rather than holding a subscription per prompt.
	 */
	getAllPrompts(): readonly PromptEntry[] {
		return this._prompts.get().map(prompt => {
			const stat = this._statForRequests([prompt.requestId]);
			return stat ? { ...prompt, stat } : { ...prompt };
		});
	}

	/**
	 * Per-request file diffs, preferring the session type's authoritative
	 * provider (agent-host sessions expose a server-computed per-turn changeset
	 * that survives reload), and falling back to the chat editing session.
	 */
	private _diffsForRequest(requestId: string, reader?: IReader): readonly IEditSessionEntryDiff[] {
		const resource = reader ? this._sessionResource.read(reader) : this._sessionResource.get();
		if (resource) {
			const provided = this.chatResponseFileChangesService.getChangesForRequest(resource, requestId);
			if (provided) {
				return reader ? provided.read(reader) : provided.get();
			}
		}
		const session = reader ? this._editingSession.read(reader) : this._editingSession.get();
		if (session) {
			const obs = session.getDiffsForFilesInRequest(requestId);
			return reader ? obs.read(reader) : obs.get();
		}
		return [];
	}

	/** Sums the diff stats across the given requests, or undefined when nothing changed. */
	private _statForRequests(requestIds: readonly string[], reader?: IReader): PromptDiffStat | undefined {
		let added = 0;
		let removed = 0;
		const files = new Set<string>();
		for (const requestId of requestIds) {
			for (const diff of this._diffsForRequest(requestId, reader)) {
				if (diff.identical) {
					continue;
				}
				added += diff.added;
				removed += diff.removed;
				files.add(diff.modifiedURI.toString());
			}
		}
		return files.size > 0 ? { added, removed, fileCount: files.size } : undefined;
	}
}
