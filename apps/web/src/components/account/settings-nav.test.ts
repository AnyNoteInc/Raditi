import { describe, expect, it } from 'vitest'

import {
  activeSettingsEntry,
  settingsEntryFor,
  settingsNav,
  type SettingsNavEntry,
} from './settings-nav'

const everySection: SettingsNavEntry[] = settingsNav.map((entry) => ({ ...entry, enabled: true }))
const active = (pathname: string, entries: readonly SettingsNavEntry[] = everySection) =>
  activeSettingsEntry(pathname, entries)?.href

describe('settings navigation', () => {
  it('declares the four sections in sidebar order', () => {
    expect(settingsNav.map(({ href, label, icon }) => [href, label, icon])).toEqual([
      ['/settings', 'Общее', 'settings'],
      ['/settings/plans', 'Тарифы', 'plans'],
      ['/settings/billing', 'Оплата', 'payment'],
      ['/settings/usage', 'Использование', 'usage'],
    ])
  })

  it('shows only the sections whose pages exist', () => {
    expect(settingsNav.filter((entry) => entry.enabled).map((entry) => entry.label)).toEqual([
      'Общее',
      'Тарифы',
      'Оплата',
      'Использование',
    ])
  })
})

describe('activeSettingsEntry', () => {
  it.each([
    ['/settings', '/settings'],
    ['/settings/', '/settings'],
    ['/settings/plans', '/settings/plans'],
    ['/settings/billing', '/settings/billing'],
    ['/settings/billing/return', '/settings/billing'],
    ['/settings/usage', '/settings/usage'],
  ])('takes %s as a page of %s', (pathname, href) => {
    expect(active(pathname)).toBe(href)
  })

  it('prefers the longest matching section, whatever the order of the entries', () => {
    expect(active('/settings/billing/return', [...everySection].reverse())).toBe(
      '/settings/billing',
    )
  })

  it('matches whole path segments only', () => {
    expect(active('/settings-old')).toBeUndefined()
    expect(active('/settingsplans')).toBeUndefined()
  })

  it('gives a path under /settings that no other section claims to «Общее»', () => {
    expect(active('/settings/billing-x')).toBe('/settings')
    expect(active('/settings/unknown/deep')).toBe('/settings')
  })

  it.each(['/', '/projects', '/profile', ''])('has no active section on %s', (pathname) => {
    expect(active(pathname)).toBeUndefined()
  })

  it('never reports a section that is switched off, nor its parent instead of it', () => {
    const plansOff = everySection.map((entry) =>
      entry.href === '/settings/plans' ? { ...entry, enabled: false } : entry,
    )

    expect(active('/settings/plans', plansOff)).toBeUndefined()
    expect(active('/settings/plans/compare', plansOff)).toBeUndefined()
    expect(active('/settings', plansOff)).toBe('/settings')
  })
})

describe('settingsEntryFor', () => {
  it('names the section of a page even while the section is switched off', () => {
    const billingOff = everySection.map((entry) =>
      entry.href === '/settings/billing' ? { ...entry, enabled: false } : entry,
    )

    expect(settingsEntryFor('/settings/billing', billingOff)?.label).toBe('Оплата')
    expect(settingsEntryFor('/settings/billing/return', billingOff)?.label).toBe('Оплата')
    expect(activeSettingsEntry('/settings/billing/return', billingOff)).toBeUndefined()
  })

  it('agrees with the sidebar on the sections that are switched on', () => {
    for (const pathname of ['/settings', '/settings/plans/compare', '/settings/billing-x']) {
      expect(settingsEntryFor(pathname, everySection)).toBe(
        activeSettingsEntry(pathname, everySection),
      )
    }
  })

  it.each(['/', '/projects', '/settings-old', ''])('has no section for %s', (pathname) => {
    expect(settingsEntryFor(pathname, everySection)).toBeUndefined()
  })
})
