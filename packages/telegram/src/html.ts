import { TELEGRAM_LIMITS } from './limits.ts'

// The agent writes Markdown; Telegram takes a small set of HTML tags (Bot API, «HTML style»).
// The words of a message are cut into parts that each fit one message, a part never splits a tag,
// and everything that is not markup is escaped: the text of the agent can never inject a tag.

/**
 * Text characters of one part. Telegram counts the text after its entities are parsed (at most
 * 4096); a part of Markdown never grows in text, so this leaves room for the list marks.
 */
export const TELEGRAM_PART_CHARS = 3_800

export const escapeTelegramHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const escapeAttribute = (text: string): string => escapeTelegramHtml(text).replace(/"/g, '&quot;')

/** Inline Markdown of one line: code, links, bold, italic, strike. */
function inline(line: string): string {
  // Code spans first: what is inside is not markup.
  const parts = line.split(/(`[^`\n]+`)/u)
  return parts
    .map((part) => {
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`'))
        return `<code>${escapeTelegramHtml(part.slice(1, -1))}</code>`
      let html = escapeTelegramHtml(part)
      // [text](https://…): only http and https; anything else stays as written.
      html = html.replace(
        /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu,
        (_match, text: string, url: string) =>
          `<a href="${escapeAttribute(url.replace(/&amp;/g, '&'))}">${text}</a>`,
      )
      html = html.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/gu, '<b>$1</b>')
      html = html.replace(/__(?=\S)([^_\n]*?\S)__/gu, '<b>$1</b>')
      html = html.replace(/~~(?=\S)([^~\n]*?\S)~~/gu, '<s>$1</s>')
      html = html.replace(
        /(^|[^\p{L}\p{N}*])\*(?=\S)([^*\n]*?\S)\*(?![\p{L}\p{N}*])/gu,
        '$1<i>$2</i>',
      )
      html = html.replace(
        /(^|[^\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu,
        '$1<i>$2</i>',
      )
      return html
    })
    .join('')
}

type Block = { kind: 'code'; lang: string; lines: string[] } | { kind: 'text'; lines: string[] }

/** Fenced code and everything else, in their order. */
function blocksOf(markdown: string): Block[] {
  const blocks: Block[] = []
  let code: { lang: string; lines: string[] } | null = null
  let text: string[] = []
  const flush = () => {
    if (text.some((line) => line.trim() !== '')) blocks.push({ kind: 'text', lines: text })
    text = []
  }
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fence = /^\s*```\s*([\w+-]{0,32})\s*$/u.exec(line)
    if (code) {
      if (fence && fence[1] === '') {
        blocks.push({ kind: 'code', lang: code.lang, lines: code.lines })
        code = null
      } else code.lines.push(line)
      continue
    }
    if (fence) {
      flush()
      code = { lang: fence[1] ?? '', lines: [] }
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    text.push(line)
  }
  if (code) blocks.push({ kind: 'code', lang: code.lang, lines: code.lines })
  flush()
  return blocks
}

function textHtml(lines: readonly string[]): string {
  const out: string[] = []
  let quote: string[] = []
  const endQuote = () => {
    if (quote.length > 0) out.push(`<blockquote>${quote.join('\n')}</blockquote>`)
    quote = []
  }
  for (const line of lines) {
    const quoted = /^\s*>\s?(.*)$/u.exec(line)
    if (quoted) {
      quote.push(inline(quoted[1] ?? ''))
      continue
    }
    endQuote()
    const heading = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/u.exec(line)
    if (heading) {
      out.push(`<b>${inline(heading[1] ?? '')}</b>`)
      continue
    }
    const item = /^(\s*)[-*+]\s+(.*)$/u.exec(line)
    if (item) {
      out.push(`${item[1] ?? ''}• ${inline(item[2] ?? '')}`)
      continue
    }
    // A table is shown as written, in a monospace block.
    if (/^\s*\|.*\|\s*$/u.test(line)) {
      out.push(`<code>${escapeTelegramHtml(line.trim())}</code>`)
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(line)) {
      out.push('———')
      continue
    }
    out.push(inline(line))
  }
  endQuote()
  return out.join('\n')
}

function blockHtml(block: Block): string {
  if (block.kind === 'text') return textHtml(block.lines)
  const lang = block.lang === '' ? '' : ` class="language-${block.lang}"`
  return `<pre><code${lang}>${escapeTelegramHtml(block.lines.join('\n'))}</code></pre>`
}

const blockChars = (block: Block): number =>
  block.lines.reduce((sum, line) => sum + line.length + 1, 0)

/** A block longer than one part: by lines, and a line longer than a part by characters. */
function splitBlock(block: Block, max: number): Block[] {
  const out: Block[] = []
  let lines: string[] = []
  let size = 0
  const push = () => {
    if (lines.length > 0) out.push({ ...block, lines })
    lines = []
    size = 0
  }
  for (const line of block.lines) {
    const pieces =
      line.length <= max ? [line] : (line.match(new RegExp(`[\\s\\S]{1,${max}}`, 'gu')) ?? [])
    for (const piece of pieces) {
      if (size + piece.length + 1 > max) push()
      lines.push(piece)
      size += piece.length + 1
    }
  }
  push()
  return out
}

/**
 * Markdown as Telegram HTML, cut into messages: blocks are kept together while they fit, a long
 * block is cut by lines. Never an empty part; an empty text gives none.
 */
export function markdownToTelegramParts(markdown: string, max = TELEGRAM_PART_CHARS): string[] {
  const parts: string[] = []
  let current: string[] = []
  let size = 0
  for (const block of blocksOf(markdown).flatMap((b) =>
    blockChars(b) > max ? splitBlock(b, max) : [b],
  )) {
    const chars = blockChars(block)
    if (current.length > 0 && size + chars + 1 > max) {
      parts.push(current.join('\n\n'))
      current = []
      size = 0
    }
    current.push(blockHtml(block))
    size += chars + 1
  }
  if (current.length > 0) parts.push(current.join('\n\n'))
  return parts.filter((part) => part.trim() !== '')
}

/** Plain words cut into messages of at most `max` characters, by lines where possible. */
export function plainTelegramParts(
  text: string,
  max: number = TELEGRAM_LIMITS.messageTextMax,
): string[] {
  const block: Block = { kind: 'text', lines: text.split('\n') }
  return splitBlock(block, max)
    .map((b) => b.lines.join('\n').trim())
    .filter((part) => part !== '')
}
