import { greetingName } from './greeting-name.ts'

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}

/** Greets by name only when greetingName lets the name through. */
export function greeting(name?: string): string {
  const safe = greetingName(name)
  return safe ? `Здравствуйте, ${safe}!` : 'Здравствуйте!'
}

const moscowDateTime = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Moscow',
})

/** "26.09.2026, 21:00 по московскому времени" */
export function formatMoscowDateTime(iso: string): string {
  return `${moscowDateTime.format(new Date(iso))} по московскому времени`
}

/** One paragraph of plain text; escaped here so templates cannot forget it. */
export function p(text: string): string {
  return `<p style="margin:0 0 16px">${esc(text)}</p>`
}

export function button(label: string, url: string): string {
  return (
    `<p style="margin:0 0 16px"><a href="${esc(url)}" ` +
    'style="display:inline-block;padding:12px 20px;background:#1f5eff;color:#ffffff;' +
    `text-decoration:none;border-radius:8px">${esc(label)}</a></p>`
  )
}

/** The raw link under a button, for mail clients that hide buttons. */
export function fallbackLink(url: string): string {
  return (
    '<p style="margin:0 0 16px;font-size:14px;color:#57606a">Если кнопка не открывается, ' +
    `скопируйте ссылку в браузер:<br><a href="${esc(url)}" style="color:#1f5eff;word-break:break-all">${esc(url)}</a></p>`
  )
}

const FOOTER_TEXT = 'Письмо отправлено автоматически, отвечать на него не нужно.'

export function layout(subject: string, bodyHtml: string): string {
  return (
    '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${esc(subject)}</title></head>` +
    '<body style="margin:0;padding:24px;background:#ffffff;color:#1f2328;' +
    'font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5">' +
    `<div style="max-width:560px;margin:0 auto">${bodyHtml}` +
    `<p style="margin:32px 0 0;font-size:13px;color:#6e7781">${esc(FOOTER_TEXT)}<br>Радити · raditi.ru</p>` +
    '</div></body></html>'
  )
}

export function textLayout(paragraphs: readonly string[]): string {
  return [...paragraphs, `${FOOTER_TEXT}\nРадити · raditi.ru`].join('\n\n')
}
