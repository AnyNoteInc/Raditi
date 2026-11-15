import { describe, expect, it, vi } from 'vitest'

import { contentSecurityPolicy as policyOf } from './lib/content-security-policy'

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

describe('frames of the cabinet', () => {
  async function frameSrc(env: Record<string, string>): Promise<string | undefined> {
    vi.resetModules()
    for (const name of ['PAGES_BASE_DOMAIN', 'APP_ENV']) vi.stubEnv(name, env[name] ?? '')
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

  it('frames the captcha only, whatever the build environment says of pages', async () => {
    // The image is built once for every environment: the pages of the one it runs in come per
    // request from proxy.ts (proxy.test.ts).
    const captcha = "frame-src 'self' https://smartcaptcha.cloud.yandex.ru"
    expect(await frameSrc({ PAGES_BASE_DOMAIN: 'pages.localhost' })).toBe(captcha)
    expect(await frameSrc({})).toBe(captcha)
  })

  it('is the very policy proxy.ts sends on pages, without the pages of the agent', async () => {
    expect((await contentSecurityPolicy()).join('; ')).toBe(policyOf(null))
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
  it('transpiles no package of the sites that went with projects (plan 83)', () => {
    expect(config.transpilePackages).not.toEqual(
      expect.arrayContaining(['@repo/site-adapters']),
    )
    expect(config.transpilePackages).not.toEqual(
      expect.arrayContaining(['@repo/site-connections']),
    )
  })

  it('leaves the database driver to Node instead of bundling it', () => {
    expect(config.serverExternalPackages).toEqual(expect.arrayContaining(['pg']))
  })

  it('sends none of its headers on a page of the agent (docs/plan/67, Д3)', async () => {
    const [rule] = await config.headers!()
    // Next never lets a route replace a header the config set: /v/ answers with its own.
    expect(rule!.source).toBe('/((?!v/).*)')
    const matches = (path: string) => new RegExp(`^${rule!.source}$`).test(path)
    for (const path of ['/', '/chats/1', '/api/health', '/v', '/vacancies'])
      expect(matches(path), path).toBe(true)
    expect(matches('/v/a.b')).toBe(false)
  })
})
