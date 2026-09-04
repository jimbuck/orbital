/**
 * Fire-and-forget bridge call: run it, and if it rejects, don't let the
 * rejection escape as an *unhandled* one.
 *
 * Main's IPC handler wrapper already logs every rejection to the app log
 * (`ipc <channel> failed`), so nothing is lost by swallowing it here — what
 * this stops is the renderer turning a failed OS hand-off (Open in Explorer on
 * a checkout that has been deleted, say) into an "Uncaught (in promise)" in
 * the devtools console with no code path that ever meant to handle it. The
 * `console.warn` keeps it visible in dev without inventing a notification
 * channel the app does not have.
 *
 * Use it for clicks whose failure has nowhere sensible to land in the UI. A
 * call whose failure the user should SEE (the file context menu's operations,
 * a save) belongs in a `run()` with an error line, not here.
 */
export function fireAndForget(call: Promise<unknown>): void {
  call.catch((err: unknown) => {
    console.warn('bridge call failed', err)
  })
}
