/** SandboxProvider port of the runner's own Docker. */
export const SANDBOX_PROVIDER = Symbol('SANDBOX_PROVIDER')
/** TurnExecutor port: the LocalTurnExecutor over that Docker, which carries out core's commands. */
export const TURN_EXECUTOR = Symbol('TURN_EXECUTOR')
