/** SandboxProvider port of the runner's own Docker. */
export const SANDBOX_PROVIDER = Symbol('SANDBOX_PROVIDER')
/** TurnExecutor port: the LocalTurnExecutor over that Docker, which carries out core's commands. */
export const TURN_EXECUTOR = Symbol('TURN_EXECUTOR')
/** The pool of warm containers (docs/plan/93), null when RUNNER_SANDBOX_WARM_MINUTES is 0. */
export const WARM_SANDBOXES = Symbol('WARM_SANDBOXES')
/** A fresh uuid per process start: the runner's session for core, shared by the poll and the pool. */
export const RUNNER_SESSION = Symbol('RUNNER_SESSION')
