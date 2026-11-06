import { describe, expect, it } from 'vitest'

import {
  activeSiteSection,
  availableSiteSections,
  closedSectionsNote,
  hasSiteList,
  inSiteSetup,
  siteHref,
  siteItemOpen,
  siteNav,
  siteSectionAvailable,
} from './site-nav'

const id = '0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17'

describe('site navigation', () => {
  it('lists the six sections in rail order, three of them on the phone bar', () => {
    expect(siteNav.map((entry) => entry.section)).toEqual([
      'overview',
      'changes',
      'runs',
      'database',
      'vault',
      'settings',
    ])
    expect(siteNav.filter((entry) => entry.primary)).toHaveLength(3)
  })

  it.each([
    [`/projects/${id}/runs/42`, 'runs'],
    [`/projects/${id}/vault`, 'vault'],
    [`/projects/${id}/settings`, 'settings'],
  ] as const)('lights the section of %s', (path, section) => {
    expect(activeSiteSection(path, id)).toBe(section)
  })

  it.each([`/projects/${id}`, `/projects/${id}/unknown`, `/projects/${id}x/runs`, '/projects'])(
    'lights nothing for %s',
    (path) => {
      expect(activeSiteSection(path, id)).toBeUndefined()
    },
  )

  it('knows the section of an address that spells the id in upper case', () => {
    const path = `/projects/${id.toUpperCase()}/runs`
    expect(activeSiteSection(path, id)).toBe('runs')
    expect(siteItemOpen(path, id)).toBe(false)
    expect(siteItemOpen(`/projects/${id.toUpperCase()}/runs/42`, id)).toBe(true)
  })

  it('builds the address of a section', () => {
    expect(siteHref(id, 'database')).toBe(`/projects/${id}/database`)
    expect(siteHref(id)).toBe(`/projects/${id}`)
  })

  it('lays the changes and the runs out as a list beside the content', () => {
    expect(siteNav.map((entry) => entry.section).filter(hasSiteList)).toEqual([
      'changes',
      'runs',
      'database',
      'vault',
      'settings',
    ])
    expect(hasSiteList(undefined)).toBe(false)
  })

  it.each([
    [`/projects/${id}/runs/42`, true],
    [`/projects/${id}/runs`, false],
    [`/projects/${id}/runs/`, false],
    [`/projects/${id}/changes/initial`, true],
    [`/projects/${id}/database/backups`, true],
    [`/projects/${id}/vault`, false],
    [`/projects/${id}/settings`, false],
    [`/projects/${id}/settings/danger`, true],
    [`/projects/${id}`, false],
  ] as const)('knows whether %s is an item opened from a list', (path, open) => {
    expect(siteItemOpen(path, id)).toBe(open)
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

  it.each(['pending', 'failed'] as const)(
    'opens only the overview of a site whose setup is %s, whatever its status',
    (setup) => {
      expect(inSiteSetup(setup)).toBe(true)
      for (const status of ['onboarding', 'active', 'paused']) {
        expect(availableSiteSections(status, setup)).toEqual(['overview'])
        expect(siteSectionAvailable(status, 'runs', setup)).toBe(false)
        expect(siteSectionAvailable(status, 'overview', setup)).toBe(true)
      }
    },
  )

  it.each(['done', null, undefined] as const)(
    'leaves the sections of a site whose setup is %s to its status',
    (setup) => {
      expect(inSiteSetup(setup)).toBe(false)
      expect(availableSiteSections('onboarding', setup)).toEqual(
        siteNav.map((entry) => entry.section),
      )
      expect(availableSiteSections('paused', setup)).toEqual(['overview'])
    },
  )
})
