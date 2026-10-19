import { createHash, randomUUID } from 'node:crypto'

import {
  publishedContentHashMaterial,
  type ContentWriteRequest,
  type SiteContentAdapter,
  type SiteHttpRequest,
  type SiteHttpTransport,
} from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  wordpressContentAccessSchema,
  wordpressContentAdapter,
  WordpressPublishedContentGateway,
} from './wordpress-content.ts'

const siteId = randomUUID()
const connection = {
  origin: 'http://127.0.0.1:8099',
  siteId,
  username: 'synthetic',
  applicationPassword: 'synthetic',
  allowLoopbackHttp: true,
}
const stateFields = {
  version: 1 as const,
  objectRef: 'page:42',
  kind: 'page' as const,
  title: 'Заголовок',
  content: '<p>Текст</p>',
  excerpt: '',
}
const state = {
  ...stateFields,
  stateHash: createHash('sha256').update(publishedContentHashMaterial(stateFields)).digest('hex'),
}
const write: ContentWriteRequest = {
  callId: randomUUID(),
  siteId,
  epoch: 7,
  requestHash: 'a'.repeat(64),
  objectRef: 'page:42',
  expectedStateHash: state.stateHash,
  deadlineAt: Date.now() + 10_000,
  ttlMs: 10_000,
  mode: 'edit',
  fields: { title: 'После' },
}
const proof = {
  version: 1,
  kind: 'committed',
  callId: write.callId,
  siteId,
  epoch: write.epoch,
  requestHash: write.requestHash,
  objectRef: write.objectRef,
  stateHash: 'b'.repeat(64),
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('bounded WordPress content gateway', () => {
  it.each([
    'http://remote.example.test',
    'https://user:pass@example.test',
    'https://example.test/path',
    'https://example.test/?target=other',
    'file:///tmp/site',
  ])('refuses unsafe origins: %s', (origin) => {
    expect(() => new WordpressPublishedContentGateway({ ...connection, origin })).toThrow(
      'Published content gateway is unavailable',
    )
  })

  it('uses a fixed route, trusted credentials and no redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(state))
    vi.stubGlobal('fetch', fetcher)
    expect(await new WordpressPublishedContentGateway(connection).read('page:42')).toEqual(state)
    const [url, options] = fetcher.mock.calls[0]!
    expect((url as URL).searchParams.get('rest_route')).toBe('/raditi/v1/content/42')
    expect(options).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      headers: { 'x-raditi-site': siteId },
    })
    expect(
      await new WordpressPublishedContentGateway(connection)
        .read('post:42')
        .catch((error: unknown) => error),
    ).toMatchObject({ code: 'CONTENT_GATEWAY_UNAVAILABLE' })
  })

  it.each(['user:42', 'post:0', 'page:42?context=edit', 'page:../42'])(
    'refuses other objects before HTTP: %s',
    async (objectRef) => {
      const fetcher = vi.fn()
      vi.stubGlobal('fetch', fetcher)
      await expect(
        new WordpressPublishedContentGateway(connection).read(objectRef),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it('requires a valid state hash and refuses redirects or oversized responses', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ...state, stateHash: 'c'.repeat(64) }))
      .mockResolvedValueOnce(
        new Response('', { status: 302, headers: { location: 'https://foreign.test' } }),
      )
      .mockResolvedValueOnce(new Response(`"${'x'.repeat(128 * 1024)}"`))
    vi.stubGlobal('fetch', fetcher)
    const gateway = new WordpressPublishedContentGateway(connection)
    for (let index = 0; index < 3; index++)
      await expect(gateway.read('page:42')).rejects.toMatchObject({
        code: 'CONTENT_GATEWAY_UNAVAILABLE',
      })
  })

  it('reads a full 32 KiB Cyrillic state that WordPress sends as \\uXXXX escapes', async () => {
    // 16 000 two-byte characters: 32 000 bytes of state, 96 000 bytes on the wire.
    const content = 'я'.repeat(16_000)
    const fields = { ...stateFields, content }
    const large = {
      ...fields,
      stateHash: createHash('sha256').update(publishedContentHashMaterial(fields)).digest('hex'),
    }
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThanOrEqual(32 * 1024)
    const wire = JSON.stringify(large).replace(
      /[\u0080-\uffff]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
    expect(Buffer.byteLength(wire)).toBeGreaterThan(64 * 1024)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(wire)))
    expect(await new WordpressPublishedContentGateway(connection).read('page:42')).toEqual(large)
  })

  it('tells an oversized or unavailable object from an unreachable site', async () => {
    const denied = (code: string, reason?: string) =>
      Response.json({ version: 1, kind: 'rejected', code, ...(reason ? { reason } : {}) })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(denied('invalid', 'size'))
        .mockResolvedValueOnce(denied('invalid'))
        .mockResolvedValueOnce(denied('unavailable'))
        .mockResolvedValueOnce(denied('invalid', 'unexpected')),
    )
    const gateway = new WordpressPublishedContentGateway(connection)
    await expect(gateway.read('page:42')).rejects.toMatchObject({
      code: 'CONTENT_TOO_LARGE',
      httpStatus: 413,
    })
    await expect(gateway.read('page:42')).rejects.toMatchObject({
      code: 'CONTENT_OBJECT_UNAVAILABLE',
      httpStatus: 404,
    })
    for (let index = 0; index < 2; index++)
      await expect(gateway.read('page:42')).rejects.toMatchObject({
        code: 'CONTENT_GATEWAY_UNAVAILABLE',
      })
  })

  it('keeps the reason of a refused write: markup, size or storage', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const gateway = new WordpressPublishedContentGateway(connection)
    for (const reason of ['markup', 'size', 'storage']) {
      const refusal = { version: 1, kind: 'rejected', code: 'invalid', reason }
      fetcher.mockResolvedValueOnce(Response.json(refusal))
      expect(await gateway.conditionalWrite(write)).toEqual(refusal)
    }
    // An unknown reason is not a proven rejection.
    fetcher.mockResolvedValueOnce(
      Response.json({ version: 1, kind: 'rejected', code: 'invalid', reason: 'unexpected' }),
    )
    await expect(gateway.conditionalWrite(write)).rejects.toMatchObject({
      code: 'CONTENT_GATEWAY_UNAVAILABLE',
    })
  })

  it('sends the time left it was given, not one measured on the clock of this process', async () => {
    // The deadline and what is left of it come from one clock, the journal's. This process
    // runs an hour ahead of it: a duration taken here would end every write before it starts.
    const journalNow = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(journalNow + 3_600_000)
    const ref = {
      callId: write.callId,
      siteId,
      epoch: write.epoch,
      requestHash: write.requestHash,
      objectRef: write.objectRef,
      deadlineAt: journalNow - 250,
    }
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(proof))
      .mockResolvedValueOnce(Response.json({ ...ref, version: 1, kind: 'not_committed' }))
      .mockResolvedValueOnce(Response.json({ version: 1, kind: 'forgotten', callId: ref.callId }))
    vi.stubGlobal('fetch', fetcher)
    const gateway = new WordpressPublishedContentGateway(connection)
    await gateway.conditionalWrite({ ...write, deadlineAt: journalNow + 12_345, ttlMs: 12_345 })
    await gateway.reconcileOperation({ ...ref, ttlMs: -250 })
    await gateway.forgetOperation({ ...ref, ttlMs: 0 })
    const bodies = fetcher.mock.calls.map(([, options]) => JSON.parse(options.body))
    expect(bodies[0]).toEqual({ ...write, deadlineAt: journalNow + 12_345, ttlMs: 12_345 })
    expect(bodies[1]).toEqual({ ...ref, ttlMs: -250 })
    expect(bodies[2]).toEqual({ ...ref, ttlMs: 0 })
  })

  it('refuses a request without a whole number of milliseconds left', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const gateway = new WordpressPublishedContentGateway(connection)
    const { ttlMs: _ttlMs, ...timeless } = write
    const ref = {
      callId: write.callId,
      siteId,
      epoch: write.epoch,
      requestHash: write.requestHash,
      objectRef: write.objectRef,
      deadlineAt: write.deadlineAt,
    }
    for (const ttlMs of [undefined, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
      const broken = { ttlMs } as unknown as { ttlMs: number }
      for (const call of [
        gateway.conditionalWrite({ ...timeless, ...broken }),
        gateway.reconcileOperation({ ...ref, ...broken }),
        gateway.forgetOperation({ ...ref, ...broken }),
      ])
        await expect(call).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('validates committed receipts, known rejections and operation evidence', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(proof))
        .mockResolvedValueOnce(Response.json({ version: 1, kind: 'rejected', code: 'conflict' }))
        .mockResolvedValueOnce(Response.json(proof))
        .mockResolvedValueOnce(Response.json(null)),
    )
    const gateway = new WordpressPublishedContentGateway(connection)
    expect(await gateway.conditionalWrite(write)).toEqual(proof)
    expect(await gateway.conditionalWrite(write)).toMatchObject({
      kind: 'rejected',
      code: 'conflict',
    })
    expect(await gateway.operation(write.callId)).toEqual(proof)
    expect(await gateway.operation(randomUUID())).toBeNull()
  })

  it('treats malformed or mismatched write receipts as ambiguous without retrying', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ...proof, requestHash: 'd'.repeat(64) }))
      .mockRejectedValueOnce(new Error('private connection detail'))
    vi.stubGlobal('fetch', fetcher)
    const gateway = new WordpressPublishedContentGateway(connection)
    await expect(gateway.conditionalWrite(write)).rejects.toMatchObject({
      code: 'CONTENT_GATEWAY_UNAVAILABLE',
    })
    await expect(gateway.conditionalWrite(write)).rejects.toMatchObject({
      message: 'Published content gateway is unavailable',
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('reconciles only matching, durable positive or negative evidence', async () => {
    const ref = {
      callId: write.callId,
      siteId,
      epoch: write.epoch,
      requestHash: write.requestHash,
      objectRef: write.objectRef,
      deadlineAt: write.deadlineAt,
    }
    const request = { ...ref, ttlMs: -1 }
    const negative = { ...ref, version: 1, kind: 'not_committed' }
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(proof))
      .mockResolvedValueOnce(Response.json(negative))
      .mockResolvedValueOnce(Response.json({ version: 1, kind: 'unknown' }))
    vi.stubGlobal('fetch', fetcher)
    const gateway = new WordpressPublishedContentGateway(connection)
    expect(await gateway.reconcileOperation(request)).toEqual(proof)
    expect(await gateway.reconcileOperation(request)).toEqual(negative)
    expect(await gateway.reconcileOperation(request)).toEqual({ version: 1, kind: 'unknown' })
    const [url, options] = fetcher.mock.calls[0]!
    expect((url as URL).searchParams.get('rest_route')).toBe(
      `/raditi/v1/operations/${ref.callId}/reconcile`,
    )
    expect(JSON.parse(options.body)).toEqual(request)
    for (const change of [
      { callId: randomUUID() },
      { siteId: randomUUID() },
      { epoch: 8 },
      { objectRef: 'post:42' },
      { requestHash: 'c'.repeat(64) },
      { deadlineAt: write.deadlineAt + 1 },
    ]) {
      fetcher.mockResolvedValueOnce(Response.json({ ...negative, ...change }))
      await expect(gateway.reconcileOperation(request)).rejects.toMatchObject({
        code: 'CONTENT_GATEWAY_UNAVAILABLE',
      })
    }
  })

  it('validates receipt retirement acknowledgements and does not send arbitrary input', async () => {
    const ref = {
      callId: write.callId,
      siteId,
      epoch: write.epoch,
      requestHash: write.requestHash,
      objectRef: write.objectRef,
      deadlineAt: write.deadlineAt,
      ttlMs: 0,
    }
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ version: 1, kind: 'forgotten', callId: ref.callId }))
      .mockResolvedValueOnce(Response.json({ version: 1, kind: 'forgotten', callId: randomUUID() }))
    vi.stubGlobal('fetch', fetcher)
    const gateway = new WordpressPublishedContentGateway(connection)
    await expect(gateway.forgetOperation(ref)).resolves.toBeUndefined()
    await expect(gateway.forgetOperation(ref)).rejects.toMatchObject({
      code: 'CONTENT_GATEWAY_UNAVAILABLE',
    })
    await expect(gateway.forgetOperation({ ...ref, siteId: randomUUID() })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('the transport of the WordPress content gateway', () => {
  const json = (value: unknown) => ({ status: 200, body: Buffer.from(JSON.stringify(value)) })

  it('sends every request through the injected transport and never through global fetch', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const requests: SiteHttpRequest[] = []
    const transport: SiteHttpTransport = async (request) => {
      requests.push(request)
      return json(request.method === 'GET' ? state : proof)
    }
    const gateway = new WordpressPublishedContentGateway(connection, transport)
    expect(await gateway.read('page:42')).toEqual(state)
    expect(await gateway.conditionalWrite(write)).toEqual(proof)
    expect(fetcher).not.toHaveBeenCalled()
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['GET', 'http://127.0.0.1:8099/?rest_route=%2Fraditi%2Fv1%2Fcontent%2F42'],
      ['POST', 'http://127.0.0.1:8099/?rest_route=%2Fraditi%2Fv1%2Fcontent%2F42'],
    ])
    for (const request of requests) {
      // The limits are the adapter's: the transport only enforces them.
      expect(request).toMatchObject({ timeoutMs: 10_000, maxResponseBytes: 128 * 1024 })
      expect(request.headers).toEqual({
        authorization: `Basic ${Buffer.from('synthetic:synthetic').toString('base64')}`,
        'content-type': 'application/json',
        'x-raditi-site': siteId,
      })
    }
    expect(requests[0]!.body).toBeUndefined()
    expect(JSON.parse(requests[1]!.body!)).toEqual(write)
  })

  it('trusts no transport with its limits, statuses or failures', async () => {
    const outcomes: Array<() => ReturnType<SiteHttpTransport>> = [
      async () => ({ status: 302, body: Buffer.from(JSON.stringify(state)) }),
      async () => ({ status: 200, body: Buffer.alloc(128 * 1024 + 1, 0x20) }),
      async () => ({ status: 200, body: new Uint8Array() }),
      async () => {
        throw new Error('private connection detail of the site')
      },
    ]
    for (const outcome of outcomes)
      await expect(
        new WordpressPublishedContentGateway(connection, outcome).read('page:42'),
      ).rejects.toMatchObject({
        code: 'CONTENT_GATEWAY_UNAVAILABLE',
        message: 'Published content gateway is unavailable',
      })
  })
})

describe('the code cache of the site through the plugin (R12)', () => {
  const json = (value: unknown) => ({ status: 200, body: Buffer.from(JSON.stringify(value)) })
  const cache = {
    version: 1,
    kind: 'code_cache',
    enabled: true,
    validateTimestamps: true,
    revalidateSeconds: 2,
    refresh: true,
  }

  it('reads the cache and refreshes named files on fixed routes', async () => {
    const requests: SiteHttpRequest[] = []
    const transport: SiteHttpTransport = async (request) => {
      requests.push(request)
      return json(
        request.method === 'GET'
          ? cache
          : { version: 1, kind: 'code_cache_refreshed', refreshed: 1, absent: 1, failed: 0 },
      )
    }
    const gateway = wordpressContentAdapter.createCodeCache!({
      siteId,
      origin: connection.origin,
      access: { v: '1', origin: connection.origin, username: 'u', applicationPassword: 'p' },
      transport,
      allowLoopbackHttp: true,
    })
    expect(await gateway.codeCache()).toEqual(cache)
    expect(
      await gateway.refreshCode(['wp-content/themes/a/footer.php', 'wp-content/old.php']),
    ).toEqual({ version: 1, kind: 'code_cache_refreshed', refreshed: 1, absent: 1, failed: 0 })
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['GET', 'http://127.0.0.1:8099/?rest_route=%2Fraditi%2Fv1%2Fcode-cache'],
      ['POST', 'http://127.0.0.1:8099/?rest_route=%2Fraditi%2Fv1%2Fcode-cache'],
    ])
    expect(JSON.parse(requests[1]!.body!)).toEqual({
      version: 1,
      paths: ['wp-content/themes/a/footer.php', 'wp-content/old.php'],
    })
  })

  it('refuses paths outside the root and answers it does not trust', async () => {
    const transport = vi.fn<SiteHttpTransport>(async () =>
      json({ version: 1, kind: 'code_cache_refreshed', refreshed: 1, absent: 0, failed: 0 }),
    )
    const gateway = new WordpressPublishedContentGateway(connection, transport)
    for (const paths of [[], ['../wp-config.php'], ['/etc/passwd'], ['a//b.php'], ['a\\b.php']])
      await expect(gateway.refreshCode(paths)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(transport).not.toHaveBeenCalled()
    // Counts that do not add up to the paths named, or another kind of answer.
    await expect(gateway.refreshCode(['a.php', 'b.php'])).rejects.toMatchObject({
      code: 'CONTENT_GATEWAY_UNAVAILABLE',
    })
    const other = new WordpressPublishedContentGateway(connection, async () =>
      json({ ...cache, revalidateSeconds: -1 }),
    )
    await expect(other.codeCache()).rejects.toMatchObject({ code: 'CONTENT_GATEWAY_UNAVAILABLE' })
    // An older plugin has no such route: WordPress answers 404.
    const older = new WordpressPublishedContentGateway(connection, async () => ({
      status: 404,
      body: Buffer.from('{"code":"rest_no_route"}'),
    }))
    await expect(older.codeCache()).rejects.toMatchObject({ code: 'CONTENT_GATEWAY_UNAVAILABLE' })
  })
})

describe('the runtime of the site through the plugin (Р2, Р18)', () => {
  const json = (value: unknown) => ({ status: 200, body: Buffer.from(JSON.stringify(value)) })

  it('reads the version of PHP and its extensions on a fixed route, and nothing it does not trust', async () => {
    const runtime = {
      version: 1,
      kind: 'runtime',
      runtimeVersion: '7.4',
      extensions: ['core', 'curl', 'imagick', 'ioncube loader'],
    }
    const requests: SiteHttpRequest[] = []
    const gateway = new WordpressPublishedContentGateway(connection, async (request) => {
      requests.push(request)
      return json(runtime)
    })
    expect(await gateway.runtime()).toEqual(runtime)
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['GET', 'http://127.0.0.1:8099/?rest_route=%2Fraditi%2Fv1%2Fruntime'],
    ])
    for (const wrong of [
      { ...runtime, runtimeVersion: '7' },
      { ...runtime, extensions: ['<script>'] },
      { ...runtime, extensions: Array.from({ length: 257 }, (_, i) => `x${i}`) },
      { ...runtime, kind: 'code_cache' },
    ]) {
      const other = new WordpressPublishedContentGateway(connection, async () => json(wrong))
      await expect(other.runtime()).rejects.toMatchObject({ code: 'CONTENT_GATEWAY_UNAVAILABLE' })
    }
  })
})

describe('the WordPress content access in Vault', () => {
  const access = {
    v: '1' as const,
    origin: 'https://site.example.test',
    username: 'raditi',
    applicationPassword: 'abcd efgh ijkl mnop qrst uvwx',
  }

  it('is the wp access of a site: version, origin, user and application password', () => {
    expect(wordpressContentAdapter.stack).toBe('wordpress')
    expect(wordpressContentAdapter.accessKind).toBe('wp')
    expect(wordpressContentAdapter.accessSchema).toBe(wordpressContentAccessSchema)
    expect(wordpressContentAccessSchema.parse(access)).toEqual(access)
    expect(
      wordpressContentAccessSchema.safeParse({ ...access, origin: 'http://127.0.0.1:8099' })
        .success,
    ).toBe(true)
  })

  it('keeps the origin in the one form a URL parser gives it', () => {
    // What the step that writes the secret must store: `new URL(address).origin`. A Cyrillic
    // name is its punycode there; anything else would never equal the origin of the site.
    const canonical = new URL('https://сайт.рф/').origin
    expect(canonical).toBe('https://xn--80aswg.xn--p1ai')
    expect(wordpressContentAccessSchema.safeParse({ ...access, origin: canonical }).success).toBe(
      true,
    )
    for (const origin of [
      'https://сайт.рф',
      'https://Site.Example.test',
      'https://site.example.test:443',
    ])
      expect(wordpressContentAccessSchema.safeParse({ ...access, origin }).success).toBe(false)
  })

  it.each([
    ['no version', { v: undefined }],
    ['another version', { v: '2' }],
    ['no origin', { origin: undefined }],
    ['an origin with a path', { origin: 'https://site.example.test/wp' }],
    ['an origin with a trailing slash', { origin: 'https://site.example.test/' }],
    ['an origin with credentials', { origin: 'https://user:pass@site.example.test' }],
    ['an origin of another scheme', { origin: 'ftp://site.example.test' }],
    ['no user', { username: undefined }],
    ['an empty user', { username: '' }],
    ['a user with a colon', { username: 'a:b' }],
    ['no password', { applicationPassword: undefined }],
    ['an empty password', { applicationPassword: '' }],
    ['a password with a line break', { applicationPassword: 'abcd\nefgh' }],
    ['an unknown field', { siteId }],
  ])('refuses an incomplete or foreign secret: %s', (_name, change) => {
    const result = wordpressContentAccessSchema.safeParse({ ...access, ...change })
    expect(result.success).toBe(false)
    // A parsing problem names fields, never the stored values.
    expect(JSON.stringify(result.error?.issues)).not.toContain('abcd efgh')
  })

  it('builds the gateway of the given site from the parsed access and the given transport', async () => {
    const requests: SiteHttpRequest[] = []
    const neutral: SiteContentAdapter = wordpressContentAdapter
    const gateway = neutral.createGateway({
      siteId,
      origin: 'https://site.example.test',
      access: neutral.accessSchema.parse(access),
      transport: async (request) => {
        requests.push(request)
        return { status: 200, body: Buffer.from(JSON.stringify(state)) }
      },
      allowLoopbackHttp: false,
    })
    expect(await gateway.read('page:42')).toEqual(state)
    expect(requests[0]).toMatchObject({
      url: 'https://site.example.test/?rest_route=%2Fraditi%2Fv1%2Fcontent%2F42',
      headers: {
        authorization: `Basic ${Buffer.from(`raditi:${access.applicationPassword}`).toString('base64')}`,
        'x-raditi-site': siteId,
      },
    })
    // The site of the connection, never one named by a request.
    await expect(
      gateway.conditionalWrite({ ...write, siteId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(requests).toHaveLength(1)
  })

  it('reaches a loopback site over plain http only when the composition allows it', () => {
    const local = { ...access, origin: 'http://127.0.0.1:8099' }
    const connect = (allowLoopbackHttp: boolean, origin = local.origin) =>
      wordpressContentAdapter.createGateway({
        siteId,
        origin,
        access: { ...local, origin },
        transport: vi.fn(),
        allowLoopbackHttp,
      })
    expect(() => connect(true)).not.toThrow()
    expect(() => connect(false)).toThrow('Published content gateway is unavailable')
    expect(() => connect(true, 'http://site.example.test')).toThrow(
      'Published content gateway is unavailable',
    )
  })
})
