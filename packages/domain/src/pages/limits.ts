/**
 * The bounds of the pages and documents of a workspace (docs/plan/69-pages.md, Ст24). Constants,
 * not settings: the agent's tools, core, the page server and the cabinet read the same numbers.
 */
export const pageLimits = Object.freeze({
  /** The bytes of one version of a page, as served. */
  contentBytes: 2 * 1024 * 1024,
  /**
   * Pages of a workspace, published or taken down; documents not yet published are not pages,
   * nor are pages in the trash (docs/plan/73-pages-sites.md, Дер29: 300 since 14.11.2026, was 200).
   */
  pagesPerWorkspace: 300,
  /** Live pages of one site, its home page with them (Дер29). */
  pagesPerTree: 100,
  /** Levels below the home page (Дер15): `/a/b/c/d/e/f/g/h` at most. */
  pageDepth: 8,
  /** Characters of a canonical path (Дер15). */
  pagePathChars: 512,
  /** The bytes of a site: its pages with its shared files (Дер29, Дер34). */
  treeBytes: 50 * 1024 * 1024,
  /** One shared file of a site (Дер34). */
  fileBytes: 5 * 1024 * 1024,
  /** Former paths a site keeps sending on to their pages (Дер19). */
  redirectsPerTree: 200,
  /** Sites of a workspace without a paid tariff (Дер36, the default of В14). */
  sitesWithoutTariff: 1,
  /** Days a deleted page waits in the trash before it is purged (docs/plan/73-pages-sites.md, Дер2). */
  trashDays: 30,
  /** Publications (a new page or a new version) of a workspace in an hour (Дер29: 120, was 30). */
  publishesPerHour: 120,
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
  /** Password attempts: per page and address in 15 minutes, and per page in an hour. */
  passwordAttemptsPerAddress: 10,
  passwordAttemptsPerAddressWindowSeconds: 15 * 60,
  passwordAttemptsPerPage: 100,
  passwordAttemptsPerPageWindowSeconds: 60 * 60,
  /** How long the cookie of a right password lets the viewer in. */
  passwordCookieSeconds: 12 * 60 * 60,
})
