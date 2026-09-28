import { describe, expect, it } from 'vitest'

import {
  GENERIC_AUTH_ERROR,
  INVALID_LINK_ERROR,
  linkErrorMessage,
  mapAuthError,
  RATE_LIMITED_ERROR,
} from './auth-errors'

const signUpFields = ['name', 'email', 'password', 'acceptTerms', 'acceptPersonalData'] as const

describe('mapAuthError', () => {
  it('puts consent errors under their checkboxes', () => {
    expect(mapAuthError({ code: 'TERMS_NOT_ACCEPTED', status: 400 }, signUpFields)).toEqual({
      fieldErrors: { acceptTerms: expect.stringContaining('примите') },
    })
    expect(mapAuthError({ code: 'PERSONAL_DATA_NOT_ACCEPTED', status: 400 }, signUpFields)).toEqual(
      { fieldErrors: { acceptPersonalData: expect.stringContaining('согласие') } },
    )
  })

  it('puts a taken address under the email field', () => {
    expect(mapAuthError({ code: 'USER_ALREADY_EXISTS', status: 422 }, signUpFields)).toEqual({
      fieldErrors: { email: expect.stringContaining('уже зарегистрирован') },
    })
  })

  it('shows field errors above the button when the form has no such field', () => {
    expect(mapAuthError({ code: 'USER_ALREADY_EXISTS', status: 422 })).toEqual({
      error: expect.stringContaining('уже зарегистрирован'),
    })
  })

  it('maps captcha, credentials and rate limits to Russian texts', () => {
    expect(mapAuthError({ code: 'CAPTCHA_REQUIRED', status: 400 }).error).toMatch(/не робот/)
    expect(mapAuthError({ code: 'CAPTCHA_FAILED', status: 403 }).error).toMatch(/Проверка/)
    expect(mapAuthError({ code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 }).error).toBe(
      'Неверная почта или пароль.',
    )
    expect(mapAuthError({ message: 'Too many requests', status: 429 })).toEqual({
      error: RATE_LIMITED_ERROR,
    })
  })

  it('never shows an unknown server message', () => {
    expect(mapAuthError({ code: 'SOMETHING_NEW', message: 'Internal', status: 500 })).toEqual({
      error: GENERIC_AUTH_ERROR,
    })
    expect(mapAuthError(null)).toEqual({ error: GENERIC_AUTH_ERROR })
  })
})

describe('linkErrorMessage', () => {
  it('explains broken verification links', () => {
    expect(linkErrorMessage(undefined)).toBeNull()
    expect(linkErrorMessage('TOKEN_EXPIRED')).toBe(INVALID_LINK_ERROR)
    expect(linkErrorMessage('EMAIL_ALREADY_VERIFIED')).toMatch(/уже подтверждён/)
  })
})
