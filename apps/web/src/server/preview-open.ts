import 'server-only'

import {
  chatCommandRefusalText,
  chatCommandRefusals,
  isDomainError,
  isPreviewPath,
  parsePreviewHostname,
  type ChatCommandRefusal,
  type PreviewAddress,
} from '@repo/domain'

import { safeRedirectTarget } from '@/lib/safe-redirect'

/**
 * `/preview/open?host=…&path=…` (PREVIEW_OPEN_PATH, previewOpenUrl of @repo/domain;
 * docs/plan/53-chat-preview-release.md, Р19, Р20): the way into a
 * dialog's preview from the cabinet. «Открыть в новой вкладке» opens it, and the gateway of
 * previews sends here a visitor whose session ended outside the iframe. A signed-in member of
 * the site's workspace gets a one-time ticket and goes to the gateway's entry with it; a
 * preview of someone else answers exactly like one that does not exist.
 */
export interface PreviewOpenDependencies {
  /** null — previews are not configured here (PREVIEW_BASE_DOMAIN is unset). */
  preview: () => PreviewAddress | null
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>
  /** Whether the user of these headers accepted the current required documents (152-FZ). */
  hasRequiredConsents: (headers: Headers) => Promise<boolean>
  /**
   * The entry URL with a fresh ticket for a member of the preview's workspace (`openPreview`
   * of @repo/trpc). Throws its DomainError: NOT_FOUND for a preview of someone else or none.
   */
  open: (input: { userId: string; hostname: string; to: string }) => Promise<{ url: string }>
  /** For the server log only: the cause never reaches the visitor. */
  onFailure?: (operation: string, error: unknown) => void
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

function page(
  status: number,
  title: string,
  text: string,
  options: { refreshSeconds?: number } = {},
): Response {
  const refresh =
    options.refreshSeconds === undefined
      ? ''
      : `<meta http-equiv="refresh" content="${options.refreshSeconds}">`
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
${refresh}<title>${escapeHtml(title)}</title><style>
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2328;background:#fff}
main{max-width:36rem;margin:0 auto;padding:96px 24px}h1{font-size:28px;margin:0 0 12px}a{color:#0b57d0}
@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}a{color:#79b8ff}}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><p><a href="/projects">К проектам</a></p></main></body></html>`
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** The same answer for a preview of someone else, one that does not exist and a bad address. */
const notFound = () =>
  page(404, 'Страница не найдена', 'Возможно, в адресе опечатка или страницу перенесли.')

const redirect = (location: string): Response =>
  new Response(null, {
    status: 303,
    headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  })

const isRefusal = (value: unknown): value is ChatCommandRefusal =>
  typeof value === 'string' && (chatCommandRefusals as readonly string[]).includes(value)

function refusalOf(details: unknown): ChatCommandRefusal | null {
  const refusal =
    details !== null && typeof details === 'object' && 'refusal' in details ? details.refusal : null
  return isRefusal(refusal) ? refusal : null
}

/** One value of a query parameter; null when it is absent or given twice. */
function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name)
  return values.length === 1 ? (values[0] ?? null) : null
}

export async function openPreviewRoute(
  request: Request,
  deps: PreviewOpenDependencies,
): Promise<Response> {
  const url = new URL(request.url)
  const address = deps.preview()
  const hostname = single(url.searchParams, 'host')
  if (
    address === null ||
    hostname === null ||
    parsePreviewHostname(hostname, address.baseDomain) === null
  )
    return notFound()
  // A path the gateway would not send a viewer to becomes the home page of the preview.
  const written = url.searchParams.has('path') ? single(url.searchParams, 'path') : '/'
  const to = written !== null && isPreviewPath(written) ? written : '/'

  let userId: string
  try {
    const session = await deps.getSession(request.headers)
    if (session === null) {
      const back = safeRedirectTarget(`${url.pathname}${url.search}`)
      return redirect(`/sign-in?next=${encodeURIComponent(back)}`)
    }
    userId = session.user.id
    if (!(await deps.hasRequiredConsents(request.headers))) return redirect('/onboarding/consents')
  } catch (error) {
    deps.onFailure?.('preview open: session', error)
    return page(503, 'Сервис временно недоступен', 'Попробуйте открыть предпросмотр немного позже.')
  }

  try {
    const { url: entry } = await deps.open({ userId, hostname, to })
    return redirect(entry)
  } catch (error) {
    if (isDomainError(error)) {
      if (error.code === 'NOT_FOUND' || error.code === 'BAD_REQUEST') return notFound()
      const refusal = refusalOf(error.details)
      // A stopped preview asked to come back (PREVIEW_NOT_READY) and one still being built
      // (the refusal of `/preview`, pending or building) both answer the same page, which asks
      // again by itself until the preview serves.
      if (error.code === 'PREVIEW_NOT_READY' || refusal === 'preview_not_ready')
        return page(
          503,
          'Предпросмотр готовится',
          'Страница обновится сама, как только он будет готов.',
          { refreshSeconds: 5 },
        )
      if (refusal !== null)
        return page(409, 'Предпросмотр сейчас не открыть', chatCommandRefusalText[refusal])
    }
    deps.onFailure?.('preview open', error)
    return page(503, 'Сервис временно недоступен', 'Попробуйте открыть предпросмотр немного позже.')
  }
}
