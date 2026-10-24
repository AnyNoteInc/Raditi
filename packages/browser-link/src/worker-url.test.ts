import { describe, expect, it } from 'vitest'

import { browserStreamUrl, browserWorkerOrigin } from './worker-url.ts'

const sessionId = '0196abcd-0000-7000-8000-000000000001'
const viewerId = '0196abcd-0000-7000-8000-000000000005'
const userId = '0196abcd-0000-7000-8000-000000000006'

describe('the address of the browser worker', () => {
  it('takes an http or https origin, with or without a trailing slash', () => {
    expect(browserWorkerOrigin('http://127.0.0.1:8086')).toBe('http://127.0.0.1:8086')
    expect(browserWorkerOrigin('http://browser:8086/')).toBe('http://browser:8086')
    expect(browserWorkerOrigin('https://browser.raditi.internal')).toBe(
      'https://browser.raditi.internal',
    )
  })

  it('refuses anything else without echoing the setting', () => {
    for (const [baseUrl, said] of [
      ['browser:8086', 'must be http or https'],
      ['not a url', 'is not a URL'],
      ['ws://browser:8086', 'must be http or https'],
      ['http://admin:hunter2@browser:8086', 'must not carry credentials'],
      ['http://browser:8086/v1', 'must be an origin without a path'],
      ['http://browser:8086/?token=hunter2', 'must be an origin without a path'],
      ['http://browser:8086/#hunter2', 'must be an origin without a path'],
    ] as const) {
      expect(() => browserWorkerOrigin(baseUrl)).toThrow(said)
      try {
        browserWorkerOrigin(baseUrl)
      } catch (error) {
        expect(String(error)).not.toContain('hunter2')
        expect(String(error)).not.toContain('browser:8086')
      }
    }
  })
})

describe('the internal address of a stream', () => {
  it('names the session, the viewer and the user, over ws for http and wss for https', () => {
    expect(browserStreamUrl('http://127.0.0.1:8086', { sessionId, viewerId, userId })).toBe(
      `ws://127.0.0.1:8086/v1/sessions/${sessionId}/stream?viewer=${viewerId}&user=${userId}`,
    )
    expect(browserStreamUrl('https://browser.internal/', { sessionId, viewerId, userId })).toBe(
      `wss://browser.internal/v1/sessions/${sessionId}/stream?viewer=${viewerId}&user=${userId}`,
    )
  })

  it('lets nothing but UUIDs into the path and the query', () => {
    const base = 'http://127.0.0.1:8086'
    expect(() => browserStreamUrl(base, { sessionId: '../ensure', viewerId, userId })).toThrow(
      'session id is not a UUID',
    )
    expect(() =>
      browserStreamUrl(base, { sessionId, viewerId: `${viewerId}&user=x`, userId }),
    ).toThrow('must be UUIDs')
    expect(() => browserStreamUrl(base, { sessionId, viewerId, userId: '' })).toThrow(
      'must be UUIDs',
    )
    expect(() =>
      browserStreamUrl('http://127.0.0.1:8086/x', { sessionId, viewerId, userId }),
    ).toThrow('without a path')
  })
})
