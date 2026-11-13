/**
 * The bounds of the pages and documents of a workspace (docs/plan/69-pages.md, Ст24). Constants,
 * not settings: the agent's tools, core, the page server and the cabinet read the same numbers.
 */
export const pageLimits = Object.freeze({
  /** The bytes of one version of a page, as served. */
  contentBytes: 2 * 1024 * 1024,
  /** Pages of a workspace, published or taken down; documents not yet published are not pages. */
  pagesPerWorkspace: 200,
  /** Publications (a new page or a new version) of a workspace in an hour. */
  publishesPerHour: 30,
  /** Documents of a workspace. */
  docsPerWorkspace: 500,
  /** Sections of one document. */
  docSections: 40,
  /** One section's Markdown, UTF-8: well under the MCP body limit of 100 KiB with JSON around it. */
  sectionBytes: 32 * 1024,
  /** A whole document as assembled. */
  docBytes: 512 * 1024,
  /** Section writes (write, remove, move) of one turn. */
  sectionWritesPerTurn: 120,
  /** Characters of a title, a heading or an intent: one line each. */
  titleChars: 200,
  /** A password of a page. */
  passwordMinChars: 4,
  passwordMaxChars: 128,
  /** The body of the password form, bytes. */
  passwordFormBytes: 1024,
  /** Wrong passwords: per page and address in 15 minutes, and per page in an hour. */
  passwordAttemptsPerAddress: 10,
  passwordAttemptsPerAddressWindowSeconds: 15 * 60,
  passwordAttemptsPerPage: 100,
  passwordAttemptsPerPageWindowSeconds: 60 * 60,
  /** How long the cookie of a right password lets the viewer in. */
  passwordCookieSeconds: 12 * 60 * 60,
})
