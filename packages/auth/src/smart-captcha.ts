import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { z } from 'zod'

import { clientIp } from './request-meta.ts'

/** Same header as the built-in better-auth captcha plugin. */
export const CAPTCHA_HEADER = 'x-captcha-response'
export const SMARTCAPTCHA_VALIDATE_URL = 'https://smartcaptcha.cloud.yandex.ru/validate'

/** Endpoints that create accounts, check passwords or send letters. */
export const CAPTCHA_PATHS = [
  '/sign-up/email',
  '/sign-in/email',
  '/request-password-reset',
  '/send-verification-email',
] as const

const DEFAULT_TIMEOUT_MS = 3000
// A real token is a few hundred characters; anything far longer is not worth sending on.
const TOKEN_MAX = 4096

export const SMART_CAPTCHA_ERROR_CODES = {
  CAPTCHA_REQUIRED: { code: 'CAPTCHA_REQUIRED', message: 'Подтвердите, что вы не робот' },
  CAPTCHA_FAILED: {
    code: 'CAPTCHA_FAILED',
    message: 'Проверка не пройдена, попробуйте ещё раз',
  },
} as const

const validateResponseSchema = z.object({
  status: z.enum(['ok', 'failed']),
  message: z.string().optional(),
  host: z.string().optional(),
})

export type CaptchaVerdict =
  | { kind: 'pass' }
  | { kind: 'fail'; reason: string }
  /** Yandex could not answer: the request is let through. */
  | { kind: 'unavailable'; reason: string }

export interface ValidateSmartCaptchaInput {
  serverKey: string
  token: string
  ip?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

/**
 * Checks a token with Yandex. Yandex advises letting users through on any failure, but a
 * wrong server key answers 403, and failing open there would silently switch the captcha
 * off; so only transport trouble (network, timeout, 5xx, 429) counts as unavailable.
 */
export async function validateSmartCaptcha(
  input: ValidateSmartCaptchaInput,
): Promise<CaptchaVerdict> {
  const { serverKey, token, ip, timeoutMs = DEFAULT_TIMEOUT_MS } = input
  const fetchImpl = input.fetch ?? fetch
  const body = new URLSearchParams({ secret: serverKey, token })
  if (ip) body.set('ip', ip)

  let response: Response
  try {
    response = await fetchImpl(SMARTCAPTCHA_VALIDATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.name : 'network' }
  }
  if (response.status >= 500 || response.status === 429) {
    return { kind: 'unavailable', reason: `http_${response.status}` }
  }
  if (!response.ok) return { kind: 'fail', reason: `http_${response.status}` }

  const parsed = validateResponseSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) return { kind: 'fail', reason: 'bad_body' }
  // `message` is diagnostics only; Yandex asks not to branch on it.
  return parsed.data.status === 'ok' ? { kind: 'pass' } : { kind: 'fail', reason: 'failed' }
}

export interface SmartCaptchaOptions {
  serverKey: string
  timeoutMs?: number
  /** Replaces the global fetch, e.g. in tests. */
  fetch?: typeof fetch
}

/**
 * Yandex SmartCaptcha for better-auth (it supports only foreign providers). Works in
 * hooks.before, so it covers both HTTP requests and auth.api.* calls from server code;
 * register it first so it runs before other plugins' hooks.
 */
export const smartCaptcha = (options: SmartCaptchaOptions) => {
  const paths = new Set<string>(CAPTCHA_PATHS)
  return {
    id: 'smart-captcha',
    $ERROR_CODES: SMART_CAPTCHA_ERROR_CODES,
    hooks: {
      before: [
        {
          matcher: (context) => context.path !== undefined && paths.has(context.path),
          handler: createAuthMiddleware(async (ctx) => {
            // No bypass for calls without a request: server code that signs users up must
            // pass the client's headers, token included (AnyNote lost the captcha that way).
            const headers = ctx.headers ?? ctx.request?.headers
            const token = headers?.get(CAPTCHA_HEADER)?.trim()
            if (!token) {
              throw APIError.from('BAD_REQUEST', SMART_CAPTCHA_ERROR_CODES.CAPTCHA_REQUIRED)
            }
            // Logs carry the path and the reason, never the token.
            const { logger } = ctx.context
            if (token.length > TOKEN_MAX) {
              logger.warn('SmartCaptcha check failed', { path: ctx.path, reason: 'token_too_long' })
              throw APIError.from('FORBIDDEN', SMART_CAPTCHA_ERROR_CODES.CAPTCHA_FAILED)
            }

            const ip = clientIp(ctx.request ?? headers) ?? undefined
            const verdict = await validateSmartCaptcha({ ...options, token, ip })
            if (verdict.kind === 'pass') return

            const log = { path: ctx.path, reason: verdict.reason }
            if (verdict.kind === 'unavailable') {
              logger.warn('SmartCaptcha is unavailable, letting the request through', log)
              return
            }
            if (verdict.reason.startsWith('http_')) {
              // A 4xx from Yandex rejects every visitor: louder than a failed check.
              logger.error('SmartCaptcha refused the check: is SMARTCAPTCHA_SERVER_KEY right?', log)
            } else {
              logger.warn('SmartCaptcha check failed', log)
            }
            throw APIError.from('FORBIDDEN', SMART_CAPTCHA_ERROR_CODES.CAPTCHA_FAILED)
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
