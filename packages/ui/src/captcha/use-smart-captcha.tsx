'use client'

import { InvisibleSmartCaptcha, type InvisibleSmartCaptchaProps } from '@yandex/smart-captcha'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { CaptchaError, type CaptchaFailureReason } from './captcha-error.ts'

/** Give up when captcha.js is still missing after this long (blocked or unreachable). */
export const CAPTCHA_LOAD_TIMEOUT_MS = 15_000
/** `challenge-hidden` may arrive just before `success` when a challenge is solved. */
export const CAPTCHA_HIDDEN_GRACE_MS = 500

type Pending = {
  resolve: (token: string) => void
  reject: (error: CaptchaError) => void
}

type Outcome = { token: string } | { reason: CaptchaFailureReason }

export type SmartCaptchaOptions = {
  theme?: InvisibleSmartCaptchaProps['theme']
  shieldPosition?: InvisibleSmartCaptchaProps['shieldPosition']
}

export type SmartCaptchaHandle = {
  /**
   * Resolves with a single-use token for the `x-captcha-response` header, or with null when
   * captcha is off (no site key: local development, e2e). Rejects with `CaptchaError`.
   */
  execute: () => Promise<string | null>
  /** Render it once on the page. The data-processing notice (shield) must stay visible. */
  widget: ReactNode
}

function isCaptchaScriptLoaded(): boolean {
  return typeof window !== 'undefined' && 'smartCaptcha' in window
}

/** Invisible Yandex SmartCaptcha: a challenge is shown only to visitors Yandex finds suspicious. */
export function useSmartCaptcha(
  siteKey: string | undefined,
  options: SmartCaptchaOptions = {},
): SmartCaptchaHandle {
  const { theme = 'auto', shieldPosition } = options
  const [visible, setVisible] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const pendingRef = useRef<Pending | null>(null)
  const loadTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const hiddenTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const clearTimers = useCallback(() => {
    clearTimeout(loadTimerRef.current)
    clearTimeout(hiddenTimerRef.current)
  }, [])

  const settle = useCallback(
    (outcome: Outcome) => {
      const pending = pendingRef.current
      if (!pending) return
      pendingRef.current = null
      clearTimers()
      setVisible(false)
      // Tokens are single-use: the next attempt gets a fresh widget.
      setAttempt((n) => n + 1)
      if ('token' in outcome) pending.resolve(outcome.token)
      else pending.reject(new CaptchaError(outcome.reason))
    },
    [clearTimers],
  )

  const execute = useCallback((): Promise<string | null> => {
    if (!siteKey) return Promise.resolve(null)
    const previous = pendingRef.current
    if (previous) {
      pendingRef.current = null
      clearTimers()
      setAttempt((n) => n + 1)
      previous.reject(new CaptchaError('superseded'))
    }
    return new Promise<string>((resolve, reject) => {
      pendingRef.current = { resolve, reject }
      // InvisibleSmartCaptcha calls smartCaptcha.execute() once `visible` turns true.
      setVisible(true)
      loadTimerRef.current = setTimeout(() => {
        if (!isCaptchaScriptLoaded()) settle({ reason: 'script' })
      }, CAPTCHA_LOAD_TIMEOUT_MS)
    })
  }, [siteKey, clearTimers, settle])

  const handleSuccess = useCallback((token: string) => settle({ token }), [settle])
  const handleNetworkError = useCallback(() => settle({ reason: 'network' }), [settle])
  // Must stay referentially stable: the loader re-runs its effect whenever it changes.
  const handleJavascriptError = useCallback(() => settle({ reason: 'script' }), [settle])
  const handleChallengeHidden = useCallback(() => {
    if (!pendingRef.current) return
    clearTimeout(hiddenTimerRef.current)
    hiddenTimerRef.current = setTimeout(
      () => settle({ reason: 'cancelled' }),
      CAPTCHA_HIDDEN_GRACE_MS,
    )
  }, [settle])

  useEffect(
    () => () => {
      clearTimers()
      const pending = pendingRef.current
      pendingRef.current = null
      pending?.reject(new CaptchaError('cancelled'))
    },
    [clearTimers],
  )

  const widget = siteKey ? (
    <InvisibleSmartCaptcha
      key={attempt}
      sitekey={siteKey}
      language="ru"
      theme={theme}
      shieldPosition={shieldPosition}
      visible={visible}
      onSuccess={handleSuccess}
      onChallengeHidden={handleChallengeHidden}
      onNetworkError={handleNetworkError}
      onJavascriptError={handleJavascriptError}
    />
  ) : null

  return { execute, widget }
}
