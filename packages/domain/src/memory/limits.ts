/**
 * The bounds of the memory of an account and of its projects (docs/plan/84-projects.md, ПР18, §4.4).
 * Constants, not settings: the agent's tools, core and the cabinet read the same numbers.
 */
export const memoryLimits = Object.freeze({
  /** One entry, after trimming. */
  textChars: 400,
  /** Entries of one memory — a project's, or the account's — active and proposed together. */
  entries: 40,
  /** Active entries the section of a pass carries at most. */
  sectionEntries: 40,
  /** The characters of the entries the section carries at most. */
  sectionChars: 8000,
  /** Changes the agent may reserve in one turn. */
  changesPerTurn: 10,
})
