// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ServiceUnavailable } from './service-unavailable'

describe('ServiceUnavailable', () => {
  it('speaks of the cabinet: it stands in for the chats as well as for the projects', () => {
    render(<ServiceUnavailable />)

    expect(
      screen.getByRole('heading', { level: 1, name: 'Кабинет временно недоступен' }),
    ).toBeInTheDocument()
  })
})
