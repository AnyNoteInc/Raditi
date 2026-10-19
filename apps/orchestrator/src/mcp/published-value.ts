import { TURN_KEY_IN_TEXT } from '../llm/turn-key.ts'

// What the platform never carries onto a published page, whoever wrote the value
// (docs/plan/53-chat-preview-release.md, Р3, Р24): the agent's input to `wp_rest`, the state a
// preview's plugin says it stored — the preview runs the agent's code, so its plugin can answer
// anything —, and the value a release writes to production.

/** Named character references a host can be spelled with in HTML. */
const hostReferences: Readonly<Record<string, string>> = {
  period: '.',
  hyphen: '-',
  dash: '-',
  minus: '-',
  amp: '&',
  percnt: '%',
  num: '#',
  semi: ';',
}
const codePoint = (value: number, written: string) =>
  value > 0 && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff)
    ? String.fromCodePoint(value)
    : written

/**
 * A text as a browser reads a host out of it: character references of HTML and percent
 * escapes decoded — nested ones too —, compatibility forms and the ideographic full stops a host
 * parser folds into ASCII and dots, what it drops (tab, line breaks, soft hyphen, zero-width
 * characters) dropped, lower case.
 */
export function hostSearchText(value: string): string {
  let text = value
  for (let round = 0; round < 4; round++) {
    const decoded = text
      .replace(/&#x([0-9a-f]{1,6});?/gi, (written, hex: string) =>
        codePoint(Number.parseInt(hex, 16), written),
      )
      .replace(/&#([0-9]{1,7});?/g, (written, digits: string) =>
        codePoint(Number.parseInt(digits, 10), written),
      )
      .replace(
        /&([a-z]+);/gi,
        (written, name: string) => hostReferences[name.toLowerCase()] ?? written,
      )
      .replace(/(?:%[0-9a-f]{2})+/gi, (written) => {
        try {
          return decodeURIComponent(written)
        } catch {
          return written
        }
      })
    if (decoded === text) break
    text = decoded
  }
  return text
    .normalize('NFKC')
    .replace(/[\u3002\uff0e\uff61]/g, '.')
    .replace(/[\t\n\r\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
    .toLowerCase()
}

/** Whether a text, read as hostSearchText reads it, names any preview of `baseDomain`. */
function namesPreviewOf(text: string, baseDomain: string): boolean {
  const base = baseDomain.toLowerCase().replaceAll('.', '\\.')
  return new RegExp(`site-[0-9a-z]{4,12}-chat-[0-9a-z]{4,12}\\.${base}`).test(text)
}

/**
 * Whether a text names the host of this preview — or of any preview of its base domain — in any
 * spelling a browser would follow: any case, scheme or port, escaped or written in entities.
 */
export function mentionsPreviewHost(value: string, hostname: string): boolean {
  const text = hostSearchText(value)
  const host = hostname.toLowerCase()
  if (text.includes(host)) return true
  return namesPreviewOf(text, host.slice(host.indexOf('.') + 1))
}

/** Whether a text names any preview of `baseDomain` (PREVIEW_BASE_DOMAIN), in any spelling. */
export function mentionsAnyPreviewHost(value: string, baseDomain: string): boolean {
  return namesPreviewOf(hostSearchText(value), baseDomain)
}

/**
 * Why a value may not reach a published page: it holds a turn credential (`credential`), or
 * names a preview — this one (`hostname`) or any of the base domain (`baseDomain`) — that
 * outlives no dialog (`preview_origin`). null — it may.
 */
export function publishedValueRefusal(
  value: string,
  previews: { hostname?: string | null; baseDomain?: string | null },
): 'credential' | 'preview_origin' | null {
  if (TURN_KEY_IN_TEXT.test(value)) return 'credential'
  if (previews.hostname && mentionsPreviewHost(value, previews.hostname)) return 'preview_origin'
  if (previews.baseDomain && mentionsAnyPreviewHost(value, previews.baseDomain))
    return 'preview_origin'
  return null
}
