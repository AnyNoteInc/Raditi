// The runner engine as core's cross-app tests drive it (plan 56, decision 1): the real
// SandboxRunner and its HTTP transport behind core's RunnerHub, the only check in CI that both
// sides of the runner protocol work together. The one file of core that imports another app,
// and only engine files that speak the protocol — never a module or a token of the runner app
// (dependency-cruiser: apps-are-isolated, runner-side-reaches-the-engine-only). Only for tests.
export {
  HttpRunnerTransport,
  RunnerCallError,
  type RunnerCommandFence,
  type RunnerTransport,
} from '../../../runner/src/core-api/core-client.ts'
export {
  SandboxRunner,
  type SandboxRunnerDependencies,
} from '../../../runner/src/sandbox-runner/sandbox-runner.ts'
