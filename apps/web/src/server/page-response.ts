import 'server-only'

import { documentKindOf, pageResponseHeaders } from '@repo/domain'

// What the domain of pages answers (docs/plan/67-agent-documents.md, Д3): the bytes of a page the
// agent made, sandboxed by its CSP into an opaque origin that reaches no network, form or frame,
// framed only by the cabinet. The policy and the headers are those of a published page
// (docs/plan/69-pages.md, Ст9) — one family for both plans — but framed by the cabinet and never
// stored. next.config.ts sends none of its own headers on /v/, so these are the ones the browser gets.

/** The headers of a page of a chat, framed by the cabinet. */
export function pageHeaders(appOrigin: string, length: number): Record<string, string> {
  return {
    ...pageResponseHeaders('html', { framedBy: appOrigin }),
    'Content-Length': String(length),
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
      headers: pageHeaders(pages.appOrigin, file.bytes.byteLength),
    })
  } catch (error) {
    deps.onFailure?.('page view failed', error)
    return pageAnswer(503, 'Не удалось открыть страницу.')
  }
}
