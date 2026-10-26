// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { SiteMark, siteFaviconHref } from './site-mark'

const siteId = '0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17'

function showMark() {
  const { container } = render(<SiteMark siteId={siteId} name="Кофейня «Крошка»" mark="к" />)
  const tile = screen.getByRole('img', { name: 'Сайт Кофейня «Крошка»' })
  return { tile, image: () => container.querySelector('img') }
}

describe('the mark of a site', () => {
  it('asks the cabinet for the icon, never the site, and keeps the letter until it loads', () => {
    const { tile, image } = showMark()
    expect(image()?.getAttribute('src')).toBe(`/api/projects/${siteId}/favicon`)
    expect(image()?.getAttribute('alt')).toBe('')
    expect(tile.textContent).toBe('к')
    expect(siteFaviconHref(siteId)).toBe(`/api/projects/${siteId}/favicon`)
  })

  it('shows the icon once it has loaded, the letter gone', () => {
    const { tile, image } = showMark()
    fireEvent.load(image()!)
    expect(tile.textContent).toBe('')
    expect(image()?.style.opacity).toBe('1')
  })

  it('keeps the letter of a site without an icon', () => {
    const { tile, image } = showMark()
    fireEvent.error(image()!)
    expect(image()).toBeNull()
    expect(tile.textContent).toBe('к')
  })
})
