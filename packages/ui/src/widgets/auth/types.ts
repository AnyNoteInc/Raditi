/** What an auth form's `onSubmit` may report back. Nothing (or `{}`) means success. */
export type AuthFormResult<TField extends string> = {
  /** Shown above the submit button; must already be text for the client, in Russian. */
  error?: string
  /** Shown under the fields, e.g. `{ email: 'Этот адрес уже зарегистрирован' }`. */
  fieldErrors?: Partial<Record<TField, string>>
}

export type AuthSubmitContext = {
  /** SmartCaptcha token for the `x-captcha-response` header; null when captcha is off. */
  captchaToken: string | null
}

/**
 * Thrown errors are not shown as is: the form falls back to a generic message, so map server
 * errors to `AuthFormResult` instead of throwing.
 */
export type AuthSubmitHandler<TValues, TField extends string> = (
  values: TValues,
  context: AuthSubmitContext,
) => Promise<AuthFormResult<TField> | void>

/** Usually `execute` from `useSmartCaptcha`. */
export type GetCaptchaToken = () => Promise<string | null>
