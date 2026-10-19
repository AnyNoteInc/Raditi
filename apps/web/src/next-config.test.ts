import { describe, expect, it, vi } from 'vitest'

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
