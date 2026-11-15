import { describe, expect, it } from 'vitest'

import { escapeTelegramHtml, markdownToTelegramParts, plainTelegramParts } from './html.ts'

describe('markdownToTelegramParts', () => {
  it('turns the markup of the agent into the tags Telegram takes', () => {
    const [html] = markdownToTelegramParts(
      '## Готово\n\nЯ **поменял** заголовок и *цвет* кнопки, см. `style.css`.\n\n- раз\n- [сайт](https://example.ru/?a=1&b=2)',
    )
    expect(html).toBe(
      '<b>Готово</b>\n\nЯ <b>поменял</b> заголовок и <i>цвет</i> кнопки, см. <code>style.css</code>.\n\n' +
        '• раз\n• <a href="https://example.ru/?a=1&amp;b=2">сайт</a>',
    )
  })

  it('escapes what is not markup, so the words never become a tag', () => {
    const [html] = markdownToTelegramParts('<script>alert(1)</script> & <b>не жирный</b>')
    expect(html).toBe('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;не жирный&lt;/b&gt;')
  })

  it('keeps fenced code as written and leaves links of other schemes alone', () => {
    const [html] = markdownToTelegramParts(
      '```php\n<?php echo "**x**"; ?>\n```\n\n[x](javascript:alert(1))',
    )
    expect(html).toBe(
      '<pre><code class="language-php">&lt;?php echo "**x**"; ?&gt;</code></pre>\n\n[x](javascript:alert(1))',
    )
  })

  it('leaves the underscores of names alone', () => {
    expect(markdownToTelegramParts('file_name_here и _курсив_')).toEqual([
      'file_name_here и <i>курсив</i>',
    ])
  })

  it('cuts a long answer into parts that each fit a message, never inside a tag', () => {
    const paragraph = `**${'слово '.repeat(60).trim()}**`
    const parts = markdownToTelegramParts(Array(30).fill(paragraph).join('\n\n'), 1_000)
    expect(parts.length).toBeGreaterThan(5)
    for (const part of parts) {
      expect(part.replace(/<[^>]+>/g, '').length).toBeLessThanOrEqual(1_000)
      expect(part.match(/<b>/g)?.length).toBe(part.match(/<\/b>/g)?.length)
    }
  })

  it('cuts a long code block into several closed blocks', () => {
    const code = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    const parts = markdownToTelegramParts(`\`\`\`\n${code}\n\`\`\``, 500)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part).toMatch(/^<pre><code>[\s\S]*<\/code><\/pre>$/)
  })

  it('gives nothing for an empty text', () => {
    expect(markdownToTelegramParts('  \n\n ')).toEqual([])
  })
})

describe('plainTelegramParts', () => {
  it('cuts plain words by lines, a long line by characters', () => {
    const parts = plainTelegramParts(`${'а'.repeat(10)}\n${'б'.repeat(25)}`, 12)
    expect(parts.every((part) => part.length <= 12)).toBe(true)
    expect(parts.join('')).toBe(`${'а'.repeat(10)}${'б'.repeat(25)}`)
  })
})

describe('escapeTelegramHtml', () => {
  it('escapes the three characters Telegram parses', () => {
    expect(escapeTelegramHtml('a<b>&c')).toBe('a&lt;b&gt;&amp;c')
  })
})
