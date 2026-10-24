/** The Prometheus registry of the process, served by GET /metrics. */
export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY')
/** METRICS_TOKEN: the bearer token of GET /metrics (and of the details of GET /health). */
export const METRICS_TOKEN = Symbol('METRICS_TOKEN')
