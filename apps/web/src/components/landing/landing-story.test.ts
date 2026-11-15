import { describe, expect, it } from 'vitest'

import { cafe, scenarioIds, scenarios } from './landing-story'
import { plain } from './testing'

const NBSP = '\u00a0'

describe('landing story', () => {
  it('lists the requests of the demo in the order of their buttons', () => {
    expect(scenarioIds).toEqual(['compare', 'letter', 'page'])
    expect(Object.keys(scenarios)).toEqual(scenarioIds)
  })

  it('keeps a number with its unit in the visible text and types the labels plainly', () => {
    for (const id of scenarioIds) {
      const { label, ...visible } = scenarios[id]
      expect(label).not.toContain(NBSP)
      for (const text of Object.values(visible)) expect(text).not.toMatch(/\d [₽\p{L}]/u)
    }
    expect(scenarios.compare.after).toContain(NBSP)
  })

  it('publishes the page of the third request at an address of the pages', () => {
    expect(plain(scenarios.page.after)).toMatch(/\.pages\.raditi\.ru$/)
    // The window itself is the fictional cafe's.
    expect(cafe.address).toMatch(/\.example$/)
  })

  it('tells of no site of the client: the requests are everyday tasks', () => {
    for (const id of scenarioIds)
      for (const text of Object.values(scenarios[id]))
        expect(text).not.toMatch(/(?<![а-яё])(сайт|правк)/i)
  })

  it('changes something in every request', () => {
    for (const id of scenarioIds) expect(scenarios[id].before).not.toBe(scenarios[id].after)
    expect(cafe.banner.before).not.toBe(cafe.banner.after)
  })
})
