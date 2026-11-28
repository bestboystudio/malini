import type { Attachment } from 'svelte/attachments';
import type { UsageStepValue } from '$contract/system';
import { usageStepsService } from '$shared/system/usage-steps.service';
import { focusIsUnclaimed, overlayIsOpen } from './unclaimed-focus';

export type ComposerFocusLoss = UsageStepValue<'composer_focus_lost'>;

const USER_CAUSE_MS = 300;
const USER_REPLACES_MS = 1_000;
const WATCHED_ATTRIBUTES = ['inert', 'hidden', 'class', 'style', 'contenteditable', 'tabindex'];
const EDITOR = '[contenteditable]';

export type ComposerFocusOwner = Readonly<{
	workstreamId(): string;
	focus(): boolean;
	away(): boolean;
	composing(): boolean;
}>;

let commandAt = Number.NEGATIVE_INFINITY;
let guarded: ComposerFocusOwner | null = null;

export function noteUserAction(): void {
	commandAt = performance.now();
}

export function userIsComposingIn(workstreamId: string): boolean {
	return guarded?.workstreamId() === workstreamId && guarded.composing();
}

type Mutation = Readonly<{ at: number; change: string }>;

type Loss = Readonly<{
	to: Element | null;
	excusedMove: boolean;
	userReplaced: boolean;
	composing: boolean;
	dropped: ComposerFocusLoss;
	state: readonly string[];
	mutation: string | null;
	frames: string;
}>;

export function guardComposerFocus(owner: ComposerFocusOwner): Attachment<HTMLElement> {
	return (slot) => watchComposerFocus(slot, owner);
}

function watchComposerFocus(slot: HTMLElement, owner: ComposerFocusOwner): () => void {
	guarded = owner;
	let pointerAt = Number.NEGATIVE_INFINITY;
	let pointerTarget: Node | null = null;
	let pointerTurn = false;
	let keyTurn = false;
	let focusedEditor: HTMLElement | null = null;
	let lastMutation: Mutation | null = null;

	const note = (records: readonly MutationRecord[]): void => {
		for (const record of records) {
			const change = chainChange(record, focusedEditor);
			if (change) lastMutation = { at: performance.now(), change };
			if (focusedEditor && removesNode(record, focusedEditor)) {
				const editor = focusedEditor;
				focusedEditor = null;
				lose(editor, null, false);
			}
		}
	};
	const chain = new MutationObserver(note);

	const watchChain = (editor: HTMLElement): void => {
		chain.disconnect();
		for (let node: Element | null = editor; node; node = node.parentElement) {
			chain.observe(node, {
				attributes: true,
				attributeFilter: WATCHED_ATTRIBUTES,
				attributeOldValue: true,
				childList: true,
			});
		}
	};

	const lose = (editor: HTMLElement, to: Element | null, excusedMove: boolean): void => {
		note(chain.takeRecords());
		const at = performance.now();
		const loss: Loss = {
			to,
			excusedMove,
			userReplaced: at - Math.max(pointerAt, commandAt) < USER_REPLACES_MS,
			composing: owner.composing(),
			dropped: droppedCause(editor),
			state: editorState(editor),
			mutation: lastMutation
				? `${lastMutation.change}, ${Math.round(at - lastMutation.at)}ms before`
				: null,
			frames: new Error().stack?.split('\n').slice(1).join('\n') ?? '',
		};
		setTimeout(() => settle(loss));
	};

	const settle = (loss: Loss): void => {
		if (!slot.isConnected) return;
		const active = document.activeElement;
		const editor = slot.querySelector(EDITOR);
		if (editor && active && editor.contains(active)) return;
		const to = loss.to ?? (active && active !== document.body ? active : null);
		if (to && loss.excusedMove) return;
		// ponytail: a pointer inside a frame never reaches this window, so a frame under the pointer counts as clicked; a frame that grabs focus under a resting pointer passes too, until the frame reports its own pointerdown
		if (to instanceof HTMLIFrameElement && to.matches(':hover')) return;
		// ponytail: a user press up to a second before counts as asking for what replaced the composer, so an agent's replacement in that second passes too; a per-action intent token is the upgrade
		if (owner.away() && (!loss.composing || loss.userReplaced)) return;
		report(loss, to);
		heal();
	};

	const heal = (): void => {
		const editor = slot.querySelector(EDITOR);
		if (!(editor instanceof HTMLElement) || !document.hasFocus() || overlayIsOpen()) return;
		if (!focusIsUnclaimed() || editor.closest('[inert]') || !editor.checkVisibility()) return;
		owner.focus();
	};

	const report = (loss: Loss, to: Element | null): void => {
		const cause = to ? movedCause(to) : loss.dropped;
		const detail = {
			cause,
			to: to ? describe(to) : 'body',
			windowFocused: document.hasFocus(),
			editor: loss.state,
			mutation: loss.mutation,
		};
		const message = `composer-focus-lost ${JSON.stringify(detail)}`;
		const error = new Error(message);
		error.name = 'ComposerFocusLost';
		error.stack = `ComposerFocusLost: ${message}\n${loss.frames}`;
		console.error(error);
		usageStepsService.count({ step: 'composer_focus_lost', value: cause });
	};

	const endTurn = (): void => {
		pointerTurn = false;
		keyTurn = false;
	};

	const onPointerdown = (event: PointerEvent): void => {
		if (!event.isTrusted) return;
		pointerAt = performance.now();
		pointerTarget = event.target instanceof Node ? event.target : null;
		pointerTurn = true;
		setTimeout(endTurn);
	};

	const onKeydown = (event: KeyboardEvent): void => {
		if (!event.isTrusted) return;
		keyTurn = true;
		setTimeout(endTurn);
		if (!typesIntoEditor(event)) noteUserAction();
	};

	const onFocusin = (event: FocusEvent): void => {
		const editor = editorOf(event.target);
		if (!editor || editor === focusedEditor) return;
		focusedEditor = editor;
		watchChain(editor);
	};

	const onFocusout = (event: FocusEvent): void => {
		const editor = editorOf(event.target);
		const to = event.relatedTarget instanceof Element ? event.relatedTarget : null;
		if (!editor || (to && editor.contains(to))) return;
		focusedEditor = null;
		if (pointerTurn) return;
		const now = performance.now();
		const excusedMove =
			keyTurn ||
			now - pointerAt < USER_CAUSE_MS ||
			now - commandAt < USER_CAUSE_MS ||
			(to !== null && pointerTarget !== null && related(to, pointerTarget));
		lose(editor, to, excusedMove);
	};

	const editorOf = (target: EventTarget | null): HTMLElement | null => {
		if (!(target instanceof HTMLElement)) return null;
		return target.matches(EDITOR) && slot.contains(target) ? target : null;
	};

	window.addEventListener('pointerdown', onPointerdown, true);
	window.addEventListener('keydown', onKeydown, true);
	slot.addEventListener('focusin', onFocusin);
	slot.addEventListener('focusout', onFocusout);
	return () => {
		if (guarded === owner) guarded = null;
		chain.disconnect();
		window.removeEventListener('pointerdown', onPointerdown, true);
		window.removeEventListener('keydown', onKeydown, true);
		slot.removeEventListener('focusin', onFocusin);
		slot.removeEventListener('focusout', onFocusout);
	};
}

function typesIntoEditor(event: KeyboardEvent): boolean {
	const typed = !event.metaKey && !event.ctrlKey && !event.altKey;
	return (
		typed &&
		event.key !== 'Tab' &&
		event.key !== 'Escape' &&
		event.target instanceof Element &&
		event.target.closest(EDITOR) !== null
	);
}

function related(a: Node, b: Node): boolean {
	return a.contains(b) || b.contains(a);
}

function removesNode(record: MutationRecord, node: Node): boolean {
	return [...record.removedNodes].some((removed) => removed.contains(node));
}

function chainChange(record: MutationRecord, editor: HTMLElement | null): string | null {
	if (record.type === 'childList') {
		return editor && removesNode(record, editor)
			? `${describe(record.target)} removed the editor`
			: null;
	}
	if (!(record.target instanceof Element) || record.attributeName === null) return null;
	const name = record.attributeName;
	if (name === 'class' && record.target.matches(EDITOR)) return null;
	const now = record.target.getAttribute(name);
	if (name === 'class')
		return `${describe(record.target)} class ${classDiff(record.oldValue, now)}`;
	return `${describe(record.target)} ${name}=${JSON.stringify(now?.slice(0, 80) ?? null)}`;
}

function classDiff(before: string | null, after: string | null): string {
	const was = new Set(before?.split(/\s+/u).filter(Boolean));
	const is = new Set(after?.split(/\s+/u).filter(Boolean));
	const added = [...is].filter((name) => !was.has(name)).map((name) => `+${name}`);
	const removed = [...was].filter((name) => !is.has(name)).map((name) => `-${name}`);
	return [...added, ...removed].join(' ') || 'unchanged';
}

function droppedCause(editor: HTMLElement): ComposerFocusLoss {
	if (!editor.isConnected) return 'dropped_removed';
	if (editor.closest('[inert]')) return 'dropped_inert';
	if (!editor.checkVisibility()) return 'dropped_hidden';
	if (!editor.isContentEditable) return 'dropped_read_only';
	return 'dropped';
}

function movedCause(to: Element): ComposerFocusLoss {
	if (to.closest('[role="dialog"], dialog')) return 'moved_to_dialog';
	if (to instanceof HTMLIFrameElement) return 'moved_to_frame';
	if (to.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) {
		return 'moved_to_field';
	}
	return 'moved_to_control';
}

function editorState(editor: HTMLElement): string[] {
	const state = [
		`contenteditable=${editor.getAttribute('contenteditable')}`,
		`tabindex=${editor.getAttribute('tabindex')}`,
	];
	if (!editor.isConnected) state.push('disconnected');
	for (let node: Element | null = editor; node; node = node.parentElement) {
		const flags = [
			node.hasAttribute('inert') && 'inert',
			node.hasAttribute('hidden') && 'hidden',
			node instanceof HTMLElement && getComputedStyle(node).display === 'none' && 'display:none',
		].filter(Boolean);
		if (flags.length > 0) state.push(`${describe(node)} ${flags.join(' ')}`);
	}
	return state;
}

function describe(node: Node): string {
	if (!(node instanceof Element)) return node.nodeName.toLowerCase();
	const testId = node.getAttribute('data-testid');
	const role = node.getAttribute('role');
	return [node.tagName.toLowerCase(), testId && `[data-testid=${testId}]`, role && `[role=${role}]`]
		.filter(Boolean)
		.join('');
}
