import type { BaseSyntheticEvent } from 'react'
import type { FieldValues, Path, UseFormReturn } from 'react-hook-form'

import { captchaErrorMessage } from '../../captcha/captcha-error.ts'
import type { AuthSubmitHandler, GetCaptchaToken } from './types.ts'

export const GENERIC_SUBMIT_ERROR =
  'Не получилось отправить форму. Проверьте подключение к интернету и попробуйте ещё раз.'

/**
 * Validation → captcha → `onSubmit`. Errors land in react-hook-form state: field errors under
 * the fields, the rest in `errors.root.server`; `isSubmitSuccessful` stays false after any of them.
 */
export function createAuthSubmit<TInput extends FieldValues, TOutput>(
  form: UseFormReturn<TInput, unknown, TOutput>,
  onSubmit: AuthSubmitHandler<TOutput, Extract<keyof TInput, string>>,
  getCaptchaToken: GetCaptchaToken | undefined,
): (event?: BaseSyntheticEvent) => Promise<void> {
  return form.handleSubmit(async (values) => {
    let captchaToken: string | null = null
    if (getCaptchaToken) {
      try {
        captchaToken = await getCaptchaToken()
      } catch (error) {
        // A superseded attempt shows no message, but must not count as a success either.
        const message = captchaErrorMessage(error) ?? undefined
        form.setError('root.server', { type: 'captcha', message })
        return
      }
    }

    let result: Awaited<ReturnType<typeof onSubmit>>
    try {
      result = await onSubmit(values, { captchaToken })
    } catch {
      form.setError('root.server', { type: 'server', message: GENERIC_SUBMIT_ERROR })
      return
    }
    if (!result) return

    let shouldFocus = true
    for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
      if (typeof message !== 'string' || !message) continue
      form.setError(field as Path<TInput>, { type: 'server', message }, { shouldFocus })
      shouldFocus = false
    }
    if (result.error) form.setError('root.server', { type: 'server', message: result.error })
  })
}
