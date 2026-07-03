/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableGenericMouseMoveListener, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { PromptFileDiff, PromptTick } from './promptTimelineModel.js';
import './media/promptTimeline.css';

/** Radius (px) around the pointer within which ticks are magnified. */
const MAGNIFY_RADIUS = 64;
/** Horizontal scale added to the tick under the pointer (kept small so pills don't slide under the card). */
const MAGNIFY_STRENGTH_X = 0.4;
/** Vertical scale added to the tick under the pointer, so pills thicken near the pointer. */
const MAGNIFY_STRENGTH_Y = 0.6;

/** Layout constants for the vertical-fit calculation. */
const VERTICAL_PADDING = 24;
/** Minimum clickable target size (WCAG 2.5.8): each tick's hit area is at least this tall. */
const MIN_TARGET = 24;
/** Fewest ticks worth showing; below this the rail hides. */
const MIN_VISIBLE_TICKS = 2;
/** Below this transcript width the rail hides so it does not crowd the content. */
const MIN_HOST_WIDTH = 320;

/** Total-lines thresholds that map a diff to a magnitude bucket (drives tick width when engaged). */
function magnitudeClass(totalLines: number): 'sm' | 'md' | 'lg' {
	if (totalLines >= 150) {
		return 'lg';
	}
	if (totalLines >= 30) {
		return 'md';
	}
	return 'sm';
}

/** Short day label for grouped ticks (no time, since a bucket spans several prompts). */
function formatTickDate(timestamp: number, now: Date): string {
	const date = new Date(timestamp);
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const startOfYesterday = new Date(startOfToday);
	startOfYesterday.setDate(startOfYesterday.getDate() - 1);
	if (date >= startOfToday) {
		return localize('promptTimeline.today', "Today");
	}
	if (date >= startOfYesterday) {
		return localize('promptTimeline.yesterday', "Yesterday");
	}
	return date.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
	});
}

/** Precise time label for single-prompt ticks. */
function formatTickTime(timestamp: number, now: Date): string {
	const date = new Date(timestamp);
	const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	return `${formatTickDate(timestamp, now)}, ${time}`;
}

export interface IPromptReviewFileEvent {
	readonly tick: PromptTick;
	readonly file: URI;
}

/**
 * Presentation-only vertical rail of ticks pinned to the right edge of the chat
 * transcript. Ticks stay neutral at rest and reveal green/red diff colors +
 * magnitude widths when the rail is focused or hovered. Hovering/focusing a tick
 * shows an interactive card (diff shortcut + files).
 */
export class PromptTimelineRail extends Disposable {

	private readonly _domNode: HTMLElement;
	private readonly _surface: HTMLElement;
	private readonly _ticksContainer: HTMLElement;
	private readonly _card: HTMLElement;
	private readonly _tickDisposables = this._register(new DisposableStore());
	private readonly _cardDisposables = this._register(new DisposableStore());
	private readonly _tickElements: HTMLButtonElement[] = [];
	private readonly _ticks: PromptTick[] = [];

	private _activeRequestId: string | undefined;
	private _reducedMotion: MediaQueryList | undefined;
	private _resizeObserverReady = false;
	private _hostWidth = Number.POSITIVE_INFINITY;
	private _hoverEngaged = false;
	private _focusEngaged = false;
	private _cardHovered = false;
	private _cardHideTimer: ReturnType<typeof setTimeout> | undefined;
	private _capacity = Number.POSITIVE_INFINITY;
	private _filesProvider: (tick: PromptTick) => readonly PromptFileDiff[] = () => [];

	private readonly _onDidSelect = this._register(new Emitter<string>());
	readonly onDidSelect: Event<string> = this._onDidSelect.event;

	private readonly _onDidReview = this._register(new Emitter<PromptTick>());
	readonly onDidReview: Event<PromptTick> = this._onDidReview.event;

	private readonly _onDidReviewFile = this._register(new Emitter<IPromptReviewFileEvent>());
	readonly onDidReviewFile: Event<IPromptReviewFileEvent> = this._onDidReviewFile.event;

	/** Fires the maximum number of ticks that fit at >=24px each, as the rail is resized. */
	private readonly _onDidChangeCapacity = this._register(new Emitter<number>());
	readonly onDidChangeCapacity: Event<number> = this._onDidChangeCapacity.event;

	get domNode(): HTMLElement { return this._domNode; }

	constructor() {
		super();
		this._domNode = $('nav.prompt-timeline-rail');
		this._domNode.setAttribute('aria-label', localize('promptTimeline.railLabel', "Prompt timeline"));
		this._domNode.setAttribute('role', 'toolbar');
		// A pointer-events surface (inset from the transcript scrollbar) is the
		// ancestor of the ticks so hover magnify is continuous and reliably resets.
		this._surface = append(this._domNode, $('.prompt-timeline-surface'));
		this._ticksContainer = append(this._surface, $('.prompt-timeline-ticks'));
		this._card = append(this._domNode, $('.prompt-timeline-card'));
		this._card.classList.add('hidden');
		this._register(addDisposableListener(this._card, EventType.MOUSE_ENTER, () => { this._cardHovered = true; }));
		this._register(addDisposableListener(this._card, EventType.MOUSE_LEAVE, () => { this._cardHovered = false; this._scheduleHideCard(); }));

		this._register(addDisposableGenericMouseMoveListener(this._surface, (e: MouseEvent) => {
			this._hoverEngaged = true;
			this._updateEngaged();
			this._applyMagnify(e.clientY);
		}));
		this._register(addDisposableListener(this._surface, EventType.MOUSE_LEAVE, () => {
			this._hoverEngaged = false;
			this._updateEngaged();
			this._applyMagnify(undefined);
			this._scheduleHideCard();
		}));
		this._register(addDisposableListener(this._surface, EventType.CLICK, (e: MouseEvent) => {
			if (e.target === this._surface) {
				this._selectNearestTick(e.clientY);
			}
		}));
		// Keyboard focus within the rail reveals the diff colors, like hover does.
		this._register(addDisposableListener(this._domNode, EventType.FOCUS_IN, () => {
			this._focusEngaged = true;
			this._updateEngaged();
		}));
		this._register(addDisposableListener(this._domNode, EventType.FOCUS_OUT, () => {
			if (!this._domNode.contains(getWindow(this._domNode).document.activeElement)) {
				this._focusEngaged = false;
				this._updateEngaged();
				this._scheduleHideCard();
			}
		}));
	}

	/** Diff colors + magnitude widths are revealed while the rail is hovered or keyboard-focused. */
	private _updateEngaged(): void {
		this._domNode.classList.toggle('engaged', this._hoverEngaged || this._focusEngaged);
	}

	/** Provides the changed files for a tick, used to populate the card on demand. */
	setFilesProvider(provider: (tick: PromptTick) => readonly PromptFileDiff[]): void {
		this._filesProvider = provider;
	}

	setTicks(ticks: readonly PromptTick[]): void {
		// In-place update when the prompt structure is unchanged (e.g. diff stats
		// streaming in): preserves tick focus and any open card.
		const sameStructure = ticks.length === this._ticks.length
			&& ticks.every((t, i) => this._ticks[i]?.requestId === t.requestId);
		if (sameStructure) {
			for (let i = 0; i < ticks.length; i++) {
				this._ticks[i] = ticks[i];
				this._renderTickContent(this._tickElements[i], ticks[i]);
			}
			this._updateActiveClasses();
			this._updateFit();
			return;
		}

		this._tickDisposables.clear();
		this._tickElements.length = 0;
		this._ticks.length = 0;
		clearNode(this._ticksContainer);
		this._hideCard();

		for (const tick of ticks) {
			const button = append(this._ticksContainer, $<HTMLButtonElement>('button.prompt-timeline-tick'));
			this._renderTickContent(button, tick);
			const requestId = tick.requestId;
			this._tickDisposables.add(addDisposableListener(button, EventType.CLICK, (e: MouseEvent) => {
				this._onDidSelect.fire(requestId);
				// A real mouse click (detail > 0) blurs the tick so the rail collapses back to
				// its dense rest state; keyboard activation (detail === 0) keeps focus + engagement.
				if (e.detail > 0) {
					button.blur();
				}
			}));
			this._tickDisposables.add(addDisposableListener(button, EventType.MOUSE_ENTER, () => this._showCard(button, this._tickFor(requestId))));
			this._tickDisposables.add(addDisposableListener(button, EventType.FOCUS, () => this._showCard(button, this._tickFor(requestId))));
			this._tickElements.push(button);
			this._ticks.push(tick);
		}

		this._updateActiveClasses();
		this._updateFit();
	}

	private _tickFor(requestId: string): PromptTick {
		return this._ticks.find(t => t.requestId === requestId) ?? this._ticks[0];
	}

	/** Renders a tick's visible bar/segments from its diff stat (create or in-place update). */
	private _renderTickContent(button: HTMLButtonElement, tick: PromptTick): void {
		clearNode(button);
		button.className = 'prompt-timeline-tick';
		button.setAttribute('aria-label', tick.ariaLabel);
		// The button is the >=24px hit target (WCAG 2.5.8); the visible bar sits inside it.
		const bar = append(button, $('span.prompt-timeline-tick-bar'));
		if (tick.count > 1) {
			bar.classList.add('grouped');
		}
		const stat = tick.stat;
		if (stat && stat.added + stat.removed > 0) {
			const addEl = append(bar, $('span.seg-add'));
			const delEl = append(bar, $('span.seg-del'));
			addEl.style.flexGrow = String(stat.added);
			delEl.style.flexGrow = String(stat.removed);
			button.dataset.mag = magnitudeClass(stat.added + stat.removed);
		} else {
			bar.classList.add('no-edits');
			delete button.dataset.mag;
		}
	}

	setActive(requestId: string | undefined): void {
		this._activeRequestId = requestId;
		this._updateActiveClasses();
	}

	focusTick(requestId: string): void {
		const index = this._ticks.findIndex(t => t.requestId === requestId || t.allRequestIds.includes(requestId));
		this._tickElements[index]?.focus();
	}

	private _updateActiveClasses(): void {
		const activeIndex = this._activeRequestId !== undefined ? this._ticks.findIndex(t => t.requestId === this._activeRequestId) : -1;
		for (let i = 0; i < this._tickElements.length; i++) {
			const el = this._tickElements[i];
			const isActive = i === activeIndex;
			el.classList.toggle('active', isActive);
			if (isActive) {
				el.setAttribute('aria-current', 'location');
			} else {
				el.removeAttribute('aria-current');
			}
		}
	}

	// -- Interactive card --

	private _showCard(anchor: HTMLElement, tick: PromptTick): void {
		if (this._cardHideTimer !== undefined) {
			clearTimeout(this._cardHideTimer);
			this._cardHideTimer = undefined;
		}
		this._cardDisposables.clear();
		clearNode(this._card);
		const now = new Date();

		const head = append(this._card, $('.prompt-timeline-card-head'));
		append(head, $('.prompt-timeline-card-text')).textContent = tick.text;
		this._renderMeta(append(head, $('.prompt-timeline-card-meta')), tick, now);

		const files = tick.stat ? this._filesProvider(tick) : [];
		if (tick.stat) {
			const diffAction = append(head, $<HTMLButtonElement>('button.prompt-timeline-card-diff-action'));
			diffAction.setAttribute('aria-label', localize(
				'promptTimeline.reviewChangesForPrompt',
				"Review Changes for Prompt: {0}",
				tick.text,
			));
			this._renderStat(append(diffAction, $('span.prompt-timeline-card-stat')), tick.stat.added, tick.stat.removed);
			append(diffAction, $('span')).textContent = tick.stat.fileCount === 1
				? localize('promptTimeline.oneFile', "1 file")
				: localize('promptTimeline.nFiles', "{0} files", tick.stat.fileCount);
			append(diffAction, $('span.prompt-timeline-card-diff-action-chevron')).textContent = '\u203A';
			this._cardDisposables.add(addDisposableListener(diffAction, EventType.CLICK, () => {
				this._onDidReview.fire(tick);
				this._hideCard();
			}));
		} else {
			append(head, $('div.prompt-timeline-card-no-edits')).textContent = localize('promptTimeline.noEdits', "no edits");
		}

		if (files.length > 0) {
			const list = append(this._card, $('.prompt-timeline-card-files'));
			for (const file of files) {
				const row = append(list, $<HTMLButtonElement>('button.prompt-timeline-card-file'));
				row.title = file.name;
				append(row, $('.prompt-timeline-card-fname')).textContent = file.name;
				this._renderStat(append(row, $('.prompt-timeline-card-fstat')), file.added, file.removed);
				this._cardDisposables.add(addDisposableListener(row, EventType.CLICK, () => {
					this._onDidReviewFile.fire({ tick, file: file.modifiedURI });
					this._hideCard();
				}));
			}
		}

		// Position the card next to the anchored tick, clamped to the rail height.
		const anchorRect = anchor.getBoundingClientRect();
		const domRect = this._domNode.getBoundingClientRect();
		this._card.classList.remove('hidden');
		const top = anchorRect.top - domRect.top + anchorRect.height / 2 - this._card.offsetHeight / 2;
		const clampedTop = Math.max(4, Math.min(top, this._domNode.clientHeight - this._card.offsetHeight - 4));
		this._card.style.top = `${clampedTop}px`;
	}

	private _renderMeta(container: HTMLElement, tick: PromptTick, now: Date): void {
		const time = append(container, $('span'));
		time.textContent = tick.count > 1
			? localize('promptTimeline.groupedMeta', "{0} · {1} prompts", formatTickDate(tick.timestamp, now), tick.count)
			: formatTickTime(tick.timestamp, now);
	}

	private _renderStat(container: HTMLElement, added: number, removed: number): void {
		append(container, $('span.added')).textContent = `+${added}`;
		append(container, $('span.removed')).textContent = `\u2212${removed}`;
	}

	private _scheduleHideCard(): void {
		if (this._cardHideTimer !== undefined) {
			clearTimeout(this._cardHideTimer);
		}
		this._cardHideTimer = setTimeout(() => {
			this._cardHideTimer = undefined;
			if (!this._cardHovered) {
				this._hideCard();
			}
		}, 200);
	}

	private _hideCard(): void {
		this._cardHovered = false;
		this._cardDisposables.clear();
		this._card.classList.add('hidden');
	}

	private _isReducedMotion(): boolean {
		this._reducedMotion ??= getWindow(this._domNode).matchMedia('(prefers-reduced-motion: reduce)');
		return this._reducedMotion.matches;
	}

	/** Reports the transcript width; a very narrow transcript hides the rail. */
	setHostWidth(width: number): void {
		if (width > 0 && width !== this._hostWidth) {
			this._hostWidth = width;
			this._updateFit();
		}
	}

	/**
	 * Measures how many ticks fit at >=24px each, reports that capacity (so the
	 * model can reduce tick count), and hides the rail when fewer than two fit or
	 * the transcript is too narrow.
	 */
	private _updateFit(): void {
		// Resolved lazily so the observer binds to the mounted element's window
		// (mirrors _isReducedMotion), which matters for auxiliary windows.
		this._ensureResizeObserver();
		const available = this._domNode.clientHeight;
		// A zero height means the rail is not laid out yet (e.g. display:none via
		// the data-driven `.hidden` class); a later resize re-runs this.
		if (available <= 0) {
			return;
		}
		const capacity = Math.max(0, Math.floor((available - VERTICAL_PADDING) / MIN_TARGET));
		const overflowing = this._hostWidth < MIN_HOST_WIDTH || capacity < MIN_VISIBLE_TICKS;
		this._domNode.classList.toggle('overflowing', overflowing);

		if (capacity !== this._capacity) {
			this._capacity = capacity;
			this._onDidChangeCapacity.fire(capacity);
		}
	}

	private _ensureResizeObserver(): void {
		if (this._resizeObserverReady) {
			return;
		}
		const ResizeObserverCtor = getWindow(this._domNode).ResizeObserver;
		if (!ResizeObserverCtor) {
			return;
		}
		this._resizeObserverReady = true;
		const observer = new ResizeObserverCtor(() => this._updateFit());
		observer.observe(this._domNode);
		this._register(toDisposable(() => observer.disconnect()));
	}

	private _applyMagnify(pointerY: number | undefined): void {
		const engaged = pointerY !== undefined;
		const reduced = this._isReducedMotion();
		for (const el of this._tickElements) {
			let scaleX = 1;
			let scaleY = 1;
			if (engaged && !reduced) {
				const rect = el.getBoundingClientRect();
				const center = rect.top + rect.height / 2;
				const distance = Math.abs(pointerY - center);
				if (distance < MAGNIFY_RADIUS) {
					const influence = 1 - distance / MAGNIFY_RADIUS;
					scaleX = 1 + influence * MAGNIFY_STRENGTH_X;
					scaleY = 1 + influence * MAGNIFY_STRENGTH_Y;
				}
			}
			el.style.setProperty('--tick-scale', scaleX.toFixed(3));
			el.style.setProperty('--tick-scale-y', scaleY.toFixed(3));
		}
	}

	private _selectNearestTick(pointerY: number): void {
		let nearest = -1;
		let nearestDistance = Number.POSITIVE_INFINITY;
		for (let i = 0; i < this._tickElements.length; i++) {
			const rect = this._tickElements[i].getBoundingClientRect();
			const distance = Math.abs(pointerY - (rect.top + rect.height / 2));
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearest = i;
			}
		}
		if (nearest !== -1) {
			this._onDidSelect.fire(this._ticks[nearest].requestId);
		}
	}

	override dispose(): void {
		if (this._cardHideTimer !== undefined) {
			clearTimeout(this._cardHideTimer);
		}
		super.dispose();
	}
}
