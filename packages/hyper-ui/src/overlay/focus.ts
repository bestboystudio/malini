import { getContext, setContext, tick } from 'svelte';

const FOCUS_RETURN_KEY = Symbol('hyper-overlay-focus-return');

export type OverlayFocusReturn = () => boolean;

export function setOverlayFocusReturn(focusReturn: OverlayFocusReturn): void {
	setContext(FOCUS_RETURN_KEY, focusReturn);
}

export function getOverlayFocusReturn(): OverlayFocusReturn | undefined {
	return getContext<OverlayFocusReturn | undefined>(FOCUS_RETURN_KEY);
}

type Focusable<Options> = Readonly<{ focus(options?: Options): unknown }>;

export function focusIsUnclaimed(): boolean {
	const active = document.activeElement;
	if (!(active instanceof HTMLElement)) return true;
	if (active.closest('[role="dialog"]')) return false;
	return !active.matches('input, textarea, select, [contenteditable], [role="textbox"]');
}

export function claimFocus<Options = FocusOptions>(
	target: Focusable<Options> | null | undefined,
	options?: Options,
	unclaimed: () => boolean = focusIsUnclaimed,
): boolean {
	if (!target || !document.hasFocus() || !unclaimed()) return false;
	target.focus(options);
	return true;
}

export function focusFromUser<Options = FocusOptions>(
	target: Focusable<Options> | null | undefined,
	options?: Options,
): void {
	target?.focus(options);
}

let returningFocus = false;

export function returnFocus(target: HTMLElement | null | undefined): void {
	if (!target?.isConnected) return;
	returningFocus = true;
	try {
		target.focus({ preventScroll: true });
	} finally {
		returningFocus = false;
	}
}

export function isReturningFocus(): boolean {
	return returningFocus;
}

const INTERACTIVE_ITEM_SELECTOR = [
	'[role="option"]:not([aria-disabled="true"])',
	'[role="menuitem"]:not([aria-disabled="true"])',
	'button:not(:disabled)',
	'a[href]',
	'[tabindex]:not([tabindex="-1"])',
].join(', ');

export type RovingFocusDirection = 'next' | 'previous' | 'first' | 'last';

export interface RovingFocusOptions {
	container: () => HTMLElement | null;
	anchor?: () => HTMLElement | null;
	restoreFocus?: () => boolean;
	canRestore?: () => boolean;
	focusReturn?: OverlayFocusReturn | undefined;
}

export interface RovingFocus {
	items(): HTMLElement[];
	focus(direction: RovingFocusDirection): void;
	handleArrowKeys(event: KeyboardEvent): boolean;
	restoreAnchorFocus(): Promise<void>;
}

const ARROW_DIRECTIONS: Readonly<Record<string, RovingFocusDirection>> = {
	ArrowDown: 'next',
	ArrowUp: 'previous',
	Home: 'first',
	End: 'last',
};

export function createRovingFocus(options: RovingFocusOptions): RovingFocus {
	function items(): HTMLElement[] {
		const container = options.container();
		if (!container) return [];
		return Array.from(container.querySelectorAll<HTMLElement>(INTERACTIVE_ITEM_SELECTOR)).filter(
			(item) => item !== container && !item.hasAttribute('disabled'),
		);
	}

	function focus(direction: RovingFocusDirection): void {
		const focusable = items();
		if (focusable.length === 0) return;
		const active = document.activeElement;
		const current = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
		let nextIndex = 0;
		if (direction === 'last' || (direction === 'previous' && current < 0)) {
			nextIndex = focusable.length - 1;
		} else if (direction === 'next' && current >= 0) {
			nextIndex = (current + 1) % focusable.length;
		} else if (direction === 'previous' && current >= 0) {
			nextIndex = (current - 1 + focusable.length) % focusable.length;
		}
		focusable[nextIndex]?.focus({ preventScroll: true });
	}

	function handleArrowKeys(event: KeyboardEvent): boolean {
		const direction = ARROW_DIRECTIONS[event.key];
		if (!direction || items().length === 0) return false;
		event.preventDefault();
		focus(direction);
		return true;
	}

	function focusIsOurs(anchor: HTMLElement | null): boolean {
		const active = document.activeElement;
		if (!active || active === document.body) return true;
		return Boolean(options.container()?.contains(active) || anchor?.contains(active));
	}

	async function restoreAnchorFocus(): Promise<void> {
		if (options.restoreFocus && !options.restoreFocus()) return;
		await tick();
		if (options.canRestore && !options.canRestore()) return;
		const anchor = options.anchor?.() ?? null;
		if (!focusIsOurs(anchor)) return;
		if (options.focusReturn?.()) return;
		returnFocus(anchor);
	}

	return { items, focus, handleArrowKeys, restoreAnchorFocus };
}
