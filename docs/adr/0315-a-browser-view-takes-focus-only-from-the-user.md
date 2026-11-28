# 0315 - A browser view takes focus only from the user

Status: accepted

## Context

The focus journal (0313) and its fixes (0314) cover focus that moves inside the renderer, but focus that leaves the renderer for a browser tab or a report's frame was still open.
`views.ts` showed a hidden `WebContentsView` for a moment to resize or capture it, gave focus back to Malini's window only after a pick, and had no guard on a view's `focus` event.
0300 kept a report frame's `focus()`, `select()` and `window.focus()` from the composer, and left `showModal()` and a popover's `autofocus` open; this record extends it to close what it left open.
In Electron 44, a probe saw `show()`, `showModal()`, `showPopover()` and `togglePopover()` each take focus from a frame that did not hold it, while a cross-origin `autofocus` attribute never took it.
Every remount of a report's frame in `ReportMedia.svelte`, such as a switch to another chat and back, loads the page again and runs those calls again.
The agent's browser tools click and type through CDP `Input.*` commands, which Electron reports as `input-event` like the user's own presses, but not as `before-input-event`.

## Decision

- `createElectronView` in `apps/malini/src/lib/browser/platform/electron-view.ts` passes each view's `focus`, `blur` and `mouseDown` `input-event` to `PageEvents` as `focused`, `blurred` and `pressed`.
- `devtools()` in `automation.ts` marks the page's contents while a CDP `Input.*` command is in flight, and `agentIsPressing(contents)` reads the mark; it lives only in the main process.
- In `views.ts`, a press while the agent is not pressing is the user's: it stamps `pressedAt`, and when the view shows in the focused window, it focuses the view.
- One task after a view takes focus, `keepFocusFromUser` lets it keep focus during a pick, or while it shows and the user pressed into it within `USER_FOCUS_MS` (300 ms) or still holds the focus they gave it.
- Otherwise `returnFocus` gives focus back to the window's renderer.
- A blur while the window keeps focus ends the user's hold, and a blur from leaving the app does not.
- `resize` and `rendered` call `returnFocus` in their `finally` when the view is hidden again.
- `returnFocus` acts only while Malini's window has focus, since `webContents.focus()` brings a background app to the front on macOS.
- `FOCUS_STAYS_WHERE_THE_USER_PUT_IT` in `worktree-files.ts` also wraps `HTMLDialogElement.prototype.show` and `showModal`, and `HTMLElement.prototype.showPopover` and `togglePopover`.
- While `document.hasFocus()` is false, each makes the element `inert` for the native call, so its focusing steps find nothing, and the dialog or popover opens without focus and without `inert`.
- The `autofocus` attribute needs nothing, because Chromium already blocks it in the cross-origin frame.

## Consequences

- A page in the browser tab that focuses itself on load or on a timer never takes keys from the composer, neither while the agent opens, resizes or captures it out of sight, nor once the user shows it.
- A click into a shown browser tab gives it focus and keys, as before.
- A user click in the same moment as an agent's CDP input counts as the agent's and gives no focus, until the next click.
- A view that takes focus while Malini's window is in the background keeps it, because taking focus back would bring Malini to the front.
- A report's prototype shows its modal dialog or popover unfocused until the user clicks into the page, and after that click or a Tab its calls focus as written.
- `views.test.ts`, "lets a page keep focus only after the user pressed into it while it shows, never after the page or the agent took it", fails when the guard, the agent's mark or the hidden check breaks.
- `browser-focus.spec.ts` has four tests, each typing in the composer while it runs: a hidden tab the agent opens, resizes and captures before the user shows it; a page that focuses itself on load and every 200 ms, then an agent reload; a click and keys that reach a shown page; and a report prototype with `showModal()`, a popover and `autofocus` fields that reloads after a chat switch away and back.
- Chromium logs `Blocked autofocusing on a <input> element in a cross-origin subframe.` as a console error each time it blocks one; the report prototype test allows that line, and no other test does.
- The e2e window is never key (0007), so no view `focus` event fires there.
  Those specs check the composer's focus and text, and that no page holds focus, and only the unit test checks the return of focus itself.
