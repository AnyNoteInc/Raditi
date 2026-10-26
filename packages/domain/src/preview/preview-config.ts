import { z } from 'zod'

import { isProduction, type AppEnv } from '../app-env.ts'
import { envVar } from '../env.ts'
import { DIGEST_PINNED_IMAGE, sandboxRuntimes } from '../ports/sandbox-provider.ts'
import { turnExecutorKinds } from '../ports/turn-executor.ts'
import { previewBaseDomainSchema, previewSchemes, type PreviewAddress } from './hostname.ts'

/**
 * Settings of previews and of the release API (docs/plan/53-chat-preview-release.md, «Имена»,
 * «Переменные окружения»). The pieces web, core and the `preview` role share: the address of a
 * preview must read the same in all three, and production refuses the same mistakes in each.
 * Pure: the registrable domain of a name comes from the caller (`tldts` in the apps).
 */
export const previewDefaults = Object.freeze({
  /** PREVIEW_GATEWAY_PORT: the `preview` role. */
  gatewayPort: 8090,
  /**
   * PREVIEW_TTL_HOURS: the life of an unviewed preview of a waiting dialog — its copy is kept for
   * a rebuild, and the reserve of a dialog with a candidate follows it (Р8).
   */
  ttlHours: 72,
  /**
   * PREVIEW_IDLE_MINUTES: a served preview no one looked at and no turn of its dialog used this
   * long stops (owner's answer of 26.10.2026); a view or the next turn starts it again.
   */
  idleMinutes: 30,
  /** PREVIEW_UPSTREAM_HOST: where the entry forwarders publish (loopback of core in dev). */
  upstreamHost: '127.0.0.1',
  /**
   * PREVIEW_DNS_SERVERS: the resolvers a preview's PHP asks (docs/plan/58, «Решение владельца»:
   * its internet is open), public ones only. Under gVisor the forwarder of names inside the
   * container asks them (infra/preview/dns.mjs); under runc Docker's resolver answers first and
   * asks the same servers.
   */
  dnsServers: ['77.88.8.8', '77.88.8.1'] as readonly string[],
  /** RELEASE_API_PORT: the release API of core. */
  releaseApiPort: 8085,
  /** RELEASE_START_TIMEOUT_MINUTES: a deploy job silent this long is revoked (Р31). */
  releaseStartTimeoutMinutes: 10,
})

/** PREVIEW_SESSION_SECRET signs the cookie of the gateway. */
export const PREVIEW_SESSION_SECRET_MIN_BYTES = 32

/** PREVIEW_EXECUTOR: core's own Docker (never in production until M10) or a runner VM. */
export const previewExecutorKinds = turnExecutorKinds
export type PreviewExecutorKind = (typeof previewExecutorKinds)[number]

/** PREVIEW_RUNTIME: gVisor on Linux, runc where it is unavailable (outside production). */
export const previewRuntimes = sandboxRuntimes
export type PreviewRuntimeKind = (typeof previewRuntimes)[number]

/**
 * The roles of the images the platform pins besides the preview's own (PREVIEW_*_IMAGE): the
 * database of a dump's staging (`db`), the platform's tools (`forwarder` — the files helper, the
 * lease, the browser relay) and the agent's browser. The preview itself is one image per runtime
 * version (PREVIEW_SITE_IMAGES, docs/plan/58).
 */
export const previewImageRoles = ['db', 'forwarder', 'browser'] as const
export type PreviewImageRole = (typeof previewImageRoles)[number]

/** One image: a repository pinned by digest, no tag. */
export const previewImageSchema = z
  .string()
  .max(512)
  .regex(DIGEST_PINNED_IMAGE, 'expected an image pinned by digest (repository@sha256:…)')

const PORT = z.coerce.number().int().min(1).max(65_535)

/** The three variables of the address: web, core and the `preview` role read them alike. */
export const previewAddressEnvShape = {
  // Unset — previews are not configured here: nothing builds or shows one.
  PREVIEW_BASE_DOMAIN: envVar(previewBaseDomainSchema.optional()),
  // Unset — https in production, http elsewhere.
  PREVIEW_SCHEME: envVar(
    z.enum(previewSchemes, { error: `must be one of ${previewSchemes.join(', ')}` }).optional(),
  ),
  // Unset — the port of the scheme.
  PREVIEW_PUBLIC_PORT: envVar(PORT.optional()),
}

export interface PreviewAddressEnv {
  PREVIEW_BASE_DOMAIN?: string | undefined
  PREVIEW_SCHEME?: PreviewAddress['scheme'] | undefined
  PREVIEW_PUBLIC_PORT?: number | undefined
}

/** null — previews are not configured (no base domain). */
export function previewAddressFromEnv(
  env: PreviewAddressEnv,
  appEnv: AppEnv,
): PreviewAddress | null {
  if (env.PREVIEW_BASE_DOMAIN === undefined) return null
  return {
    baseDomain: env.PREVIEW_BASE_DOMAIN,
    scheme: env.PREVIEW_SCHEME ?? (isProduction(appEnv) ? 'https' : 'http'),
    publicPort: env.PREVIEW_PUBLIC_PORT ?? null,
  }
}

/** The registrable domain of a host by the Public Suffix List, or null (an IP, `localhost`). */
export type RegistrableDomainOf = (hostname: string) => string | null

export interface PreviewAddressCheck {
  appEnv: AppEnv
  address: PreviewAddress | null
  /** APP_URL: the cabinet. */
  appUrl: string
  /** GITEA_URL, when this process knows it. */
  giteaUrl?: string | undefined
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/**
 * What production refuses (Р19): http, and a base domain under the registrable domain of the
 * cabinet or of Gitea — a preview runs the site's code, and a cookie of that domain would reach
 * them. `NAME: message`, never a value.
 */
export function previewAddressProblems(
  check: PreviewAddressCheck,
  registrableDomain: RegistrableDomainOf,
): string[] {
  const { address } = check
  if (address === null || !isProduction(check.appEnv)) return []
  const problems: string[] = []
  if (address.scheme !== 'https') problems.push('PREVIEW_SCHEME: must be https in production')
  const own = registrableDomain(address.baseDomain)
  if (own === null) {
    problems.push(
      'PREVIEW_BASE_DOMAIN: must be a name under a public suffix in production (not an address or a local name)',
    )
    return problems
  }
  const others: [string, string | undefined][] = [
    ['APP_URL', check.appUrl],
    ['GITEA_URL', check.giteaUrl],
  ]
  for (const [name, url] of others) {
    const host = url === undefined ? null : hostOf(url)
    if (host !== null && registrableDomain(host) === own)
      problems.push(
        `PREVIEW_BASE_DOMAIN: must not share its registrable domain with ${name} in production (a preview runs the site's code)`,
      )
  }
  return problems
}

/** PREVIEW_SESSION_SECRET: at least 32 bytes; required where the gateway runs in production. */
export function previewSessionSecretProblem(
  secret: string | undefined,
  appEnv: AppEnv,
): string | null {
  if (secret === undefined) return isProduction(appEnv) ? 'required in production' : null
  return new TextEncoder().encode(secret).byteLength < PREVIEW_SESSION_SECRET_MIN_BYTES
    ? `must be at least ${PREVIEW_SESSION_SECRET_MIN_BYTES} bytes`
    : null
}

const PHP_VERSION = /^\d{1,2}\.\d{1,2}$/

/** PREVIEW_DNS_SERVERS: one to three IPv4 resolvers, comma-separated. */
export const previewDnsServersSchema = z
  .string()
  .transform((raw) => raw.split(',').map((part) => part.trim()))
  .pipe(z.array(z.ipv4()).min(1).max(3))

/**
 * `PREVIEW_SITE_IMAGES`: the image of a preview per runtime version (infra/preview/Dockerfile,
 * target `site` — the site's server, its database and its gateway; docs/plan/58), e.g.
 * `8.3=<image@sha256:…>,8.2=…`.
 */
export function parsePreviewSiteImages(raw: string | undefined): {
  images: Readonly<Record<string, string>>
  problems: string[]
} {
  const images: Record<string, string> = {}
  const problems: string[] = []
  if (raw === undefined || raw.trim() === '') return { images, problems }
  for (const entry of raw.split(',')) {
    const at = entry.indexOf('=')
    const version = entry.slice(0, at).trim()
    const image = entry.slice(at + 1).trim()
    if (at < 0 || !PHP_VERSION.test(version))
      problems.push('PREVIEW_SITE_IMAGES: expected <version>=<image@sha256:…> entries, e.g. 8.3=…')
    else if (!previewImageSchema.safeParse(image).success)
      problems.push(`PREVIEW_SITE_IMAGES: the image of ${version} must be pinned by digest`)
    else if (Object.hasOwn(images, version))
      problems.push(`PREVIEW_SITE_IMAGES: ${version} is listed twice`)
    else images[version] = image
  }
  return { images: Object.freeze(images), problems }
}
