# 0314 - The composer owns its focus

Status: accepted

## Context

The 0313 journal ran the full e2e suite and named four thieves.
`ComposerShell` turned `inert` whenever `presentationPending` flickered, with no refocus once it settled (16 specs).
An open document made the footer `inert`, and nothing refocused the composer once it closed (3 specs).
A question panel took focus on arrival, and a request queue hid the composer's slot, while the user typed (7 specs).
About 60 `focus()` calls in `src/lib` and `packages/hyper-ui` could move focus with no user action, and nothing told them apart from calls that follow a click or a key.
The brief left two decisions to review: a question or secret card never takes focus from a draft, and a pending presentation keeps the editor editable and only holds send.

## Decision

- A pending presentation never disables the editor.
  `ChatSurface.svelte` passes `sendHeld={presentationPending}` to `ChatComposer`, which keeps the editor editable and holds send; an Enter pressed while held sends once the presentation lands, in the same draft scope, and shows the submit button busy until then.
  A session switch passes `readOnly={sessionSwitching}`: the editor keeps focus and drops keys, so none land in the chat being left.
  Only `bootError` still disables the composer, and only then does `ComposerShell` turn `inert`.
- `InlinePromptEditor.svelte` owns the editor's `tabindex`, `-1` while read-only, so Chromium keeps focus on it when `contenteditable` turns `false`.
  TipTap's core `tabindex` extension, which drops the attribute from a read-only editor, is off (`enableCoreExtensions: { tabindex: false }`).
  The editor remembers that it held focus when it turns read-only, and takes focus back with `claimFocus` once it is editable again.
  A draft the editor loads, at mount or from a new value, puts the caret at its end, unless the user placed it elsewhere in the focused editor, so a draft restored after a restart takes keys after its text.
- The 0313 guard heals.
  After it reports a loss, one task later, it focuses the composer again when the window has focus, no overlay is open, nothing else claims focus, and the editor is visible and not `inert`.
  `guardComposerFocus` takes a `ComposerFocusOwner` with `workstreamId`, `focus`, `away` and `composing`; a loss while the composer is away on purpose (covered by a document, hidden by a question panel or a request queue, or a boot error) passes when the draft is empty, or when the user pressed a key or the pointer up to `USER_REPLACES_MS` (one second) before it.
  That second covers a document a click opens one IPC round trip later.
- Nothing replaces a draft the user is writing.
  A question or an automation step request that arrives while the draft has text is held behind a row in the composer tray, `RequestsWaiting kind="questions"`, `data-testid="questions-waiting"`, until the user presses **Answer**.
  Only arrivals count: the requests a chat already holds when it comes on screen show as before, since `ChatSurface` seeds what it has seen per workstream and chat.
  A file the agent opens while the draft has text opens in the background: `userIsComposingIn(workstreamId)` in the guard module adds `background: true` to the open, `ExtensionPanelOpenOptions` in `packages/extension-api` carries it, and `openWorkstreamDocument` in `workstream-tabs.ts` adds the tab without moving `activeDocumentId`.
  A secret request card takes focus only when nothing claims it, through `claimFocus` with `SecretRequestForm`'s `mayTakeFocus`; it never takes focus from the composer.
- When a question panel hands the slot back, `ChatSurface` returns focus to the composer with `claimFocus` when nothing claims it.
  When a document closes, it returns focus only when focus fell to `body`, so a chat tab the user picked with the keyboard keeps focus for the arrow keys, and typing after a click on it still reaches the draft through type-to-compose.
  Overlays opened from the composer already return to it through `setOverlayFocusReturn`, which `Modal`, `Sheet`, `FullPageModal` and `DropdownLayer` read.
- Enter, Backspace, Delete and the left and right arrows go to the composer when focus sits on `body`, on the element the pointer last pressed, or on a control that focus reached by script rather than by a key.
  Focus a keyboard user moved with Tab keeps its keys.
- Programmatic focus has two doors in `packages/hyper-ui/src/overlay/focus.ts`, re-exported by `src/lib/shared/shell/unclaimed-focus.ts`.
  `claimFocus(target, options, unclaimed = focusIsUnclaimed)` focuses only when the window has focus and no field, control inside a dialog, or editable holds it.
  `focusFromUser(target, options)` marks focus that follows the user's click or key.
- The lint rule `@malini/desktop/no-unprompted-focus`, in `packages/eslint-plugin-hyper-ui/src/no-unprompted-focus.mjs`, reports a `.focus()` call inside `$effect`, `onMount`, `tick().then`, `setTimeout`, `queueMicrotask` or `requestAnimationFrame`, or inside an `async` function whose name does not start with `on`.
  It runs at `error` on the renderer and `src/lib`, without `platform/`, and on `packages/hyper-ui/src`.

## Consequences

- Typing never stops because a store flickered, a document opened, or a question arrived: the guard heals what slips past, and the journal still reports it, so a new thief fails e2e.
- A held question is easy to miss; the tray row is the only sign until the user answers or the draft is sent.
- A new `focus()` call outside a handler fails lint until it goes through `claimFocus` or `focusFromUser`; the rule does not follow helper calls, so a helper called from an effect can still pass unseen.
- Specs act like a user wherever a composer is on screen: Settings opens through the profile menu (`openSettingsSection` in `tests/e2e/harness.ts`), since a `#/settings` URL and a reload race the composer for focus, and focus moves by click or by key (`tabTo`), not by `locator.focus()`, `blur()` or `fill()`, which the journal reports and the draft keys rule treats as script focus.
- `composer-focus.spec.ts` types while each event happens: an agent run, a second chat tab, a document the agent opens, an inspector change, the model picker by keyboard, a toast, a question and a secret request, the window losing focus, and a restart with **Resume**; each fails when the composer loses focus or a key.
- `workstream-tabs.test.ts`, "opens a document in the background beside the chat, keeping the chat and the preview in front", fails when a background open moves the active tab.
- `tests/design-system-rules.test.mjs` in the lint plugin fails when the rule misses a flagged call or flags a handler.
