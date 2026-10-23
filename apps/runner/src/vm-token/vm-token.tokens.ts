/** The VM token, read once at start: the transport sends it to core. */
export const RUNNER_TOKEN = Symbol('RUNNER_TOKEN')
/** The runner id the VM token names: it labels this runner's turn containers. */
export const RUNNER_ID = Symbol('RUNNER_ID')
