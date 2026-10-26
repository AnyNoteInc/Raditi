// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { segment } = vi.hoisted(() => ({ segment: { current: null as string | null } }))
vi.mock('next/navigation', () => ({ useSelectedLayoutSegment: () => segment.current }))

import { SiteBlockNav } from './site-block-nav'
import { siteHref } from './site-nav'
import { vaultBlocks } from './vault-blocks'

const siteId = '0199a3f2-0000-7000-8000-00000000000a'
const root = siteHref(siteId, 'vault')

beforeEach(() => {
  segment.current = null
})

describe('the menu of a section split by its cards', () => {
  it('links every block, with what it holds, and marks the first one at the root', () => {
    render(<SiteBlockNav root={root} blocks={vaultBlocks([{ kind: 'ssh' }, { kind: 'db' }])} />)
    const variables = screen.getByRole('link', { name: /Переменные окружения/ })
    const accesses = screen.getByRole('link', { name: /Доступы/ })
    expect(variables.getAttribute('href')).toBe(`${root}/variables`)
    expect(accesses.getAttribute('href')).toBe(`${root}/accesses`)
    expect(accesses.textContent).toContain('SSH · База данных')
    // The root page shows the first block, so the menu says that one is open.
    expect(variables.getAttribute('aria-current')).toBe('page')
    expect(accesses.getAttribute('aria-current')).toBeNull()
  })

  it('marks the block whose page is open', () => {
    segment.current = 'accesses'
    render(<SiteBlockNav root={root} blocks={vaultBlocks([])} />)
    expect(screen.getByRole('link', { name: /Доступы/ }).getAttribute('aria-current')).toBe('page')
    expect(
      screen.getByRole('link', { name: /Переменные окружения/ }).getAttribute('aria-current'),
    ).toBeNull()
  })

  it('says when no access is saved and when the list could not be read', () => {
    expect(vaultBlocks([])[1]!.note).toBe('Доступов пока нет')
    expect(vaultBlocks(null)[1]!.note).toBe('Не удалось загрузить')
    // One kind is named once, however many references it has.
    expect(vaultBlocks([{ kind: 'db' }, { kind: 'db' }])[1]!.note).toBe('База данных')
  })
})
