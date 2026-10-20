import { describe, expect, it } from 'vitest'

import {
  createReleaseApi,
  presignedTransfer,
  ReleaseApiError,
  releaseApiOrigin,
  transferTimeoutMs,
  waitForReleaseApi,
} from './release-api.ts'

const releaseId = '0196abcd-0000-7000-8000-00000000000a'
const token = 'T'.repeat(43)

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** A release API that answers from a script, one answer per request. */
function scripted(answers: Array<Response | Error>) {
  const sent: Sent[] = []
  const send: typeof fetch = async (input, init) => {
    sent.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries(init?.headers ?? {})),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    })
    const answer = answers.shift()
    if (!answer) throw new Error('no answer scripted')
    if (answer instanceof Error) throw answer
    return answer
  }
  return { sent, send }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function api(answers: Array<Response | Error>) {
  const script = scripted(answers)
  const waits: number[] = []
  const client = createReleaseApi({
    baseUrl: 'http://core.internal:8085',
    releaseId,
    deployAttempt: 2,
    token,
    fetch: script.send,
    backoffMs: [10, 20],
    sleep: async (ms) => {
      waits.push(ms)
    },
  })
  return { client, ...script, waits }
}

describe('the client of the release API (Р32)', () => {
  it('sends one report with its key and the token of the attempt', async () => {
    const t = api([json(200, { accepted: true, proceed: true })])
    expect(await t.client.report('files', 'started')).toEqual({ accepted: true, proceed: true })
    expect(t.sent).toEqual([
      {
        url: `http://core.internal:8085/v1/releases/${releaseId}/steps`,
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: {
          reportKey: '2:files:started',
          deployAttempt: 2,
          step: 'files',
          state: 'started',
          detail: {},
        },
      },
    ])
  })

  it('repeats a report without an answer with the same key: core keeps it once', async () => {
    const t = api([
      new Error('ECONNRESET'),
      json(503, { error: 'UNAVAILABLE' }),
      json(200, { accepted: true, proceed: false }),
    ])
    expect(await t.client.report('verify', 'failed', { code: 'site_broken' })).toEqual({
      accepted: true,
      proceed: false,
    })
    expect(t.sent).toHaveLength(3)
    expect(new Set(t.sent.map((request) => JSON.stringify(request.body))).size).toBe(1)
    expect(t.waits).toEqual([10, 20])
  })

  it('gives up after its retries and takes a refusal as final', async () => {
    const lost = api([new Error('a'), new Error('b'), new Error('c')])
    await expect(lost.client.report('files', 'started')).rejects.toEqual(new ReleaseApiError(null))
    expect(lost.sent).toHaveLength(3)

    for (const status of [400, 401, 409]) {
      const refused = api([json(status, { error: 'CONFLICT' })])
      const error = await refused.client.access().catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ReleaseApiError)
      expect((error as ReleaseApiError).status).toBe(status)
      expect(refused.sent).toHaveLength(1)
    }
  })

  it('waits longer for the manifest: the wrapping is spent already, a restart of core must not cost the attempt', async () => {
    const script = scripted([new Error('a'), new Error('b'), new Error('c'), new Error('d')])
    const waits: number[] = []
    const client = createReleaseApi({
      baseUrl: 'http://core.internal:8085',
      releaseId,
      deployAttempt: 2,
      token,
      fetch: script.send,
      backoffMs: [10],
      manifestBackoffMs: [100, 200, 300],
      sleep: async (ms) => void waits.push(ms),
    })
    await expect(client.manifest()).rejects.toEqual(new ReleaseApiError(null))
    expect(waits).toEqual([100, 200, 300])
    // The default waits through more than two minutes of a core that does not answer.
    const defaults = createReleaseApi({
      baseUrl: 'http://core.internal:8085',
      releaseId,
      deployAttempt: 2,
      token,
      fetch: scripted(Array.from({ length: 20 }, () => new Error('down'))).send,
      sleep: async (ms) => void waits.push(ms),
    })
    waits.length = 0
    await expect(defaults.manifest()).rejects.toBeInstanceOf(ReleaseApiError)
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThan(120_000)
  })

  it('takes an answer of another shape as a fault of core, and never shows what it said', async () => {
    const t = api([json(200, { accepted: 'yes', secret: 'password-of-the-hosting' })])
    const error = (await t.client
      .report('files', 'started')
      .catch((caught: unknown) => caught)) as Error
    expect(error).toBeInstanceOf(ReleaseApiError)
    expect(error.message).not.toContain('password')
  })

  it('asks where to upload the backup and whether core verified it', async () => {
    const t = api([
      json(200, {
        phase: 'put',
        put: {
          method: 'PUT',
          url: 'https://s3.example.test/raditi-backups/x',
          headers: { 'content-length': '10' },
          expiresAt: '2026-10-17T21:00:00.000Z',
        },
      }),
      json(200, { phase: 'verify', verified: true }),
    ])
    const facts = { sha256: 'e'.repeat(64), sizeBytes: 10 }
    expect((await t.client.backupPut(facts)).method).toBe('PUT')
    expect(await t.client.backupVerify(facts)).toBe(true)
    expect(t.sent.map((request) => request.body)).toEqual([
      { phase: 'put', deployAttempt: 2, ...facts },
      { phase: 'verify', deployAttempt: 2, ...facts },
    ])
  })

  it('reaches only an origin given by the runner', () => {
    expect(releaseApiOrigin('http://10.0.0.5:8085')).toBe('http://10.0.0.5:8085')
    expect(releaseApiOrigin('http://10.0.0.5:8085/')).toBe('http://10.0.0.5:8085')
    for (const value of [
      'http://user:pass@core:8085',
      'http://core:8085/v1',
      'http://core:8085?x=1',
      'file:///etc/passwd',
    ])
      expect(() => releaseApiOrigin(value), value).toThrow()
  })
})

describe('the health of the release API before the wrapping is spent', () => {
  it('asks /health without a token until it answers, within its wait', async () => {
    let now = 0
    const script = scripted([
      new Error('ECONNREFUSED'),
      new Response('', { status: 503 }),
      new Response('{"status":"ok"}', { status: 200 }),
    ])
    const waited = await waitForReleaseApi('http://core.internal:8085', {
      fetch: script.send,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      pauseMs: 10_000,
    })
    expect(waited).toBe(true)
    expect(script.sent.map((request) => request.url)).toEqual(
      Array.from({ length: 3 }, () => 'http://core.internal:8085/health'),
    )
    expect(script.sent.every((request) => !('authorization' in request.headers))).toBe(true)
    expect(now).toBe(20_000)

    let later = 0
    const down = scripted(Array.from({ length: 100 }, () => new Error('down')))
    expect(
      await waitForReleaseApi('http://core.internal:8085', {
        fetch: down.send,
        now: () => later,
        sleep: async (ms) => {
          later += ms
        },
        waitMs: 60_000,
        pauseMs: 10_000,
      }),
    ).toBe(false)
    expect(down.sent).toHaveLength(7)
  })
})

describe('a presigned transfer', () => {
  it('may take a minute plus a second per megabyte', () => {
    expect(transferTimeoutMs(0)).toBe(60_000)
    expect(transferTimeoutMs(1_000_000)).toBe(61_000)
    // The largest backup: about ten minutes, never the two of a fixed bound.
    expect(transferTimeoutMs(512 * 1024 * 1024)).toBeGreaterThan(9 * 60_000)
  })

  const put = {
    method: 'PUT' as const,
    url: 'https://s3.example.test/raditi-backups/x',
    headers: { 'x-amz-meta-attempt': '2' },
    expiresAt: '2026-10-17T21:00:00.000Z',
  }

  it('sends the body with the signed headers and reads a bounded answer', async () => {
    const script = scripted([new Response('', { status: 200 })])
    await presignedTransfer(put, { body: Buffer.from('sealed'), maxBytes: 16, fetch: script.send })
    expect(script.sent[0]?.method).toBe('PUT')
    expect(script.sent[0]?.headers).toEqual({ 'x-amz-meta-attempt': '2' })

    const large = scripted([new Response('x'.repeat(100), { status: 200 })])
    await expect(
      presignedTransfer({ ...put, method: 'GET' }, { maxBytes: 10, fetch: large.send }),
    ).rejects.toBeInstanceOf(ReleaseApiError)
  })

  it('refuses a body for a GET, none for a PUT, and an answer that is not 2xx', async () => {
    const script = scripted([new Response('denied', { status: 403 })])
    await expect(presignedTransfer(put, { maxBytes: 10, fetch: script.send })).rejects.toThrow()
    await expect(
      presignedTransfer({ ...put, method: 'GET' }, { body: Buffer.from('x'), maxBytes: 10 }),
    ).rejects.toThrow()
    await expect(
      presignedTransfer(put, { body: Buffer.from('x'), maxBytes: 10, fetch: script.send }),
    ).rejects.toEqual(new ReleaseApiError(403))
  })
})
