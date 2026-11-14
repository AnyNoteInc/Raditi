import { z } from 'zod'

import { DomainError } from '../errors.ts'

/**
 * The address of a published page (docs/plan/69-pages.md, Ст3, Ст10): `https://<slug>.<base>/`,
 * one label under `PAGES_BASE_DOMAIN`. The slug is 16 random bytes in lower-case base32 without
 * padding — 26 characters, 128 bits, well inside the 63 of a DNS label. A page has one address
 * whatever its version (Ст16).
 */
export const PAGE_SLUG_LENGTH = 26
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

export const pageSlugSchema = z
  .string()
  .regex(new RegExp(`^[a-z2-7]{${PAGE_SLUG_LENGTH}}$`), 'invalid page slug')

/** A new slug from 16 bytes of `random` — `crypto.randomBytes` in the callers, a fixed one in tests. */
export function newPageSlug(random: (size: number) => Uint8Array): string {
  const bytes = random(16)
  if (bytes.length !== 16)
    throw new DomainError('BAD_REQUEST', 'A page slug takes 16 random bytes', 400)
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** A base domain as configured: lower case, labels of letters, digits and hyphens, no dot at the end. */
export const pagesBaseDomainSchema = z
  .string()
  .max(200)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    'must be a lower-case domain name',
  )

/**
 * The words no site may take as its own name (docs/plan/73-pages-sites.md, Дер32): the names of
 * the platform and of what a reader takes for one. Checked whatever the tariff.
 */
export const RESERVED_PAGE_NAMES: ReadonlySet<string> = new Set([
  'www',
  'api',
  'app',
  'admin',
  'administrator',
  'root',
  'mail',
  'smtp',
  'imap',
  'pop',
  'ftp',
  'ssh',
  'vpn',
  'ns1',
  'ns2',
  'dns',
  'cdn',
  'static',
  'assets',
  'files',
  'media',
  'img',
  'pages',
  'page',
  'raditi',
  'radit',
  'help',
  'support',
  'docs',
  'status',
  'login',
  'logout',
  'signin',
  'signup',
  'auth',
  'oauth',
  'account',
  'accounts',
  'billing',
  'pay',
  'payment',
  'payments',
  'checkout',
  'cabinet',
  'dashboard',
  'console',
  'preview',
  'previews',
  'test',
  'dev',
  'stage',
  'staging',
  'prod',
  'production',
  'security',
  'abuse',
  'postmaster',
  'webmaster',
  'hostmaster',
  'noreply',
  'no-reply',
  'yandex',
  'google',
  'sberbank',
  'gosuslugi',
])

/**
 * The own name of a site (Дер32; «Бизнес» and above): 3 to 25 lower-case Latin letters, digits and
 * hyphens, a letter or a digit at each end and no two hyphens together — never 26 characters, so
 * a name and a random slug are told apart by their length alone. Not a reserved word.
 */
export const pageNameSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,23}[a-z0-9]$/,
    'a name is 3 to 25 letters, digits and hyphens',
  )
  .refine((name) => !RESERVED_PAGE_NAMES.has(name), 'this name is not given to a site')

/** The label of a page host: a random slug, or the own name of its site. */
export const pageHostLabelSchema = z.union([pageSlugSchema, pageNameSchema])

/** The host of a page: its site's slug or name under the base domain. */
export function pageHostOf(label: string, baseDomain: string): string {
  return `${pageHostLabelSchema.parse(label)}.${pagesBaseDomainSchema.parse(baseDomain)}`
}

/** The address of a page as the client and the viewer get it. */
export function pageUrlOf(
  slug: string,
  options: { baseDomain: string; scheme?: 'https' | 'http'; port?: number },
): string {
  const port = options.port === undefined ? '' : `:${options.port}`
  return `${options.scheme ?? 'https'}://${pageHostOf(slug, options.baseDomain)}${port}/`
}

/**
 * The label a `Host` header names — a slug or the own name of a site —, or null: exactly one label right under the base domain,
 * in any letter case. Another level, a dot at the end, an address, user info or a port — null,
 * except `port` when it is the public port the server is configured with: dev and the stands
 * pass it, production never does (Ст10). The base domain is the configured one and must pass
 * `pagesBaseDomainSchema` — a wrong one throws rather than answer 404 to every page.
 */
export function slugOfPageHost(
  host: string | undefined,
  options: { baseDomain: string; port?: number },
): string | null {
  if (!host || host.length > 300) return null
  let name = host.toLowerCase()
  const colon = name.lastIndexOf(':')
  if (colon !== -1) {
    if (options.port === undefined || name.slice(colon + 1) !== String(options.port)) return null
    name = name.slice(0, colon)
  }
  const suffix = `.${pagesBaseDomainSchema.parse(options.baseDomain)}`
  if (!name.endsWith(suffix)) return null
  const label = name.slice(0, -suffix.length)
  // The label is the site's random slug or its own name (docs/plan/73-pages-sites.md, Дер33).
  return pageHostLabelSchema.safeParse(label).success ? label : null
}
