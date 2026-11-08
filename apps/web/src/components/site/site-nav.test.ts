import { describe, expect, it } from 'vitest'

import {
  activeSiteSection,
  availableSiteSections,
  closedSectionsNote,
  inSiteSetup,
  siteHref,
  siteNav,
  siteSectionAvailable,
} from './site-nav'

const id = '0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17'

describe('site navigation', () => {
  it('lists the six sections in the order of the panel', () => {
    expect(siteNav.map((entry) => [entry.section, entry.label])).toEqual([
      ['overview', 'Обзор'],
      ['changes', 'Изменения'],
      ['runs', 'Запуски'],
      ['database', 'База'],
      ['vault', 'Переменные'],
      ['settings', 'Настройки'],
    ])
  })

  it.each([
    [`/projects/${id}/runs/42`, 'runs'],
    [`/projects/${id}/vault`, 'vault'],
    [`/projects/${id}/changes/versions`, 'changes'],
    [`/projects/${id}/settings`, 'settings'],
  ] as const)('lights the section of %s', (path, section) => {
    expect(activeSiteSection(path, id)).toBe(section)
  })

  it.each([
    `/projects/${id}`,
    `/projects/${id}/terminal`,
    `/projects/${id}/unknown`,
    `/projects/${id}x/runs`,
    '/projects',
  ])('lights nothing for %s', (path) => {
    expect(activeSiteSection(path, id)).toBeUndefined()
  })

  it('knows the section of an address that spells the id in upper case', () => {
    const path = `/projects/${id.toUpperCase()}/runs`
    expect(activeSiteSection(path, id)).toBe('runs')
  })

  it('builds the address of a section', () => {
    expect(siteHref(id, 'database')).toBe(`/projects/${id}/database`)
    expect(siteHref(id)).toBe(`/projects/${id}`)
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
