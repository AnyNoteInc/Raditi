import { collectDefaultMetrics, Registry } from '@prometheus-io/client'

import { bearerTokenMatches } from './bearer-token'

/**
 * One registry per process, default label app=web. Labels never carry task or user ids
 * (spec §19): billing comes from token_usage, not from Prometheus.
 */
export function createMetricsRegistry(): Registry {
  const registry = new Registry()
  registry.setDefaultLabels({ app: 'web' })
  collectDefaultMetrics({ register: registry })
  return registry
}

// Survives module reloads in dev (HMR): default collectors must be registered only once.
const globalForMetrics = globalThis as typeof globalThis & { __raditiWebMetrics?: Registry }

export function getMetricsRegistry(): Registry {
  globalForMetrics.__raditiWebMetrics ??= createMetricsRegistry()
  return globalForMetrics.__raditiWebMetrics
}

/** Prometheus text for a request carrying the right token; 401 with no details otherwise. */
export async function metricsResponse(
  request: Request,
  options: { token: string; registry: Registry },
): Promise<Response> {
  if (!bearerTokenMatches(request.headers.get('authorization'), options.token)) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'www-authenticate': 'Bearer', 'cache-control': 'no-store' },
    })
  }
  return new Response(await options.registry.metrics(), {
    headers: {
      'content-type': Registry.PROMETHEUS_CONTENT_TYPE,
      'cache-control': 'no-store',
    },
  })
}
