import type { InvisibleSmartCaptchaProps } from '@yandex/smart-captcha'
import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CaptchaError, captchaErrorMessage, isCaptchaError } from './captcha-error.ts'
import {
  CAPTCHA_HIDDEN_GRACE_MS,
  CAPTCHA_LOAD_TIMEOUT_MS,
  useSmartCaptcha,
  type SmartCaptchaHandle,
} from './use-smart-captcha.tsx'

const widget = vi.hoisted(() => ({
  mounts: 0,
  props: undefined as InvisibleSmartCaptchaProps | undefined,
}))

vi.mock('@yandex/smart-captcha', async () => {
  const { useEffect } = await import('react')
  return {
    InvisibleSmartCaptcha: (props: InvisibleSmartCaptchaProps) => {
      useEffect(() => {
        widget.props = props
      })
      useEffect(() => {
        widget.mounts += 1
      }, [])
      return null
    },
  }
})

const handle: { current?: SmartCaptchaHandle } = {}

function Harness({ siteKey }: { siteKey?: string }) {
  const captcha = useSmartCaptcha(siteKey)
  useEffect(() => {
    handle.current = captcha
  })
  return captcha.widget
}

type Settled = { token: string | null } | { reason: unknown }

/** Attaches handlers at once, so an early rejection is never reported as unhandled. */
function execute(): Promise<Settled> {
  let promise: Promise<string | null> | undefined
  act(() => {
    promise = handle.current!.execute()
  })
  return promise!.then(
    (token) => ({ token }),
    (error: unknown) => ({ reason: isCaptchaError(error) ? error.reason : error }),
  )
}

const props = () => widget.props!

afterEach(() => {
  vi.useRealTimers()
  widget.mounts = 0
  widget.props = undefined
  handle.current = undefined
  Reflect.deleteProperty(window, 'smartCaptcha')
})

describe('useSmartCaptcha', () => {
  it('returns null and renders nothing without a site key', async () => {
    render(<Harness />)

    await expect(execute()).resolves.toEqual({ token: null })
    expect(widget.mounts).toBe(0)
  })

  it('runs the invisible check and resolves with the token', async () => {
    render(<Harness siteKey="ysc1_test" />)
    expect(props().visible).toBe(false)
    expect(props().language).toBe('ru')

    const result = execute()
    expect(props().visible).toBe(true)
    act(() => props().onSuccess!('token-1'))

    await expect(result).resolves.toEqual({ token: 'token-1' })
  })

  it('mounts a fresh widget for every attempt, since tokens are single-use', async () => {
    render(<Harness siteKey="ysc1_test" />)
    expect(widget.mounts).toBe(1)

    const result = execute()
    act(() => props().onSuccess!('token-1'))
    await result

    expect(widget.mounts).toBe(2)
    expect(props().visible).toBe(false)
  })

  it('rejects when the visitor closes the challenge', async () => {
    vi.useFakeTimers()
    render(<Harness siteKey="ysc1_test" />)

    const result = execute()
    act(() => props().onChallengeHidden!())
    act(() => vi.advanceTimersByTime(CAPTCHA_HIDDEN_GRACE_MS))

    await expect(result).resolves.toEqual({ reason: 'cancelled' })
  })

  it('still resolves when success follows the hidden challenge', async () => {
    vi.useFakeTimers()
    render(<Harness siteKey="ysc1_test" />)

    const result = execute()
    act(() => props().onChallengeHidden!())
    act(() => props().onSuccess!('token-2'))
    act(() => vi.advanceTimersByTime(CAPTCHA_HIDDEN_GRACE_MS))

    await expect(result).resolves.toEqual({ token: 'token-2' })
  })

  it('rejects on a network error', async () => {
    render(<Harness siteKey="ysc1_test" />)

    const result = execute()
    act(() => props().onNetworkError!())

    await expect(result).resolves.toEqual({ reason: 'network' })
  })

  it('never passes the check on a script error', async () => {
    render(<Harness siteKey="ysc1_test" />)

    const result = execute()
    act(() =>
      props().onJavascriptError!({ filename: 'captcha.js', message: 'boom', col: 1, line: 1 }),
    )

    await expect(result).resolves.toEqual({ reason: 'script' })
  })

  it('gives up when captcha.js never loads', async () => {
    vi.useFakeTimers()
    render(<Harness siteKey="ysc1_test" />)

    const result = execute()
    act(() => vi.advanceTimersByTime(CAPTCHA_LOAD_TIMEOUT_MS))

    await expect(result).resolves.toEqual({ reason: 'script' })
  })

  it('keeps waiting for a slow visitor once captcha.js is loaded', async () => {
    vi.useFakeTimers()
    Reflect.set(window, 'smartCaptcha', {})
    render(<Harness siteKey="ysc1_test" />)

    const result = execute()
    act(() => vi.advanceTimersByTime(CAPTCHA_LOAD_TIMEOUT_MS * 2))
    act(() => props().onSuccess!('token-3'))

    await expect(result).resolves.toEqual({ token: 'token-3' })
  })

  it('replaces a pending check with a new one', async () => {
    render(<Harness siteKey="ysc1_test" />)

    const first = execute()
    const second = execute()
    act(() => props().onSuccess!('token-4'))

    await expect(first).resolves.toEqual({ reason: 'superseded' })
    await expect(second).resolves.toEqual({ token: 'token-4' })
  })

  it('rejects a pending check on unmount', async () => {
    const view = render(<Harness siteKey="ysc1_test" />)

    const result = execute()
    view.unmount()

    await expect(result).resolves.toEqual({ reason: 'cancelled' })
  })
})

describe('captchaErrorMessage', () => {
  it('explains failures in Russian and stays silent for a superseded attempt', () => {
    expect(captchaErrorMessage(new CaptchaError('network'))).toMatch(/подключение к интернету/)
    expect(captchaErrorMessage(new CaptchaError('superseded'))).toBeNull()
    expect(captchaErrorMessage(new Error('unknown'))).toBe(
      'Не удалось пройти проверку. Попробуйте ещё раз.',
    )
  })
})
