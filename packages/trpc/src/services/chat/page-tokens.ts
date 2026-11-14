import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

// The tokens of the domain of pages (docs/plan/67-agent-documents.md, Д3): a token of a view names
// one page of a chat for one member and lives five minutes. It is signed by HMAC-SHA256 with a key
// of its own derived from PAGES_SIGNING_SECRET and kept nowhere (rule 2). Shared links are plan
// 69's (owner's answer of 13.11.2026).

/** How long the address of a page in the frame of the cabinet lives. */
export const PAGE_VIEW_TTL_MS = 5 * 60 * 1000

const VIEW_INFO = 'raditi-page-view-v1'

export interface PageKeys {
  view: Uint8Array
}

/** The key of the domain of pages from its secret (HKDF-SHA256, 32 bytes). */
export function pageKeys(secret: string): PageKeys {
  if (secret.length === 0) throw new Error('The secret of the pages is empty')
  const key = (info: string) =>
    new Uint8Array(hkdfSync('sha256', secret, new Uint8Array(0), info, 32))
  return { view: key(VIEW_INFO) }
}

const base64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url')
const mac = (key: Uint8Array, data: string) =>
  createHmac('sha256', key).update(data, 'utf8').digest()

/** `data.mac` of a signed token, or null: not two parts, a part that is not base64url, a bad mac. */
function opened(key: Uint8Array, token: string, label: string): string | null {
  if (token.length > 1024) return null
  const parts = token.split('.')
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null
  const [data, signature] = parts as [string, string]
  const expected = mac(key, `${label}\0${data}`)
  const given = Buffer.from(signature, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  return data
}

const viewSchema = z.strictObject({
  t: z.uuid(),
  f: z.uuid(),
  u: z.string().min(1).max(200),
  e: z.number().int().positive(),
})

export interface PageView {
  taskId: string
  fileId: string
  userId: string
  /** Milliseconds since the epoch. */
  expiresAt: number
}

/** The token of the address of a page in the frame of the cabinet. */
export function signPageView(key: Uint8Array, view: PageView): string {
  const data = base64url(
    JSON.stringify({ t: view.taskId, f: view.fileId, u: view.userId, e: view.expiresAt }),
  )
  return `${data}.${base64url(mac(key, `view\0${data}`))}`
}

/** What a token of a view names: null — not one of ours; `expired` — ours, out of its time. */
export function readPageView(
  key: Uint8Array,
  token: string,
  now: number,
): PageView | 'expired' | null {
  const data = opened(key, token, 'view')
  if (data === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const view = viewSchema.safeParse(parsed)
  if (!view.success) return null
  if (view.data.e <= now) return 'expired'
  return {
    taskId: view.data.t.toLowerCase(),
    fileId: view.data.f.toLowerCase(),
    userId: view.data.u,
    expiresAt: view.data.e,
  }
}
