import { describe, expect, it } from 'vitest'

import { newTurnKeys } from '../llm/turn-key.ts'
import {
  mentionsAnyPreviewHost,
  mentionsPreviewHost,
  publishedValueRefusal,
} from './published-value.ts'

// What never reaches a published page (docs/plan/53-chat-preview-release.md, Р3, Р24): one set of
// rules for the agent's input, for a state a preview says it stored and for a release.

const HOST = 'site-0a1b2c3d-chat-0a1b2c.preview.example.ru'

describe('published values', () => {
  it('finds any preview of a base domain, in any spelling a browser follows', () => {
    const base = 'preview.example.ru'
    for (const text of [
      '<a href="https://site-ffff1111-chat-ffff11.preview.example.ru/">x</a>',
      '<a href="https://SITE-ffff1111-CHAT-ffff11.Preview.Example.RU/">x</a>',
      '<a href="https://site-ffff1111-chat-ffff11%2Epreview.example.ru/">x</a>',
      '<a href="https://site-ffff1111-chat-ffff11&#46;preview.example.ru/">x</a>',
      '<a href="https://site-ffff1111-chat-ffff11。preview.example.ru/">x</a>',
    ])
      expect(mentionsAnyPreviewHost(text, base), text).toBe(true)
    for (const text of [
      '<a href="https://site.example.ru/">x</a>',
      'site-ffff1111-chat-ffff11.other.example.ru',
      'site-ffff1111-chat-ffff11.preview-example.ru',
    ])
      expect(mentionsAnyPreviewHost(text, base), text).toBe(false)
    expect(mentionsPreviewHost(`http://${HOST}:8090/`, HOST)).toBe(true)
  })

  it('refuses a turn credential before anything else, then a preview, else nothing', () => {
    const keys = newTurnKeys()
    expect(publishedValueRefusal(keys.llmApiKey, {})).toBe('credential')
    expect(publishedValueRefusal(`<p>${keys.mcpToken}</p>`, { hostname: HOST })).toBe('credential')
    expect(publishedValueRefusal(`https://${HOST}/`, { hostname: HOST })).toBe('preview_origin')
    expect(
      publishedValueRefusal('https://site-aaaa1111-chat-aaaa11.preview.example.ru/', {
        baseDomain: 'preview.example.ru',
      }),
    ).toBe('preview_origin')
    expect(
      publishedValueRefusal('<p>Текст про site.example.ru</p>', {
        hostname: HOST,
        baseDomain: 'preview.example.ru',
      }),
    ).toBeNull()
    expect(publishedValueRefusal('https://site-aaaa1111-chat-aaaa11.preview.example.ru/', {})).toBe(
      null,
    )
  })
})
