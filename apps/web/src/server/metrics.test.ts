import { describe, expect, it } from 'vitest'

import { getMetricsRegistry, metricsResponse } from './metrics'

const TOKEN = 's3cret-token'
const registry = getMetricsRegistry()

const request = (authorization?: string) =>
  new Request('http://localhost:3000/api/metrics', {
    headers: authorization === undefined ? {} : { authorization },
  })

describe('metricsResponse', () => {
  it('answers 401 without the token', async () => {
    for (const authorization of [undefined, 'Bearer wrong', `Basic ${TOKEN}`]) {
      const res = await metricsResponse(request(authorization), { token: TOKEN, registry })
      expect(res.status).toBe(401)
      expect(await res.text()).not.toContain('process_')
    }
  })

  it('serves default metrics labelled app=web with the token', async () => {
    const res = await metricsResponse(request(`Bearer ${TOKEN}`), { token: TOKEN, registry })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    const text = await res.text()
    expect(text).toMatch(/^process_cpu_user_seconds_total\{app="web"\} /m)
    expect(text).not.toMatch(/task_id|user_id/)
  })

  it('keeps one registry per process', () => {
    expect(getMetricsRegistry()).toBe(registry)
  })
})
