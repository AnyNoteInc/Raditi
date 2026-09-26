// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { mdxComponents } from './mdx-components'

const Anchor = mdxComponents.a as ComponentType<{ href?: string; children: ReactNode }>

describe('links in legal texts', () => {
  it('opens other sites in a new tab without opener access', () => {
    render(<Anchor href="https://yookassa.ru/developers">ЮKassa</Anchor>)
    const link = screen.getByRole('link', { name: 'ЮKassa' })
    expect(link).toHaveAttribute('href', 'https://yookassa.ru/developers')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('turns raditi.ru addresses into site paths', () => {
    render(<Anchor href="https://raditi.ru/terms/consent">согласие</Anchor>)
    const link = screen.getByRole('link', { name: 'согласие' })
    expect(link).toHaveAttribute('href', '/terms/consent')
    expect(link).not.toHaveAttribute('target')
  })

  it('keeps mail links as they are', () => {
    render(<Anchor href="mailto:support@raditi.ru">почта</Anchor>)
    const link = screen.getByRole('link', { name: 'почта' })
    expect(link).toHaveAttribute('href', 'mailto:support@raditi.ru')
    expect(link).not.toHaveAttribute('target')
  })
})
