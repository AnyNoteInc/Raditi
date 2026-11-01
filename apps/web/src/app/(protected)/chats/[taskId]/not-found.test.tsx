// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import NotFound from './not-found'

describe('the page of a chat the server does not find', () => {
  it('says the chat is gone and leads to the list of chats', () => {
    render(<NotFound />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Такого диалога нет')
    expect(screen.getByRole('link', { name: 'К диалогам' }).getAttribute('href')).toBe('/chats')
  })
})
