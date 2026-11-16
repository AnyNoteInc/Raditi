// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BrowserPushControl } from './browser-push-control'
import type * as UseBrowserPush from './use-browser-push'
import { browserPushText, type BrowserPush } from './use-browser-push'

const push = vi.hoisted(() => ({
  current: null as unknown as BrowserPush,
}))

vi.mock('./use-browser-push', async (importOriginal) => ({
  ...(await importOriginal<typeof UseBrowserPush>()),
  useBrowserPush: () => push.current,
}))

function given(change: Partial<BrowserPush>): BrowserPush {
  push.current = {
    state: 'off',
    device: null,
    endpoint: null,
    otherBrowsers: 0,
    working: false,
    problem: null,
    enable: vi.fn(async () => true),
    disable: vi.fn(async () => true),
    ...change,
  }
  return push.current
}

afterEach(() => vi.clearAllMocks())

describe('«Включить в этом браузере» (docs/plan/82, Зп36)', () => {
  it('turns notifications on from the click and says when it is done', async () => {
    const state = given({ state: 'off' })
    const onEnabled = vi.fn()
    render(<BrowserPushControl onEnabled={onEnabled} />)
    fireEvent.click(screen.getByRole('button', { name: browserPushText.enable }))
    expect(state.enable).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onEnabled).toHaveBeenCalledTimes(1))
  })

  it('tells a failure under the button and waits while it works', () => {
    given({ state: 'off', working: true, problem: browserPushText.enableFailed })
    render(<BrowserPushControl />)
    expect(screen.getByRole('button', { name: browserPushText.enable })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(browserPushText.enableFailed)
  })

  it('shows nothing when on, or the short line when asked', () => {
    given({ state: 'on' })
    const { container, rerender } = render(<BrowserPushControl />)
    expect(container).toBeEmptyDOMElement()
    rerender(<BrowserPushControl whenOn="line" />)
    expect(screen.getByText(browserPushText.on)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says it is on where it was turned on, in the same live region, and keeps the focus there', async () => {
    const state = given({ state: 'off' })
    const { rerender } = render(<BrowserPushControl />)
    const button = screen.getByRole('button', { name: browserPushText.enable })
    const region = button.closest('[aria-live="polite"]')
    button.focus()
    fireEvent.click(button)
    await waitFor(() => expect(state.enable).toHaveBeenCalledTimes(1))
    // The browser and the cabinet answered: this browser takes notifications now.
    given({ state: 'on' })
    rerender(<BrowserPushControl />)
    const line = screen.getByText(browserPushText.on)
    expect(line.closest('[aria-live="polite"]')).toBe(region)
    expect(line).toHaveFocus()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('tells where it went instead of on, and keeps the focus there', async () => {
    const state = given({ state: 'off', enable: vi.fn(async () => false) })
    const { rerender } = render(<BrowserPushControl />)
    const button = screen.getByRole('button', { name: browserPushText.enable })
    button.focus()
    fireEvent.click(button)
    await waitFor(() => expect(state.enable).toHaveBeenCalledTimes(1))
    given({ state: 'denied' })
    rerender(<BrowserPushControl />)
    expect(screen.getByText(browserPushText.denied)).toHaveFocus()
  })

  it('does not take the focus the client moved elsewhere', async () => {
    const state = given({ state: 'off' })
    const { rerender } = render(
      <>
        <BrowserPushControl />
        <input aria-label="Название" />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: browserPushText.enable }))
    await waitFor(() => expect(state.enable).toHaveBeenCalledTimes(1))
    const field = screen.getByRole('textbox', { name: 'Название' })
    field.focus()
    given({ state: 'on' })
    rerender(
      <>
        <BrowserPushControl />
        <input aria-label="Название" />
      </>,
    )
    expect(screen.getByText(browserPushText.on)).toBeInTheDocument()
    expect(field).toHaveFocus()
  })

  it('shows nothing while it reads the browser', () => {
    given({ state: 'loading' })
    const { container } = render(<BrowserPushControl whenOn="line" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says why it cannot be turned on here, without a button', () => {
    const { rerender } = render(<BrowserPushControl />)
    for (const [state, device, text] of [
      ['unsupported', null, browserPushText.unsupported],
      ['denied', null, browserPushText.denied],
      ['ios_install', 'iphone', browserPushText.iosInstall('iphone')],
    ] as const) {
      given({ state, device })
      rerender(<BrowserPushControl />)
      expect(screen.getByText(text)).toBeInTheDocument()
      expect(screen.queryByRole('button')).toBeNull()
    }
  })
})
