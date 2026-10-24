// The containers of the browser sessions of tasks on the local Docker daemon
// (docs/plan/57-browser-tasks.md, Б10, Б11): the `BrowserSessionRuntime` of the browser worker.
export {
  browserSessionDefaultLimits,
  browserSessionRuntimeLimits,
  dockerBrowserSessionConfigSchema,
  type DockerBrowserSessionConfig,
} from './config.ts'
export { BROWSER_LABEL } from './resources.ts'
export { createDockerBrowserSessionRuntime, localSiteRoute } from './runtime.ts'
