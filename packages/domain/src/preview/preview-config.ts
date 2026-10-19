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
  /** PREVIEW_TTL_HOURS: an unviewed preview stops after this long. */
  ttlHours: 72,
  /** PREVIEW_UPSTREAM_HOST: where the entry forwarders publish (loopback of core in dev). */
  upstreamHost: '127.0.0.1',
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

/** The roles of the containers whose images the platform pins (PREVIEW_*_IMAGE). */
export const previewImageRoles = ['db', 'cli', 'forwarder', 'browser', 'egress'] as const
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

/** `PREVIEW_WEB_IMAGES`: a web image per runtime version, e.g. `8.3=<image@sha256:…>,8.2=…`. */
export function parsePreviewWebImages(raw: string | undefined): {
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
      problems.push('PREVIEW_WEB_IMAGES: expected <version>=<image@sha256:…> entries, e.g. 8.3=…')
    else if (!previewImageSchema.safeParse(image).success)
      problems.push(`PREVIEW_WEB_IMAGES: the image of ${version} must be pinned by digest`)
    else if (Object.hasOwn(images, version))
      problems.push(`PREVIEW_WEB_IMAGES: ${version} is listed twice`)
    else images[version] = image
  }
  return { images: Object.freeze(images), problems }
}
