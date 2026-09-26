import { createHash, timingSafeEqual } from 'node:crypto'

import { collectDefaultMetrics, Registry } from '@prometheus-io/client'

/**
 * One registry per app, default label app=orchestrator. Labels never carry task or user ids
 * (spec §19): billing comes from token_usage, not from Prometheus.
 */
export function createMetricsRegistry(): Registry {
  const registry = new Registry()
  registry.setDefaultLabels({ app: 'orchestrator' })
  collectDefaultMetrics({ register: registry })
  return registry
}

const BEARER = /^Bearer\s+(\S+)\s*$/i

const digest = (value: string) => createHash('sha256').update(value).digest()

/** Compares `Authorization: Bearer <token>` in constant time (hashes make lengths equal). */
export function bearerTokenMatches(authorization: string | undefined, expected: string): boolean {
  const token = authorization === undefined ? undefined : BEARER.exec(authorization)?.[1]
  if (token === undefined) return false
  return timingSafeEqual(digest(token), digest(expected))
}
