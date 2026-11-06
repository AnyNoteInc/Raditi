// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AgentMarkdown, fenceTextTrees, hiddenHost, linkUrl } from './agent-markdown'

describe('the agent’s words as Markdown', () => {
  it('draws emphasis, lists and code, and drops raw HTML', () => {
    const { container } = render(
      <AgentMarkdown
        text={
          '**Что это за сайт.** Учебный комбинат.\n\n1. Раз\n2. Два\n\n`wp_head`\n\n<script>alert(1)</script><b>жирно</b>'
        }
      />,
    )
    expect(container.querySelector('strong')?.textContent).toBe('Что это за сайт.')
    expect(container.querySelectorAll('ol > li')).toHaveLength(2)
    expect(container.querySelector('code')?.textContent).toBe('wp_head')
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
  })

  // 06.11.2026: the tree of a project came as one paragraph — its lines joined, its indent lost.
  it('draws a tree of folders as code, with its root and its indent', () => {
    const tree = [
      'Вот структура:',
      '',
      'репозиторий сайта/',
      '└── wp-content/',
      '    ├── mu-plugins/',
      '    │   └── site-favicon.php',
      '    └── themes/',
      '',
      'Если нужно, раскрою.',
    ].join('\n')
    const { container } = render(<AgentMarkdown text={tree} />)
    expect(container.querySelector('pre code')?.textContent).toBe(
      'репозиторий сайта/\n└── wp-content/\n    ├── mu-plugins/\n    │   └── site-favicon.php\n    └── themes/\n',
    )
    expect([...container.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'Вот структура:',
      'Если нужно, раскрою.',
    ])
  })

  it('fences no lone line, no sentence before a tree and nothing already fenced', () => {
    expect(fenceTextTrees('Итог │ всё')).toBe('Итог │ всё')
    expect(fenceTextTrees('Вот так:\n├── a\n└── b')).toBe('Вот так:\n```\n├── a\n└── b\n```')
    const fenced = '```\nroot/\n├── a\n└── b\n```'
    expect(fenceTextTrees(fenced)).toBe(fenced)
  })

  it('keeps a line break of the agent inside a paragraph, and adds none between the blocks of a list', () => {
    const { container } = render(<AgentMarkdown text={'Первая строка\nвторая строка'} />)
    // The page puts a line feed after `<br>`, which the browser draws as nothing.
    const html = (node: Element | null | undefined) => node?.innerHTML.replace(/\n/g, '')
    expect(html(container.querySelector('p'))).toBe('Первая строка<br>вторая строка')
    const loose = render(<AgentMarkdown text={'1. Раз\n\n2. Два:\n// строка'} />).container
    const items = [...loose.querySelectorAll('li')]
    expect(items.map((item) => item.querySelectorAll('br').length)).toEqual([0, 1])
    expect(html(items[1]!.querySelector('p'))).toBe('Два:<br>// строка')
  })

  it('loads no picture and keeps only absolute http(s) and mailto links', () => {
    const { container } = render(
      <AgentMarkdown
        text={
          '![логотип](https://tracker.example/pixel.png) [раз](javascript:alert(1)) [два](/settings) [три](//evil.example) [четыре](https://example.org/docs)'
        }
      />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('логотип')
    const links = [...container.querySelectorAll('a')]
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['https://example.org/docs'])
    expect(links[0]!.getAttribute('target')).toBe('_blank')
    expect(links[0]!.getAttribute('rel')).toBe('noopener noreferrer nofollow')
  })

  it('names the host a link leads to when its words do not', () => {
    render(
      <AgentMarkdown text="[raditi.ru/оплата](https://pay.evil.example/x) и [example.org](https://www.example.org/a)" />,
    )
    expect(screen.getByRole('link', { name: /raditi\.ru\/оплата/ }).textContent).toContain(
      '(pay.evil.example)',
    )
    expect(screen.getByRole('link', { name: 'example.org' }).textContent).toBe('example.org')
  })

  it('reads addresses by their scheme and host', () => {
    expect(linkUrl('https://a.example')).toBe('https://a.example')
    expect(linkUrl('mailto:info@a.example')).toBe('mailto:info@a.example')
    expect(linkUrl('ircs://a.example')).toBe('')
    expect(linkUrl('//a.example')).toBe('')
    expect(hiddenHost('mailto:info@a.example', 'почта')).toBeNull()
    expect(hiddenHost('https://www.a.example/x', 'A.example/x')).toBeNull()
    expect(hiddenHost('https://a.example/x', 'здесь')).toBe('a.example')
  })
})
