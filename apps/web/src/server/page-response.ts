import 'server-only'

import { documentKindOf, pageContentSecurityPolicy } from '@repo/domain'

export { pageContentSecurityPolicy }

// What the domain of pages answers (docs/plan/67-agent-documents.md, Д3): the bytes of a page the
// agent made, sandboxed by its CSP into an opaque origin that reaches nothing — no network, no
// form, no frame — framed only by the cabinet. next.config.ts sends none of its own headers on
// /v/, so these are the ones the browser gets.

const PERMISSIONS = [
  'camera',
  'microphone',
  'geolocation',
  'payment',
  'usb',
  'serial',
  'bluetooth',
  'clipboard-read',
  'cross-origin-isolated',
]
  .map((feature) => `${feature}=()`)
  .join(', ')

/** The headers of a page and of a shared document. */
export function pageHeaders(
  appOrigin: string,
  { scripts, length }: { scripts: boolean; length: number },
): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(length),
    'x-content-type-options': 'nosniff',
    'content-security-policy': pageContentSecurityPolicy(appOrigin, { scripts }),
    'permissions-policy': PERMISSIONS,
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'cache-control': 'private, no-store',
  }
}

/** A short answer of the domain of pages without the page: never a word of why. */
export const pageAnswer = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow, noarchive',
    },
  })

export interface PageViewDependencies {
  /** The domain of pages: its host, the cabinet's origin and the view key; null — off. */
  pages: () => { host: string; appOrigin: string; viewKey: Uint8Array } | null
  readView: (
    key: Uint8Array,
    token: string,
    now: number,
  ) => { taskId: string; fileId: string; userId: string } | 'expired' | null
  /** The file, for that member: readTaskFile of @repo/trpc. */
  read: (input: {
    userId: string
    taskId: string
    fileId: string
  }) => Promise<{ name: string; bytes: Uint8Array } | null>
  now?: () => number
  onFailure?: (operation: string, error: unknown) => void
}

/** `GET /v/<token>` on the domain of pages: a page of a chat in the frame of its member. */
export async function getPageView(
  request: Request,
  token: string,
  deps: PageViewDependencies,
): Promise<Response> {
  try {
    const pages = deps.pages()
    // The proxy splits the hosts; a route that is reached some other way checks again.
    const host = (request.headers.get('host')?.toLowerCase() ?? '').replace(/:(?:443|80)$/, '')
    if (pages === null || host !== pages.host) return pageAnswer(404, 'Не найдено')
    const view = deps.readView(pages.viewKey, token, (deps.now ?? Date.now)())
    if (view === 'expired') return pageAnswer(410, 'Адрес устарел. Обновите документ.')
    if (view === null) return pageAnswer(404, 'Не найдено')
    const file = await deps.read(view)
    if (file === null || documentKindOf(file.name) !== 'page') return pageAnswer(404, 'Не найдено')
    return new Response(new Uint8Array(file.bytes), {
      headers: pageHeaders(pages.appOrigin, { scripts: true, length: file.bytes.byteLength }),
    })
  } catch (error) {
    deps.onFailure?.('page view failed', error)
    return pageAnswer(503, 'Не удалось открыть страницу.')
  }
}
