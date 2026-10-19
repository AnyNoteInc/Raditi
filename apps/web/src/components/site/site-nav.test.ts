import { describe, expect, it } from 'vitest'

import {
  activeSiteSection,
  availableSiteSections,
  closedSectionsNote,
  hasSiteList,
  siteEntryHref,
  siteHref,
  siteItemOpen,
  siteLanding,
  siteNav,
  sitePaneOpen,
  siteSectionAvailable,
} from './site-nav'

const id = '0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17'

describe('site navigation', () => {
  it('lists the six sections in rail order, four of them on the phone bar', () => {
    expect(siteNav.map((entry) => entry.section)).toEqual([
      'chat',
      'overview',
      'changes',
      'runs',
      'database',
      'settings',
    ])
    expect(siteNav.filter((entry) => entry.primary)).toHaveLength(4)
  })

  it.each([
    [`/projects/${id}/chat`, 'chat'],
    [`/projects/${id}/chat/new`, 'chat'],
    [`/projects/${id}/runs/42`, 'runs'],
    [`/projects/${id}/settings`, 'settings'],
  ] as const)('lights the section of %s', (path, section) => {
    expect(activeSiteSection(path, id)).toBe(section)
  })

  it.each([`/projects/${id}`, `/projects/${id}/unknown`, `/projects/${id}x/chat`, '/projects'])(
    'lights nothing for %s',
    (path) => {
      expect(activeSiteSection(path, id)).toBeUndefined()
    },
  )

  it('knows the section of an address that spells the id in upper case', () => {
    const path = `/projects/${id.toUpperCase()}/chat/new`
    expect(activeSiteSection(path, id)).toBe('chat')
    expect(siteItemOpen(path, id)).toBe(false)
    expect(siteItemOpen(`/projects/${id.toUpperCase()}/chat/42`, id)).toBe(true)
  })

  it('gives the panel of changes to a dialog opened from the list, and to nothing else', () => {
    expect(sitePaneOpen(`/projects/${id}/chat/0199a3f2-0000-7000-8000-000000000001`, id)).toBe(true)
    for (const path of [
      `/projects/${id}/chat`,
      `/projects/${id}/chat/new`,
      `/projects/${id}/runs/42`,
      `/projects/${id}/settings`,
    ])
      expect(sitePaneOpen(path, id)).toBe(false)
  })

  it('builds the address of a section', () => {
    expect(siteHref(id, 'database')).toBe(`/projects/${id}/database`)
    expect(siteHref(id)).toBe(`/projects/${id}`)
  })

  it('leads the link of the chat to a new dialog and of the other sections to themselves', () => {
    expect(siteEntryHref(id, 'chat')).toBe(`/projects/${id}/chat/new`)
    expect(siteEntryHref(id, 'settings')).toBe(`/projects/${id}/settings`)
  })

  it('lays only the chat out as a list beside the content', () => {
    expect(siteNav.map((entry) => entry.section).filter(hasSiteList)).toEqual(['chat'])
    expect(hasSiteList(undefined)).toBe(false)
  })

  it.each([
    [`/projects/${id}/chat/new`, false],
    [`/projects/${id}/chat/new/`, false],
    [`/projects/${id}/chat/42`, true],
    [`/projects/${id}/chat`, false],
    [`/projects/${id}/chat/`, false],
    [`/projects/${id}/runs/42`, false],
    [`/projects/${id}/settings`, false],
    [`/projects/${id}`, false],
  ] as const)('knows whether %s is an item opened from a list', (path, open) => {
    expect(siteItemOpen(path, id)).toBe(open)
  })

  it.each([
    ['onboarding', 'overview'],
    ['active', 'chat'],
    ['paused', 'overview'],
    ['disconnected', 'overview'],
    ['archived', 'overview'],
    // A status this code does not know yet is treated as a working site.
    ['something-new', 'chat'],
  ] as const)('leads the address of a %s site to «%s»', (status, section) => {
    expect(siteLanding(status)).toBe(section)
  })

  it.each(['paused', 'disconnected', 'archived'])(
    'opens only the overview of a %s site and says why',
    (status) => {
      expect(availableSiteSections(status)).toEqual(['overview'])
      expect(siteSectionAvailable(status, 'overview')).toBe(true)
      for (const { section } of siteNav.filter((entry) => entry.section !== 'overview')) {
        expect(siteSectionAvailable(status, section)).toBe(false)
      }
      expect(closedSectionsNote(status)).toMatch(/остальные разделы сайта недоступны\.$/)
    },
  )

  it.each(['onboarding', 'active', 'something-new', 'toString', ''])(
    'opens every section of a %s site',
    (status) => {
      expect(availableSiteSections(status)).toEqual(siteNav.map((entry) => entry.section))
      expect(closedSectionsNote(status)).toBeUndefined()
    },
  )

  it('names a reason of its own for each status that closes the sections', () => {
    expect(closedSectionsNote('paused')).toBe(
      'Пока работа приостановлена, остальные разделы сайта недоступны.',
    )
    expect(closedSectionsNote('disconnected')).toBe(
      'Пока связи с сайтом нет, остальные разделы сайта недоступны.',
    )
    expect(closedSectionsNote('archived')).toBe(
      'Пока сайт в архиве, остальные разделы сайта недоступны.',
    )
  })
})
