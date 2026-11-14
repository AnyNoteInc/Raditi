// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useWaitingTitle, WAITING_TITLE_MARK } from './use-waiting-title'

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

describe('the title of a hidden tab (docs/plan/75, ВВ11)', () => {
  afterEach(() => setVisibility('visible'))

  it('says the agent answered while hidden, and comes back when the tab is shown', () => {
    document.title = 'Цена капучино — Радити'
    setVisibility('hidden')
    const view = renderHook(({ status }) => useWaitingTitle(status), {
      initialProps: { status: 'running' as const } as { status: 'running' | 'awaiting_user' },
    })
    view.rerender({ status: 'awaiting_user' })
    expect(document.title).toBe(`${WAITING_TITLE_MARK}Цена капучино — Радити`)
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(document.title).toBe('Цена капучино — Радити')
  })

  it('leaves the title of a tab the client looks at', () => {
    document.title = 'Чат — Радити'
    const view = renderHook(({ status }) => useWaitingTitle(status), {
      initialProps: { status: 'running' as const } as { status: 'running' | 'awaiting_user' },
    })
    view.rerender({ status: 'awaiting_user' })
    expect(document.title).toBe('Чат — Радити')
  })
})
