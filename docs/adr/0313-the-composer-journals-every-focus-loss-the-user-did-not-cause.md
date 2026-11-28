# 0313 - The composer journals every focus loss the user did not cause

Status: accepted

## Context

Simon loses the composer's focus "multiple times a day", also "when I'm not doing anything", with no agent, browser tab or prototype in play.
Each earlier fix guarded one thief: #164 for background apps, #260 and 0300 for prototypes, #264 for menu hover, 795b5c0 for draft keys.
No code said who owns the composer's focus, nothing noticed a loss, and only a spec aimed at one exact thief failed on it.
A loss happens three ways: another element calls `focus()`, the editor turns unfocusable (`inert`, hidden, read-only, removed) and focus drops to `body`, or focus leaves the renderer.
The plan puts a journal first, so the e2e suite names the real thieves before any fix.

## Decision

- `guardComposerFocus` in `apps/malini/src/lib/shared/shell/composer-focus-guard.ts` is attached by `ChatSurface.svelte` to the composer's slot with `{@attach}`.
- It reads every `focusout` from the composer's editor, the `[contenteditable]` in the slot, to an element outside it.
- A loss is the user's when it happens in the task of a trusted `pointerdown`.
- A move to another element is also the user's when it happens in the task of a trusted `keydown`, within 300 ms of a trusted `pointerdown`, within 300 ms of a key that does not type into the editor (a modifier, Tab, Escape, or a key outside the editor), or onto or around the last element the pointer pressed.
- A command from the menu bar, through `boot-app.hook.ts`, and a press of the landing page demo's scripted cursor, in `demo-cursor.ts`, call `noteUserAction()`, which counts as such a key, since neither reaches the page as a trusted event.
- A frame under the pointer counts as clicked, since a press inside a frame never reaches Malini's window.
- A key never excuses a drop to `body`.
- One task later the loss is dropped when focus is back in the editor, when the editor still holds `document.activeElement` because only the window lost focus, or when the chat surface is gone.
- Any other loss calls `console.error` with a `ComposerFocusLost` error whose stack is taken inside the `focusout` handler, so a `focus()` call names its caller.
- Its message is `composer-focus-lost` and JSON with `cause`, `to` (tag, `data-testid` and `role`, or `body`), `windowFocused`, the editor's `contenteditable` and `tabindex` and every ancestor that is `inert`, `hidden` or `display: none`, and the last change on the editor's ancestors.
- A `MutationObserver` on each ancestor of the focused editor records changes to `inert`, `hidden`, `class`, `style`, `contenteditable` and `tabindex`, and the editor's removal; a removal with no `focusout` counts as a loss too.
- `cause` is one of `USAGE_STEPS.composer_focus_lost` in `src/contract/system.ts`: `moved_to_field`, `moved_to_control`, `moved_to_dialog`, `moved_to_frame`, `dropped_inert`, `dropped_hidden`, `dropped_read_only`, `dropped_removed` or `dropped`.
- The guard sends `cause` alone through `app.count-usage-step`, the 0255 path, and `usage-data.ts` logs `composer focus lost: <cause>` as an error line once per cause, with later repeats on the next line and the cause as the kind 0272 counts by version.
- No label, text or route goes in the message, since the renderer error log feeds problem reports.

## Consequences

- Every e2e spec fails on a loss the user did not cause: `expectCleanConsole` reads the console, and the quit check in `tests/e2e/harness.ts` reads the renderer error log every `console.error` lands in.
- A spec that takes focus away on purpose names it with `launchMalini({ allowedDiagnostics: [/composer-focus-lost/u] })` and `withoutConsoleErrors`.
- A packaged build tells which ways the composer loses focus for real users, by version.
- Focus that leaves the renderer for a browser tab's `WebContentsView` or another app is not judged here, since the renderer cannot tell a user's switch from a theft; the main process has to guard browser views.
- A thief within 300 ms of a press or a shortcut, or a frame that takes focus under a resting pointer, passes as the user's; the `ponytail:` note in the guard names the frame case.
- `composer-focus.spec.ts`, "the focus journal names a loss the user did not cause, and only that", steals focus with a script and with `inert`, then clicks and presses Tab, and fails when the journal misses either loss or blames the user.
- `usage-data.test.ts`, "logs each way the composer loses focus once, with no content", fails when a cause is logged twice or carries more than its name.
