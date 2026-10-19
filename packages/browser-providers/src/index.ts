// The agent's browser on a preview (docs/plan/53-chat-preview-release.md, Р21): adapters of the
// PageBrowser port of @repo/domain. Playwright over the remote browser server of a preview,
// reached on its loopback control port; every page request goes to the preview's origin only.
export { createPlaywrightBrowserFactory, type PlaywrightBrowserOptions } from './playwright.ts'
