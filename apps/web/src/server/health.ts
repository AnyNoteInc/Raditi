import type { BucketKind } from '@repo/domain'
import { bearerTokenMatches, type HealthCheck, type HealthProbe } from '@repo/observability'

/**
 * 200 when everything is ok, 503 otherwise, so load balancers and probes can act on it.
 * Anonymous callers get only `{ status }`; the per-dependency checks need
 * `Authorization: Bearer $METRICS_TOKEN`.
 */
export async function healthResponse(
  request: Request,
  options: { probe: HealthProbe; token: string | undefined },
): Promise<Response> {
  const report = await options.probe()
  const detailed =
    options.token !== undefined &&
    bearerTokenMatches(request.headers.get('authorization'), options.token)
  return Response.json(detailed ? report : { status: report.status }, {
    status: report.status === 'ok' ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  })
}

/** The part of an ioredis client the check needs. */
export interface RedisProbe {
  connect(): Promise<unknown>
  ping(): Promise<string>
  disconnect(): void
}

/** Opens its own short-lived connection and always closes it, whatever happens. */
export const redisCheck =
  (getUrl: () => string | undefined, connect: (url: string) => RedisProbe): HealthCheck =>
  async () => {
    const url = getUrl()
    if (!url) throw new Error('REDIS_URL is not set')
    const client = connect(url)
    try {
      await client.connect()
      return (await client.ping()) === 'PONG'
    } finally {
      client.disconnect()
    }
  }

/** The buckets web's own S3 key may access (spec §14): the health check looks at no others. */
export const WEB_BUCKETS = ['inbox', 'artifacts', 'logs'] as const satisfies readonly BucketKind[]
