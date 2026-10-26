// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AgentMarkdown, hiddenHost, linkUrl } from './agent-markdown'

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
