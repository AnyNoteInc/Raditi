import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  parsePreviewWebImages,
  previewAddressEnvShape,
  previewAddressFromEnv,
  previewAddressProblems,
  previewDefaults,
  previewSessionSecretProblem,
  type RegistrableDomainOf,
} from './preview-config.ts'

const digest = `sha256:${'a'.repeat(64)}`
/** Enough of the Public Suffix List for the cases below. */
const registrable: RegistrableDomainOf = (host) => {
  if (/^[\d.]+$/.test(host) || !host.includes('.')) return null
  const labels = host.split('.')
  if (host.endsWith('.co.uk')) return labels.slice(-3).join('.')
  return labels.slice(-2).join('.')
}
const read = (env: Record<string, string | undefined>) =>
  z.object(previewAddressEnvShape).parse(env)

describe('the address variables', () => {
  it('turns previews off without a base domain', () => {
    expect(previewAddressFromEnv(read({}), 'development')).toBeNull()
    expect(previewAddressFromEnv(read({ PREVIEW_BASE_DOMAIN: ' ' }), 'production')).toBeNull()
  })

  it('takes http outside production and https in it by default', () => {
    expect(
      previewAddressFromEnv(
        read({ PREVIEW_BASE_DOMAIN: 'localhost', PREVIEW_PUBLIC_PORT: '8090' }),
        'development',
      ),
    ).toEqual({ baseDomain: 'localhost', scheme: 'http', publicPort: 8090 })
    expect(
      previewAddressFromEnv(read({ PREVIEW_BASE_DOMAIN: 'preview.raditi.ru' }), 'production'),
    ).toEqual({ baseDomain: 'preview.raditi.ru', scheme: 'https', publicPort: null })
  })

  it('refuses a base with a port or an address, and an unknown scheme', () => {
    for (const env of [
      { PREVIEW_BASE_DOMAIN: 'localhost:8090' },
      { PREVIEW_BASE_DOMAIN: '127.0.0.1' },
      { PREVIEW_SCHEME: 'ftp' },
      { PREVIEW_PUBLIC_PORT: '0' },
    ])
      expect(z.object(previewAddressEnvShape).safeParse(env).success, JSON.stringify(env)).toBe(
        false,
      )
  })
})

describe('production checks', () => {
  const check = (baseDomain: string, scheme: 'http' | 'https' = 'https', giteaUrl?: string) =>
    previewAddressProblems(
      {
        appEnv: 'production',
        address: { baseDomain, scheme, publicPort: null },
        appUrl: 'https://app.raditi.ru',
        giteaUrl,
      },
      registrable,
    )

  it('accepts a base of its own registrable domain over https', () => {
    expect(check('preview.raditi-sites.ru')).toEqual([])
  })

  it('refuses http, a shared registrable domain and a local name', () => {
    expect(check('preview.raditi-sites.ru', 'http')).toEqual([
      'PREVIEW_SCHEME: must be https in production',
    ])
    expect(check('preview.raditi.ru')[0]).toMatch(/^PREVIEW_BASE_DOMAIN: .*APP_URL/)
    expect(check('preview.git.example.ru', 'https', 'https://git.example.ru')[0]).toMatch(
      /GITEA_URL/,
    )
    expect(check('localhost')[0]).toMatch(/^PREVIEW_BASE_DOMAIN: must be a name/)
  })

  it('checks nothing outside production and without previews', () => {
    expect(
      previewAddressProblems(
        {
          appEnv: 'development',
          address: { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 },
          appUrl: 'http://localhost:3000',
        },
        registrable,
      ),
    ).toEqual([])
    expect(
      previewAddressProblems(
        { appEnv: 'production', address: null, appUrl: 'https://raditi.ru' },
        registrable,
      ),
    ).toEqual([])
  })
})

describe('the session secret and the images', () => {
  it('wants 32 bytes, and a secret at all in production', () => {
    expect(previewSessionSecretProblem(undefined, 'development')).toBeNull()
    expect(previewSessionSecretProblem(undefined, 'production')).toBe('required in production')
    expect(previewSessionSecretProblem('x'.repeat(31), 'development')).toMatch(/32 bytes/)
    expect(previewSessionSecretProblem('я'.repeat(16), 'production')).toBeNull()
  })

  it('reads web images by runtime version, each pinned by digest', () => {
    expect(parsePreviewWebImages(undefined)).toEqual({ images: {}, problems: [] })
    expect(
      parsePreviewWebImages(`8.3=registry.raditi.ru/preview-php@${digest}, 8.2=php@${digest}`),
    ).toEqual({
      images: { '8.3': `registry.raditi.ru/preview-php@${digest}`, '8.2': `php@${digest}` },
      problems: [],
    })
    expect(parsePreviewWebImages('8.3=php:8.3-apache').problems).toEqual([
      'PREVIEW_WEB_IMAGES: the image of 8.3 must be pinned by digest',
    ])
    expect(parsePreviewWebImages(`php@${digest}`).problems).toHaveLength(1)
    expect(parsePreviewWebImages(`8.3=php@${digest},8.3=php@${digest}`).problems).toEqual([
      'PREVIEW_WEB_IMAGES: 8.3 is listed twice',
    ])
  })

  it('keeps the defaults of the plan', () => {
    expect(previewDefaults).toMatchObject({
      gatewayPort: 8090,
      ttlHours: 72,
      idleMinutes: 30,
      upstreamHost: '127.0.0.1',
      releaseApiPort: 8085,
      releaseStartTimeoutMinutes: 10,
    })
  })
})
