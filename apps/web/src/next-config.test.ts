import { describe, expect, it, vi } from 'vitest'

import {
  contentSecurityPolicy as policyOf,
  previewFrameSource,
} from './lib/content-security-policy'

// The config loads the monorepo's .env; the headers need none of it.
vi.mock('@next/env', () => ({ loadEnvConfig: vi.fn() }))
vi.mock('@next/mdx', () => ({ default: () => (config: unknown) => config }))

const { default: config } = await import('../next.config')

async function contentSecurityPolicy(): Promise<string[]> {
  const rules = (await config.headers?.()) ?? []
  const value = rules
    .flatMap((rule) => rule.headers)
    .find((header) => header.key === 'Content-Security-Policy')?.value
  return (value ?? '').split(';').map((directive) => directive.trim())
}

describe('security headers', () => {
  it('lets pages load images only from the site itself and the captcha', async () => {
    expect(await contentSecurityPolicy()).toContain(
      "img-src 'self' data: blob: https://smartcaptcha.cloud.yandex.ru",
    )
  })

  it('keeps the directives that need no allowlist', async () => {
    expect(await contentSecurityPolicy()).toEqual(
      expect.arrayContaining([
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ]),
    )
  })

  it('is never framed itself, whatever it frames', async () => {
    const rules = (await config.headers?.()) ?? []
    const frame = rules.flatMap((rule) => rule.headers).find((h) => h.key === 'X-Frame-Options')
    expect(frame?.value).toBe('DENY')
  })
})

describe('frames of the cabinet (plan 53, Р20)', () => {
  async function frameSrc(env: Record<string, string>): Promise<string | undefined> {
    vi.resetModules()
    for (const name of ['PREVIEW_BASE_DOMAIN', 'PREVIEW_SCHEME', 'PREVIEW_PUBLIC_PORT', 'APP_ENV'])
      vi.stubEnv(name, env[name] ?? '')
    try {
      const { default: fresh } = await import('../next.config')
      const rules = (await fresh.headers?.()) ?? []
      return rules
        .flatMap((rule) => rule.headers)
        .find((header) => header.key === 'Content-Security-Policy')
        ?.value.split(';')
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith('frame-src'))
    } finally {
      vi.unstubAllEnvs()
    }
  }

  it('frames the captcha only, whatever the build environment says of previews', async () => {
    // The image is built once for every environment: the previews of the one it runs in come
    // per request from proxy.ts (proxy.test.ts).
    const captcha = "frame-src 'self' https://smartcaptcha.cloud.yandex.ru"
    expect(await frameSrc({ PREVIEW_BASE_DOMAIN: 'localhost', PREVIEW_PUBLIC_PORT: '8090' })).toBe(
      captcha,
    )
    expect(await frameSrc({})).toBe(captcha)
  })

  it('is the very policy proxy.ts sends on pages, without the previews', async () => {
    expect((await contentSecurityPolicy()).join('; ')).toBe(policyOf(null))
  })

  it('spells the preview source as the gateway serves it', () => {
    expect(previewFrameSource({ PREVIEW_BASE_DOMAIN: 'localhost' })).toBe('http://*.localhost')
    expect(
      previewFrameSource({ APP_ENV: 'production', PREVIEW_BASE_DOMAIN: 'raditi-preview.ru' }),
    ).toBe('https://*.raditi-preview.ru')
    expect(
      previewFrameSource({
        PREVIEW_BASE_DOMAIN: 'p.example.ru',
        PREVIEW_SCHEME: 'https',
        PREVIEW_PUBLIC_PORT: '443',
      }),
    ).toBe('https://*.p.example.ru')
    expect(
      previewFrameSource({ PREVIEW_BASE_DOMAIN: 'p.example.ru', PREVIEW_PUBLIC_PORT: '8443' }),
    ).toBe('http://*.p.example.ru:8443')
    // Nothing that could widen the source or break the header.
    for (const base of ['', '*', 'Example.ru', 'a.ru; script-src *', 'a.ru:8090', '.a.ru', 'a..ru'])
      expect(previewFrameSource({ PREVIEW_BASE_DOMAIN: base }), base).toBeNull()
    expect(
      previewFrameSource({ PREVIEW_BASE_DOMAIN: 'a.ru', PREVIEW_SCHEME: 'javascript' }),
    ).toBeNull()
  })

  it('adds the previews to the frame sources and changes nothing else of the policy', () => {
    const plain = policyOf(null)
    const framed = policyOf('https://*.raditi-preview.ru')
    expect(framed).toBe(
      plain.replace(
        "frame-src 'self' https://smartcaptcha.cloud.yandex.ru",
        "frame-src 'self' https://smartcaptcha.cloud.yandex.ru https://*.raditi-preview.ru",
      ),
    )
  })
})

describe('request bodies', () => {
  it('buffers no more of a body sent to a page than a server action may take', () => {
    // Next copies the body of every request that passes proxy.ts (every page) into memory and
    // holds it until the request ends: 10 MB by default, for any sender. The only body a page
    // takes is a server action's, and Next refuses those over 1 MB by itself.
    expect(config.experimental?.proxyClientMaxBodySize).toBe('1mb')
    expect(config.experimental?.serverActions?.bodySizeLimit).toBeUndefined()
  })
})

describe('packages', () => {
  it('transpiles the workspace packages of the site connection wizard', () => {
    expect(config.transpilePackages).toEqual(
      expect.arrayContaining(['@repo/site-adapters', '@repo/site-connections']),
    )
  })

  it('leaves the drivers that reach a client server to Node instead of bundling them', () => {
    expect(config.serverExternalPackages).toEqual(
      expect.arrayContaining(['pg', 'ssh2', 'basic-ftp', 'mysql2']),
    )
  })
})
