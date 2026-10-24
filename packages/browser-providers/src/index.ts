// The agent's browser on a preview (docs/plan/53-chat-preview-release.md, Р21): adapters of the
// PageBrowser port of @repo/domain. Playwright over the remote browser server of a preview,
// reached on its loopback control port; every page request goes to the preview's origin only.
export { createPlaywrightBrowserFactory, type PlaywrightBrowserOptions } from './playwright.ts'
// The cloud browser of a task (docs/plan/57-browser-tasks.md, Б10–Б22): the CloudBrowserFactory
// port for the browser worker — one context per task, tabs, screencast, the client's input and
// the agent's actions on references of the page's tree, the stack's policy on every request.
export {
  createPlaywrightCloudBrowser,
  type PlaywrightCloudBrowserOptions,
} from './cloud/cloud-browser.ts'
