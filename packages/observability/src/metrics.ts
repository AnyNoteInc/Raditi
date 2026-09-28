import { createHash, timingSafeEqual } from 'node:crypto'

import { collectDefaultMetrics, Registry } from '@prometheus-io/client'
import { isProduction, type AppEnv } from '@repo/domain'

/**
 * One registry per app with the default label `app`. Labels never carry task or user ids
 * (spec §19): billing comes from token_usage, not from Prometheus.
 */
export function createMetricsRegistry(app: string): Registry {
  const registry = new Registry()
  registry.setDefaultLabels({ app })
  collectDefaultMetrics({ register: registry })
  return registry
}

const BEARER = /^Bearer\s+(\S+)\s*$/i

const digest = (value: string) => createHash('sha256').update(value).digest()

/** Compares `Authorization: Bearer <token>` in constant time (hashes make lengths equal). */
export function bearerTokenMatches(
  authorization: string | null | undefined,
  expected: string,
): boolean {
  const token = authorization ? BEARER.exec(authorization)?.[1] : undefined
  if (token === undefined) return false
  return timingSafeEqual(digest(token), digest(expected))
}

/** METRICS_TOKEN from .env.example: fine locally, refused in production. */
export const DEV_METRICS_TOKEN = 'raditi-dev-metrics'

/** Production METRICS_TOKEN: long enough that guessing it is hopeless (openssl rand -hex 32). */
export const MIN_METRICS_TOKEN_LENGTH = 32

/** Why METRICS_TOKEN is unacceptable in this environment, or undefined; never the value. */
export function metricsTokenProblem(token: string | undefined, appEnv: AppEnv): string | undefined {
  if (!isProduction(appEnv)) return undefined
  if (token === undefined || token === DEV_METRICS_TOKEN) {
    return 'set a unique token in production (the dev placeholder is refused)'
  }
  if (token.length < MIN_METRICS_TOKEN_LENGTH) {
    return `must be at least ${MIN_METRICS_TOKEN_LENGTH} characters in production`
  }
  return undefined
}
