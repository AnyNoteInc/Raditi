/**
 * The bounds of the skills of an account (docs/plan/97-skills.md, Нв3). Constants, not settings:
 * the cabinet, the procedures, core, the runner and the agent's tools read the same numbers.
 */
export const accountSkillLimits = Object.freeze({
  /** `name` of the open standard (agentskills.io): `[a-z0-9-]`, 1–64. */
  nameChars: 64,
  /** `description` of the open standard. */
  descriptionChars: 1024,
  /** `compatibility` of the open standard. */
  compatibilityChars: 500,
  /** `license`, as kept. */
  licenseChars: 128,
  /** The Russian title and summary of a skill of the catalog of Радити (`metadata.raditi-*`). */
  titleChars: 80,
  summaryChars: 300,
  /** Skills one account has installed, built-in ones it turned on counted. */
  installed: 50,
  /** Skills of one account a turn gets: every description costs tokens in every request. */
  enabled: 20,
  /** Files of one version of a skill. */
  filesPerSkill: 100,
  /** One file of a skill. */
  fileBytes: 5 * 1024 * 1024,
  /** All the files of one version of a skill. */
  skillBytes: 10 * 1024 * 1024,
  /** `SKILL.md` itself: the text the model loads. */
  skillMdBytes: 256 * 1024,
  /** A path inside a skill, in characters and in parts (the file's own name among them). */
  pathChars: 255,
  pathParts: 10,
  /** How deep a repository is searched for `SKILL.md` (Codex: MAX_SCAN_DEPTH). */
  scanDepth: 6,
  /** Marketplaces one account added, besides the platform's. */
  marketplaces: 10,
  /** Plugins of one marketplace read. */
  marketplacePlugins: 500,
  /** `marketplace.json` itself. */
  marketplaceBytes: 1024 * 1024,
  /** An archive the client uploads (`.zip`, `.skill`). */
  uploadBytes: 10 * 1024 * 1024,
  /** Versions of one skill kept for «Вернуть прошлую». */
  versionsKept: 5,
  /** What `skill_save` takes in one call: the text of the files, base64 of a binary one included. */
  proposalBytes: 2 * 1024 * 1024,
  /** Proposals of the agent waiting for the client at once, per account. */
  proposalsPending: 10,
})

/**
 * What one turn gets of the skills of its account: all the enabled ones. 20 skills of 100 files
 * and 10 MiB would be 2000 files and 200 MiB — more than a turn takes, so the turn has its own
 * bounds, and the enabling refuses a skill that would cross them.
 */
export const turnSkillFilesLimits = Object.freeze({
  files: 600,
  bytes: 64 * 1024 * 1024,
})
