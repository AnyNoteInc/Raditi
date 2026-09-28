'use client'

import { createAuthClient } from 'better-auth/react'
import { createContext, use, useMemo, useState, type ReactNode } from 'react'

/** Same header the SmartCaptcha plugin of @repo/auth reads (CAPTCHA_HEADER). */
const CAPTCHA_HEADER = 'x-captcha-response'

export function captchaHeaders(token: string | null): Record<string, string> {
  return token ? { [CAPTCHA_HEADER]: token } : {}
}

function createWebAuthClient(appUrl: string) {
  // better-auth appends its base path (/api/auth) to the origin.
  return createAuthClient({ baseURL: appUrl })
}

export type WebAuthClient = ReturnType<typeof createWebAuthClient>

interface AuthUi {
  authClient: WebAuthClient
  /** undefined: SmartCaptcha is off (local development, e2e). */
  captchaSiteKey: string | undefined
}

const AuthUiContext = createContext<AuthUi | null>(null)

/**
 * Settings the server reads at request time (APP_URL, SMARTCAPTCHA_CLIENT_KEY) for the sign-in
 * forms, so no NEXT_PUBLIC_ variable is baked into the bundle.
 */
export function AuthUiProvider({
  appUrl,
  captchaSiteKey,
  children,
}: {
  appUrl: string
  captchaSiteKey: string | undefined
  children: ReactNode
}) {
  const [authClient] = useState(() => createWebAuthClient(appUrl))
  const value = useMemo(() => ({ authClient, captchaSiteKey }), [authClient, captchaSiteKey])
  return <AuthUiContext value={value}>{children}</AuthUiContext>
}

export function useAuthUi(): AuthUi {
  const value = use(AuthUiContext)
  if (!value) throw new Error('useAuthUi must be used inside AuthUiProvider')
  return value
}
