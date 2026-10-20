import { randomBytes } from 'node:crypto'

/**
 * The few pages the gateway of previews answers itself (docs/plan/53-chat-preview-release.md,
 * Р19), in Russian and on «вы». Each is self-contained — no external resource, a CSP that runs
 * nothing but its own nonce — and may be framed only by the cabinet.
 */

export interface GatewayPage {
  status: number
  headers: Record<string, string>
  body: Buffer
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

/** A string for a <script>: JSON that cannot close the element or start a comment. */
const scriptString = (value: string): string =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

const STYLE = `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2328;background:#fff}
main{max-width:28rem;padding:24px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 12px}
a{color:#0b57d0}@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}a{color:#79b8ff}}`

function page(options: {
  status: number
  frameAncestors: string
  title: string
  text: string
  link?: { href: string; label: string }
  refreshSeconds?: number
  script?: string
}): GatewayPage {
  const nonce = randomBytes(16).toString('base64')
  const refresh =
    options.refreshSeconds === undefined
      ? ''
      : `<meta http-equiv="refresh" content="${options.refreshSeconds}">`
  const link = options.link
    ? `<p><a href="${escapeHtml(options.link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(options.link.label)}</a></p>`
    : ''
  const script = options.script ? `<script nonce="${nonce}">${options.script}</script>` : ''
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
${refresh}<title>${escapeHtml(options.title)}</title><style nonce="${nonce}">${STYLE}</style></head>
<body><main><h1 id="title">${escapeHtml(options.title)}</h1><p id="text">${escapeHtml(options.text)}</p>${link}</main>${script}</body></html>`
  const policy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${options.frameAncestors}`,
  ].join('; ')
  const body = Buffer.from(html)
  return {
    status: options.status,
    body,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
      'content-security-policy': policy,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow',
    },
  }
}

export interface PagesContext {
  /** The cabinet's origin: the only frame ancestor and the way back. */
  appOrigin: string
}

export const gatewayPages = {
  notFound: (context: PagesContext): GatewayPage =>
    page({
      status: 404,
      frameAncestors: context.appOrigin,
      title: 'Предпросмотр не найден',
      text: 'Такого адреса нет или предпросмотр уже удалён. Откройте предпросмотр из диалога в кабинете.',
      link: { href: `${context.appOrigin}/projects`, label: 'Перейти в кабинет' },
    }),

  /** pending or building: the page asks again by itself. */
  preparing: (context: PagesContext): GatewayPage =>
    page({
      status: 503,
      frameAncestors: context.appOrigin,
      title: 'Предпросмотр готовится',
      text: 'Это займёт немного времени — страница обновится сама.',
      refreshSeconds: 5,
    }),

  unavailable: (context: PagesContext): GatewayPage =>
    page({
      status: 503,
      frameAncestors: context.appOrigin,
      title: 'Предпросмотр сейчас недоступен',
      text: 'Откройте его заново из диалога в кабинете.',
    }),

  upstreamFailed: (context: PagesContext): GatewayPage =>
    page({
      status: 502,
      frameAncestors: context.appOrigin,
      title: 'Сайт в предпросмотре не ответил',
      text: 'Обновите страницу немного позже.',
    }),

  upstreamTimeout: (context: PagesContext): GatewayPage =>
    page({
      status: 504,
      frameAncestors: context.appOrigin,
      title: 'Сайт в предпросмотре отвечает слишком долго',
      text: 'Обновите страницу немного позже.',
    }),

  /** A ticket that is unknown, spent, expired or of another preview. */
  ticketRefused: (context: PagesContext, openUrl: string): GatewayPage =>
    page({
      status: 403,
      frameAncestors: context.appOrigin,
      title: 'Ссылка на предпросмотр устарела',
      text: 'Откройте предпросмотр из кабинета ещё раз.',
      link: { href: openUrl, label: 'Открыть из кабинета' },
    }),

  badLink: (context: PagesContext): GatewayPage =>
    page({
      status: 400,
      frameAncestors: context.appOrigin,
      title: 'Неверная ссылка на предпросмотр',
      text: 'Откройте предпросмотр из диалога в кабинете.',
    }),

  tooLarge: (context: PagesContext): GatewayPage =>
    page({
      status: 413,
      frameAncestors: context.appOrigin,
      title: 'Слишком большой запрос',
      text: 'Предпросмотр не принимает такие большие данные.',
    }),

  /**
   * The page inside the cabinet's iframe when the session is gone: it asks the cabinet (the
   * parent, by its exact origin) to open the preview again. The cabinet answers with a new
   * frame whose src is a fresh entry URL — never with a message: a ticket posted into this
   * window could be read by any script of the site, which shares the window and the origin.
   * Message contract — plan 53, «Маршруты».
   */
  frameTicket: (context: PagesContext, preview: { hostname: string; path: string }): GatewayPage =>
    page({
      status: 200,
      frameAncestors: context.appOrigin,
      title: 'Открываем предпросмотр',
      text: 'Подождите немного.',
      script: frameTicketScript(context.appOrigin, preview.hostname, preview.path),
    }),
}

/** Seconds the frame waits for the cabinet to replace it before it says so. */
export const FRAME_TICKET_WAIT_SECONDS = 15

export const PREVIEW_TICKET_REQUEST = 'raditi-preview-ticket-request'

function frameTicketScript(appOrigin: string, hostname: string, path: string): string {
  return `(function(){
var parentOrigin=${scriptString(appOrigin)},host=${scriptString(hostname)},path=${scriptString(path)};
function say(title,text){document.getElementById('title').textContent=title;document.getElementById('text').textContent=text}
if(window.parent===window){say('Предпросмотр открывается из кабинета','Откройте его из диалога в кабинете.');return}
window.parent.postMessage({type:${scriptString(PREVIEW_TICKET_REQUEST)},host:host,path:path},parentOrigin);
setTimeout(function(){say('Не удалось открыть предпросмотр','Обновите страницу кабинета.')},${FRAME_TICKET_WAIT_SECONDS * 1000});
})();`
}
