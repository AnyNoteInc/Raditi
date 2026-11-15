// The cloud browser of a task (docs/plan/57-browser-tasks.md, Б10–Б22): the CloudBrowserFactory
// port for the browser worker — one context per task, tabs, screencast, the client's input and
// the agent's actions on references of the page's tree, the stack's policy on every request.
export {
  createPlaywrightCloudBrowser,
  type PlaywrightCloudBrowserOptions,
} from './cloud/cloud-browser.ts'
