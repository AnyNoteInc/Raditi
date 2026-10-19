import { describe, expect, it } from 'vitest'

import {
  previewAccessPath,
  previewBrowserSecretPath,
  previewBrowserSecretSchema,
  previewBrowserSocket,
} from './preview-secrets.ts'

const previewId = '0196abcd-0000-7000-8000-0000000000aa'
const ORIGIN = 'http://site-0a1b2c3d-chat-0a1b2c.localhost:8090'
const secret = {
  v: '1',
  requestId: '0196abcd-0000-7000-8000-0000000000bb',
  wsEndpoint: 'ws://127.0.0.1:41234',
  wsPath: `/${'a'.repeat(43)}`,
  enterUrl: `${ORIGIN}/__raditi/enter?t=${'T'.repeat(43)}&to=%2F`,
}

describe('secrets of a preview in Vault', () => {
  it('live under kv/previews/<previewId>/<kind>, apart from the site', () => {
    expect(previewAccessPath(previewId, 'wp')).toBe(`kv/previews/${previewId}/wp`)
    expect(previewBrowserSecretPath(previewId)).toBe(`kv/previews/${previewId}/browser`)
    for (const id of ['', '..', previewId.toUpperCase(), `${previewId}/x`, 'site-1'])
      expect(() => previewAccessPath(id, 'wp')).toThrow()
    expect(() => previewAccessPath(previewId, 'env' as never)).toThrow()
  })

  it('give the browser its control socket on loopback and a one-time entry of the gateway', () => {
    const parsed = previewBrowserSecretSchema.parse(secret)
    expect(previewBrowserSocket(parsed)).toBe(`ws://127.0.0.1:41234/${'a'.repeat(43)}`)
    for (const wrong of [
      { wsEndpoint: 'ws://10.0.0.5:41234' },
      { wsEndpoint: 'ws://127.0.0.1:41234/path' },
      { wsEndpoint: 'wss://127.0.0.1:41234' },
      { wsPath: '/short' },
      { wsPath: `/${'a'.repeat(43)}?x` },
      { enterUrl: `${ORIGIN}/wp-login.php` },
      { enterUrl: `${ORIGIN}/__raditi/enter?t=${'T'.repeat(43)}` },
      { enterUrl: `${ORIGIN}/__raditi/enter?t=short&to=%2F` },
      { enterUrl: `${ORIGIN}/__raditi/enter?t=${'T'.repeat(43)}&to=%2F%2Fevil.example` },
      { enterUrl: `ftp://site/__raditi/enter?t=${'T'.repeat(43)}&to=%2F` },
      { requestId: 'not-a-uuid' },
      { v: '2' },
    ])
      expect(
        previewBrowserSecretSchema.safeParse({ ...secret, ...wrong }).success,
        JSON.stringify(wrong),
      ).toBe(false)
    expect(previewBrowserSecretSchema.safeParse({ ...secret, extra: 'x' }).success).toBe(false)
  })
})
