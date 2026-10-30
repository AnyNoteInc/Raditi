// A dialog the client has just started on «Новый диалог» (docs/plan/59-dialog-tools-panel.md, И3):
// its first showing knows that the client watched it from before its browser was there, so a
// browser launched before the first read of the dialog opens beside it too. Kept in the memory of
// this page alone — neither in the address nor in the storage of the browser: a reload of the
// dialog is no start of it.

/** How long the start of a dialog speaks for its first showing. */
export const NEW_DIALOG_MS = 60_000

let started: { taskId: string; at: number } | null = null

/** «Новый диалог» started this dialog: called before the screen moves to it. */
export function markNewDialog(taskId: string, at: number = Date.now()): void {
  started = { taskId, at }
}

/**
 * The client started this dialog here a moment ago. Read, not taken: React mounts a dialog twice
 * in Strict Mode, and the second mount reads the same answer.
 */
export function isNewDialog(taskId: string, now: number = Date.now()): boolean {
  return started !== null && started.taskId === taskId && now - started.at <= NEW_DIALOG_MS
}

/** The first answer of the dialog is in: whatever shows it next is no start of it. */
export function forgetNewDialog(taskId: string): void {
  if (started?.taskId === taskId) started = null
}
