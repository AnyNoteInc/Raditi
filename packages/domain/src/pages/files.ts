import { z } from 'zod'

import { pageLimits } from './limits.ts'

/**
 * The shared files of a site of pages (docs/plan/73-pages-sites.md, Дер34; the owner's answer to
 * В4: «общие файлы сделай возможными, потому что технически это будет один сайт со своей
 * структурой»): `/_files/style.css`, `/_files/img/logo.png` — what its pages load from their own
 * host. No HTML: a page is a node of the site, never a file. The type is the extension's, and the
 * bytes of a picture, a font and a PDF must begin as that type does: nothing passes for another.
 */

export const PAGE_FILES_PREFIX = '/_files/'

/** A path of a shared file: up to four folders, a name with an extension of the list. */
export const pageFilePathSchema = z
  .string()
  .max(300)
  .regex(
    /^\/_files\/(?:[a-z0-9][a-z0-9_-]{0,62}\/){0,4}[a-z0-9][a-z0-9_.-]{0,99}\.[a-z0-9]{2,5}$/,
    'a shared file is /_files/<folders>/<name>.<extension>',
  )
  .refine((path) => !path.includes('..'), 'no two dots in a row')
  .refine((path) => pageFileTypeOf(path) !== null, 'not a type a site may serve')

interface FileType {
  type: string
  /** Bytes it must begin with; none — text, checked as text. */
  magic?: readonly (readonly number[])[]
  text?: boolean
}

const TYPES: Readonly<Record<string, FileType>> = Object.freeze({
  css: { type: 'text/css; charset=utf-8', text: true },
  js: { type: 'text/javascript; charset=utf-8', text: true },
  mjs: { type: 'text/javascript; charset=utf-8', text: true },
  svg: { type: 'image/svg+xml', text: true },
  png: { type: 'image/png', magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  jpg: { type: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  jpeg: { type: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  gif: { type: 'image/gif', magic: [[0x47, 0x49, 0x46, 0x38]] },
  webp: { type: 'image/webp', magic: [[0x52, 0x49, 0x46, 0x46]] },
  avif: { type: 'image/avif', magic: [[0x00, 0x00, 0x00]] },
  ico: { type: 'image/x-icon', magic: [[0x00, 0x00, 0x01, 0x00]] },
  woff2: { type: 'font/woff2', magic: [[0x77, 0x4f, 0x46, 0x32]] },
  woff: { type: 'font/woff', magic: [[0x77, 0x4f, 0x46, 0x46]] },
  pdf: { type: 'application/pdf', magic: [[0x25, 0x50, 0x44, 0x46]] },
})

/** The type a path serves as, by its extension; null — none a site may serve. */
export function pageFileTypeOf(path: string): string | null {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return TYPES[extension]?.type ?? null
}

export type PageFileVerdict =
  | { ok: true; type: string }
  | { ok: false; reason: 'type' | 'too_large' | 'not_utf8' | 'signature' }

/**
 * Whether bytes may be served at a path of shared files: the type of its extension, within
 * `fileBytes`, text that is UTF-8, a binary that begins as its type does. The checks of secrets
 * of a text are the caller's (`checkPageContent`, the values of the client).
 */
export function checkPageFile(path: string, bytes: Uint8Array): PageFileVerdict {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const kind = TYPES[extension]
  if (!kind || !pageFilePathSchema.safeParse(path).success) return { ok: false, reason: 'type' }
  if (bytes.byteLength > pageLimits.fileBytes) return { ok: false, reason: 'too_large' }
  if (kind.text) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return { ok: false, reason: 'not_utf8' }
    }
    return { ok: true, type: kind.type }
  }
  const begins = (kind.magic ?? []).some((magic) => magic.every((byte, at) => bytes[at] === byte))
  if (!begins) return { ok: false, reason: 'signature' }
  if (extension === 'webp' && String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP')
    return { ok: false, reason: 'signature' }
  if (extension === 'avif' && String.fromCharCode(...bytes.slice(4, 8)) !== 'ftyp')
    return { ok: false, reason: 'signature' }
  return { ok: true, type: kind.type }
}

/** Whether a shared file is text: its content is checked as a page is. */
export const pageFileIsText = (path: string): boolean =>
  TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()]?.text === true

/**
 * The headers of a shared file (Дер34): its own type and no other reading of it (`nosniff`); any
 * page may load it — a sandboxed page asks from an opaque origin, which `same-origin` would refuse,
 * and the bytes of a public picture are no secret —; opened alone it runs nothing (`sandbox`), an
 * SVG with its styles only; a PDF downloads.
 */
export function pageFileHeaders(type: string): Record<string, string> {
  return {
    'Content-Type': type,
    'Content-Security-Policy':
      type === 'image/svg+xml'
        ? "default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'"
        : "default-src 'none'; sandbox; frame-ancestors 'none'",
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    // A sandboxed page asks a font or a module by CORS from an opaque origin (`Origin: null`):
    // without this Chromium and Firefox refuse it (docs/plan/88-artifacts.md, spike 2, question 25).
    'Access-Control-Allow-Origin': '*',
    ...(type === 'application/pdf' ? { 'Content-Disposition': 'attachment' } : {}),
  }
}
