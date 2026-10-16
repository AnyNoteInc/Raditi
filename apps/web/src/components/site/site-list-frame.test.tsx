// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SiteListFrame } from './site-list-frame'

const mocks = vi.hoisted(() => ({ segment: null as string | null }))

vi.mock('next/navigation', () => ({ useSelectedLayoutSegment: () => mocks.segment }))

const root = '/projects/0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17/chat'

function showFrame(segment: string | null, action = true) {
  mocks.segment = segment
  render(
    <SiteListFrame
      label="Диалоги"
      title="Чат"
      root={root}
      action={action ? { segment: 'new', label: 'Новый диалог' } : undefined}
      backLabel="Назад к диалогам"
      list={<p>Диалогов пока нет</p>}
    >
      <p>Содержимое</p>
    </SiteListFrame>,
  )
}

const list = () => screen.getByRole('navigation', { name: 'Диалоги' })

describe('site list frame', () => {
  it('heads the page with the list at the root of the section', () => {
    showFrame(null)
    expect(within(list()).getByRole('heading', { level: 1, name: 'Чат' })).toBeTruthy()
    expect(within(list()).getByText('Диалогов пока нет')).toBeTruthy()
    expect(screen.getByText('Содержимое')).toBeTruthy()
  })

  it('offers the action of the list and does not mark it at the root', () => {
    showFrame(null)
    const action = within(list()).getByRole('link', { name: 'Новый диалог' })
    expect(action.getAttribute('href')).toBe(`${root}/new`)
    expect(action.getAttribute('aria-current')).toBeNull()
  })

  it('has no way back at the root: the list is where the way back leads', () => {
    showFrame(null)
    expect(screen.queryByRole('link', { name: 'Назад к диалогам' })).toBeNull()
  })

  it('marks the action on its own address and leaves the page heading to the content', () => {
    showFrame('new')
    expect(
      within(list()).getByRole('link', { name: 'Новый диалог' }).getAttribute('aria-current'),
    ).toBe('page')
    expect(within(list()).getByRole('heading', { level: 2, name: 'Чат' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })

  it('leads back to the list from an item, outside the list itself', () => {
    showFrame('new')
    const back = screen.getByRole('link', { name: 'Назад к диалогам' })
    expect(back.getAttribute('href')).toBe(root)
    expect(list().contains(back)).toBe(false)
  })

  it('does not mark the action on another item', () => {
    showFrame('42')
    expect(
      within(list()).getByRole('link', { name: 'Новый диалог' }).getAttribute('aria-current'),
    ).toBeNull()
    expect(screen.getByRole('link', { name: 'Назад к диалогам' })).toBeTruthy()
  })

  it('is a plain list when the section has no action', () => {
    showFrame(null, false)
    expect(within(list()).queryAllByRole('link')).toEqual([])
  })
})
