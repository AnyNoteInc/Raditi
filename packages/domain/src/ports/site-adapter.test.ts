import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { PublishedContentGateway } from './published-content.ts'
import {
  poweredByOf,
  siteAccessKinds,
  siteAccessPath,
  type SiteContentAdapter,
  type SiteHttpTransport,
} from './site-adapter.ts'

const siteId = '0196abcd-0000-7000-8000-00000000000f'

describe('siteAccessPath', () => {
  it('names the one Vault path of a site access of each kind', () => {
    expect(siteAccessKinds).toEqual(['ssh', 'ftp', 'wp', 'browser', 'git', 'db'])
    for (const kind of siteAccessKinds)
      expect(siteAccessPath(siteId, kind)).toBe(`kv/sites/${siteId}/${kind}`)
  })

  it('refuses anything that could leave the prefix of the site', () => {
    for (const id of [
      '',
      'site',
      `${siteId}/../x`,
      `${siteId}/wp`,
      '../subs',
      siteId.toUpperCase(),
    ])
      expect(() => siteAccessPath(id, 'wp')).toThrow('Invalid site access reference')
    for (const kind of ['', 'sftp', 'database', 'mysql', 'subscription', 'wp/../ssh', 'WP'])
      expect(() => siteAccessPath(siteId, kind as never)).toThrow('Invalid site access reference')
  })
})

describe('SiteContentAdapter', () => {
  it('lets the caller parse the secret and hand the gateway its site, origin and transport', async () => {
    // Checked by the type checker: an application needs nothing of the CMS to compose a gateway.
    const accessSchema = z.strictObject({ origin: z.url(), key: z.string().min(1) })
    const seen: unknown[] = []
    const adapter: SiteContentAdapter<z.infer<typeof accessSchema>> = {
      stack: 'static',
      accessKind: 'browser',
      accessSchema,
      createGateway(connection) {
        seen.push(connection.siteId, connection.origin, connection.access.key)
        return {} as PublishedContentGateway
      },
    }
    const neutral: SiteContentAdapter = adapter
    const transport: SiteHttpTransport = async () => ({ status: 200, body: new Uint8Array() })
    const access = neutral.accessSchema.safeParse({ origin: 'https://site.example.test', key: 'k' })
    expect(access.success).toBe(true)
    if (!access.success) return
    neutral.createGateway({
      siteId,
      origin: 'https://site.example.test',
      access: access.data,
      transport,
      allowLoopbackHttp: false,
    })
    expect(seen).toEqual([siteId, 'https://site.example.test', 'k'])
    expect(neutral.accessSchema.safeParse({ origin: 'https://site.example.test' }).success).toBe(
      false,
    )
  })
})

describe('poweredByOf', () => {
  it('keeps a short line of printable ASCII as it is', () => {
    expect(poweredByOf('PHP/7.4.33')).toBe('PHP/7.4.33')
    expect(poweredByOf('P'.repeat(128))).toBe('P'.repeat(128))
  })

  it('keeps a header the site repeated, which the transports join with ", "', () => {
    expect(poweredByOf('PleskLin, PHP/7.4.33')).toBe('PleskLin, PHP/7.4.33')
  })

  it('gives nothing for a missing value, a list, a long or an unprintable value', () => {
    for (const value of [
      undefined,
      null,
      '',
      ['PHP/7.4.33'],
      ['PHP/7.4.33', 'PleskLin'],
      'P'.repeat(129),
      'PHP/7.4\t33',
      'PHP/7.4\n33',
      'PHP/7.4\u007f',
      'PHP/7.4 — сайт',
    ])
      expect(poweredByOf(value)).toBeUndefined()
  })
})
