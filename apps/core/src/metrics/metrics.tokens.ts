/** Prometheus registry served by GET /metrics. */
export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY')
/** The bearer token of GET /metrics (and of the details of GET /health). */
export const METRICS_TOKEN = Symbol('METRICS_TOKEN')
