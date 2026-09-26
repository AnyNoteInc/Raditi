import { env } from '@/env'
import { getMetricsRegistry, metricsResponse } from '@/server/metrics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Prometheus scrape endpoint: `Authorization: Bearer $METRICS_TOKEN`. */
export function GET(request: Request): Promise<Response> {
  return metricsResponse(request, {
    token: env.web().metricsToken,
    registry: getMetricsRegistry(),
  })
}
