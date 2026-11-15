/**
 * The bounds of the projects of a workspace (docs/plan/84-projects.md, ПР5, ПР7, ПР8, ПР20, ПР21).
 * Constants, not settings: the cabinet, the procedures, core and the agent's tools read the same
 * numbers. The number of projects itself is not bounded — the credits are (ПР21).
 */
export const projectLimits = Object.freeze({
  /** «Над чем вы работаете?», after trimming. */
  nameChars: 80,
  /** «Чего вы хотите достичь?», after trimming. */
  goalChars: 500,
  /** The instructions of the project (ПР7). */
  instructionsChars: 8000,
  /** The pieces looksLikeSecret() reads of long instructions (ПР7): its own limit. */
  secretCheckChars: 4000,
  /** The days a deleted project waits in the trash before it is purged (ПР20). */
  trashDays: 30,
  /** The list shows the search from this many projects on (ПР4: «больше 6»). */
  searchFrom: 7,
  /** One file of the context (ПР8). */
  fileBytes: 20 * 1024 * 1024,
  /** Files of one project. */
  filesPerProject: 100,
  /** The bytes of the files of one project. */
  projectBytes: 100 * 1024 * 1024,
  /** The bytes of the files of all the projects of a workspace. */
  workspaceBytes: 1024 * 1024 * 1024,
  /** «Добавить текстовое содержимое»: its characters. */
  textChars: 100_000,
})

/** When a project deleted at `at` is purged (ПР20). */
export const projectPurgeAfter = (at: Date): Date =>
  new Date(at.getTime() + projectLimits.trashDays * 24 * 60 * 60 * 1000)
