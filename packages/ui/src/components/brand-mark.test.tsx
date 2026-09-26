import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { BrandMark } from './brand-mark.tsx'

describe('BrandMark', () => {
  it('is announced once as «Радити», with or without the wordmark', () => {
    const { rerender } = render(<BrandMark />)
    expect(screen.getByRole('img', { name: 'Радити' })).toHaveTextContent('Радити')

    rerender(<BrandMark withWordmark={false} />)
    expect(screen.getByRole('img', { name: 'Радити' })).toHaveTextContent('')
  })
})
