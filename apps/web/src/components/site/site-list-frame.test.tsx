// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SiteListFrame } from './site-list-frame'

const mocks = vi.hoisted(() => ({ segment: null as string | null }))

vi.mock('next/navigation', () => ({ useSelectedLayoutSegment: () => mocks.segment }))

const root = '/projects/0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17/runs'

function showFrame(segment: string | null) {
  mocks.segment = segment
  render(
    <SiteListFrame
      label="Запуски"
      title="Запуски"
      root={root}
      backLabel="Назад к запускам"
      list={<p>Запусков пока нет</p>}
    >
      <p>Содержимое</p>
    </SiteListFrame>,
  )
}

const list = () => screen.getByRole('navigation', { name: 'Запуски' })

describe('site list frame', () => {
  it('heads the page with the list at the root of the section', () => {
    showFrame(null)
    expect(within(list()).getByRole('heading', { level: 1, name: 'Запуски' })).toBeTruthy()
    expect(within(list()).getByText('Запусков пока нет')).toBeTruthy()
    expect(screen.getByText('Содержимое')).toBeTruthy()
  })

  it('has no way back at the root: the list is where the way back leads', () => {
    showFrame(null)
    expect(screen.queryByRole('link', { name: 'Назад к запускам' })).toBeNull()
  })

  it('leaves the page heading to the content of an item', () => {
    showFrame('new')
    expect(within(list()).getByRole('heading', { level: 2, name: 'Запуски' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })

  it('leads back to the list from an item, outside the list itself', () => {
    showFrame('new')
    const back = screen.getByRole('link', { name: 'Назад к запускам' })
    expect(back.getAttribute('href')).toBe(root)
    expect(list().contains(back)).toBe(false)
  })

  it('is a plain list', () => {
    showFrame(null)
    expect(within(list()).queryAllByRole('link')).toEqual([])
  })
})
