import { expect, test } from '@playwright/test'

// METRICS_TOKEN of the server under test; the fallback is the one in .env.example.
const METRICS_TOKEN = process.env.METRICS_TOKEN ?? 'raditi-dev-metrics'

test('home page renders', async ({ request }) => {
  const res = await request.get('/')
  expect(res.status()).toBe(200)
  const html = await res.text()
  expect(html).toContain('Радити')
  expect(html).toContain('можно отменить в течение 7 дней')
})

test('legal documents are published', async ({ request }) => {
  const res = await request.get('/terms/user-agreement')
  expect(res.status()).toBe(200)
  expect(await res.text()).toContain('Пользовательское соглашение')
})

test('health tells anonymous callers the status only', async ({ request }) => {
  const res = await request.get('/api/health')
  expect(await res.json()).toEqual({ status: 'ok' })
  expect(res.status()).toBe(200)
})

test('health sees the database, Redis, S3 and Vault with the metrics token', async ({
  request,
}) => {
  const res = await request.get('/api/health', {
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  })
  const body = await res.json()
  expect(body.checks).toEqual({ database: 'ok', redis: 'ok', s3: 'ok', vault: 'ok' })
  expect(body.status).toBe('ok')
  expect(res.status()).toBe(200)
})

test('orchestrator core starts and sees its dependencies', async ({ request }) => {
  const url = 'http://127.0.0.1:8181/health'
  const publicResponse = await request.get(url)
  expect(publicResponse.status()).toBe(200)
  expect(await publicResponse.json()).toEqual({ status: 'ok' })

  const detailedResponse = await request.get(url, {
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  })
  expect(detailedResponse.status()).toBe(200)
  expect(await detailedResponse.json()).toEqual({
    status: 'ok',
    checks: { database: 'ok', redis: 'ok', s3: 'ok', vault: 'ok' },
  })
})

test('orchestrator MCP starts and reports healthy without exposing details', async ({
  request,
}) => {
  const res = await request.get('http://127.0.0.1:8182/health')
  expect(res.status()).toBe(200)
  expect(await res.json()).toEqual({ status: 'ok' })
})
