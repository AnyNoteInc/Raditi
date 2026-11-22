// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ShareLanding } from './share-landing'

// The page /a (docs/plan/88-artifacts.md, Ар33; spike 8).

const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

const token = 'B'.repeat(43)
afterEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('the page of a link', () => {
  it('erases the fragment at once and holds the token for a signed-out reader', async () => {
    window.history.replaceState(null, '', `/a#${token}`)
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }))
    render(<ShareLanding open signedIn={false} held={false} />)
    await waitFor(() => expect(window.location.hash).toBe(''))
    expect(fetch).toHaveBeenCalledWith(
      '/api/artifact-share/hold',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ token }) }),
    )
    expect(screen.getByRole('link', { name: 'Войти' }).getAttribute('href')).toBe(
      '/sign-in?next=%2Fa',
    )
    // Neither the owner's name nor a title before the sign-in.
    expect(screen.queryByText(/Ваше имя увидят/)).toBeNull()
  })

  it('opens after the words of consent for a signed-in reader', async () => {
    window.history.replaceState(null, '', `/a#${token}`)
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ artifactId: 'a1' }), { status: 200 }))
    render(<ShareLanding open signedIn held={false} />)
    expect(await screen.findByText(/Ваше имя увидят владелец/)).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Открыть' }))
    })
    expect(fetch).toHaveBeenCalledWith(
      '/api/artifact-share/open',
      expect.objectContaining({ body: JSON.stringify({ token }) }),
    )
    await waitFor(() => expect(push).toHaveBeenCalledWith('/artifacts/a1'))
  })

  it('says links do not work yet where sharing is closed', () => {
    render(<ShareLanding open={false} signedIn held={false} />)
    expect(screen.getByText('Ссылки на артефакты пока не работают.')).toBeTruthy()
  })
})
