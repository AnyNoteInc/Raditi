import { describe, expect, it } from 'vitest'

import { cafe, scenarioIds, scenarios, story } from './landing-story'

const NBSP = '\u00a0'
const plain = (text: string) => text.replaceAll(NBSP, ' ')

describe('landing story', () => {
  it('lists every request of the demo once', () => {
    expect([...scenarioIds].sort()).toEqual(Object.keys(scenarios).sort())
  })

  it('writes the price of the story once: the request, the change and the amounts agree', () => {
    expect(story.amount.before).not.toBe(story.amount.after)
    expect(plain(story.before)).toBe(`${story.amount.before} ₽`)
    expect(plain(story.after)).toBe(`${story.amount.after} ₽`)
    expect(plain(story.request)).toContain(`на ${story.amount.after} ₽`)
    // The story is the first request of the demo, not a copy of it.
    expect(story.request).toBe(scenarios.price.request)
    expect(plain(story.field)).toContain(cafe.item)
  })

  it('keeps a number with its unit in the visible text and types the labels plainly', () => {
    for (const id of scenarioIds) {
      const { label, ...visible } = scenarios[id]
      expect(label).not.toContain(NBSP)
      for (const text of Object.values(visible)) expect(text).not.toMatch(/\d [₽\p{L}]/u)
    }
    expect(story.before).toContain(NBSP)
    expect(cafe.volume).toContain(NBSP)
  })

  it('gives the words of the story with plain spaces for a label of a screen reader', () => {
    for (const text of Object.values(story.inWords)) expect(text).not.toContain(NBSP)
    expect(story.inWords.request).toBe(plain(story.request))
    expect(story.inWords.before).toBe(plain(story.before))
    expect(story.inWords.after).toBe(plain(story.after))
  })

  it('changes something in every request', () => {
    for (const id of scenarioIds) expect(scenarios[id].before).not.toBe(scenarios[id].after)
    expect(cafe.banner.before).not.toBe(cafe.banner.after)
  })
})
