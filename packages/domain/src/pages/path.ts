import { z } from 'zod'

import { pageLimits } from './limits.ts'

/**
 * The path of a page inside its site (docs/plan/73-pages-sites.md, Дер15): `/` is the home page,
 * `/uslugi/remont` a page two levels down. A segment is a DNS-like label — lower-case Latin
 * letters, digits and hyphens, no hyphen at either end — so a path is never decoded, normalised or
 * guessed at: `%`, `.`, `..`, `//`, `;`, `\`, an empty segment and anything else simply do not
 * match. `robots.txt` has a dot and is no path of a page. The canonical form has no slash at the
 * end; `/A/b` and `/a/b/` are the only two non-canonical forms the page server sends on to it.
 */
export const pageSegmentSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'a segment is a lower-case label')

/** The segments of a path; `[]` is the home page. */
export const pageSegmentsSchema = z
  .array(pageSegmentSchema)
  .max(pageLimits.pageDepth, `a page is at most ${pageLimits.pageDepth} levels down`)

/** A canonical path as stored and served: `/` or `/a/b`, at most `pagePathChars` characters. */
export const pagePathSchema = z
  .string()
  .max(pageLimits.pagePathChars)
  .regex(
    new RegExp(`^(?:/|(?:/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){1,${pageLimits.pageDepth}})$`),
    'not a canonical page path',
  )

const parseSegments = (path: string): string[] | null => {
  if (!path.startsWith('/') || path.length > pageLimits.pagePathChars) return null
  if (path === '/') return []
  const segments = path.slice(1).split('/')
  return pageSegmentsSchema.safeParse(segments).success ? segments : null
}

/** The canonical path of segments. */
export const pagePathOf = (segments: readonly string[]): string =>
  segments.length === 0 ? '/' : `/${pageSegmentsSchema.parse([...segments]).join('/')}`

/** The parent path of a page; null — the home page has none. */
export const parentPagePath = (path: string): string | null => {
  const segments = parseSegments(path)
  if (segments === null) throw new Error('not a canonical page path')
  return segments.length === 0 ? null : pagePathOf(segments.slice(0, -1))
}

/**
 * What the page server does with the path of a request (the query is cut off before):
 * `page` — a canonical path to look up; `redirect` — the canonical form of an upper-case path or
 * of one with a slash at the end, computed here and checked by the schema, never the request's
 * own text; `none` — 404 without a lookup. `robots.txt` is the server's own and never comes here.
 */
export type PageRequestPath =
  { kind: 'page'; path: string } | { kind: 'redirect'; path: string } | { kind: 'none' }

export function pageRequestPath(raw: string): PageRequestPath {
  if (raw === '/') return { kind: 'page', path: '/' }
  if (raw.length > pageLimits.pagePathChars + 1 || !raw.startsWith('/')) return { kind: 'none' }
  const exact = parseSegments(raw)
  if (exact !== null) return { kind: 'page', path: raw }
  // Only two forms are sent on: a slash at the end, and capital letters — nothing else is fixed.
  const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw
  const lowered = trimmed.replace(/[A-Z]/g, (char) => char.toLowerCase())
  if (trimmed === '' || trimmed === '/' || (trimmed === raw && lowered === raw))
    return { kind: 'none' }
  const canonical = parseSegments(lowered)
  return canonical === null ? { kind: 'none' } : { kind: 'redirect', path: pagePathOf(canonical) }
}
