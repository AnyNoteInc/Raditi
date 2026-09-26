/** What better-auth's client returns in `error`. */
export interface AuthErrorLike {
  code?: string | undefined
  message?: string | undefined
  status?: number | undefined
}

export interface MappedAuthError<TField extends string> {
  error?: string
  fieldErrors?: Partial<Record<TField, string>>
}

export const GENERIC_AUTH_ERROR = 'Не получилось. Попробуйте ещё раз немного позже.'
export const RATE_LIMITED_ERROR =
  'Слишком много попыток подряд. Подождите минуту и попробуйте ещё раз.'
export const INVALID_LINK_ERROR =
  'Ссылка устарела или уже использована. Запросите новую — мы пришлём письмо ещё раз.'

type Target = { field: string } | { form: true }

interface Rule {
  message: string
  target?: Target
}

const form = { form: true } as const

/**
 * Server error codes (better-auth, the SmartCaptcha and consents plugins) → text for the form.
 * Unknown codes fall back to a generic message: server texts may be in English.
 */
const rules: Record<string, Rule> = {
  CAPTCHA_REQUIRED: { message: 'Подтвердите, что вы не робот, и отправьте форму ещё раз.' },
  CAPTCHA_FAILED: { message: 'Проверка не пройдена. Попробуйте ещё раз.' },
  TERMS_NOT_ACCEPTED: {
    message:
      'Чтобы зарегистрироваться, примите пользовательское соглашение и оферту и подтвердите, что ознакомились с политикой обработки персональных данных.',
    target: { field: 'acceptTerms' },
  },
  PERSONAL_DATA_NOT_ACCEPTED: {
    message: 'Нужно дать согласие на обработку персональных данных.',
    target: { field: 'acceptPersonalData' },
  },
  INVALID_MARKETING_CONSENT: {
    message: 'Не удалось прочитать ответ о рассылках. Обновите страницу и попробуйте ещё раз.',
  },
  USER_ALREADY_EXISTS: {
    message: 'Этот адрес уже зарегистрирован. Войдите или восстановите пароль.',
    target: { field: 'email' },
  },
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: {
    message: 'Этот адрес уже зарегистрирован. Войдите или восстановите пароль.',
    target: { field: 'email' },
  },
  INVALID_EMAIL: {
    message: 'Проверьте адрес электронной почты: в нём есть ошибка.',
    target: { field: 'email' },
  },
  INVALID_EMAIL_OR_PASSWORD: { message: 'Неверная почта или пароль.' },
  INVALID_PASSWORD: { message: 'Неверная почта или пароль.' },
  CREDENTIAL_ACCOUNT_NOT_FOUND: { message: 'Неверная почта или пароль.' },
  EMAIL_NOT_VERIFIED: {
    message: 'Сначала подтвердите адрес почты: откройте ссылку из письма, которое мы отправили.',
  },
  PASSWORD_TOO_SHORT: {
    message: 'Пароль слишком короткий.',
    target: { field: 'password' },
  },
  PASSWORD_TOO_LONG: {
    message: 'Пароль слишком длинный.',
    target: { field: 'password' },
  },
  INVALID_TOKEN: { message: INVALID_LINK_ERROR },
  TOKEN_EXPIRED: { message: INVALID_LINK_ERROR },
  EMAIL_ALREADY_VERIFIED: { message: 'Адрес уже подтверждён. Войдите в кабинет.' },
  USER_NOT_FOUND: { message: INVALID_LINK_ERROR },
  TOO_MANY_REQUESTS: { message: RATE_LIMITED_ERROR },
}

/** Maps a server error to the form: field errors for known fields, the rest above the button. */
export function mapAuthError<TField extends string>(
  error: AuthErrorLike | null | undefined,
  fields: readonly TField[] = [],
): MappedAuthError<TField> {
  if (!error) return { error: GENERIC_AUTH_ERROR }
  if (error.status === 429) return { error: RATE_LIMITED_ERROR }
  const rule = error.code ? rules[error.code] : undefined
  if (!rule) return { error: GENERIC_AUTH_ERROR }
  const target = rule.target ?? form
  if ('field' in target && (fields as readonly string[]).includes(target.field)) {
    return { fieldErrors: { [target.field]: rule.message } as Partial<Record<TField, string>> }
  }
  return { error: rule.message }
}

export const isAuthErrorCode = (error: AuthErrorLike | null | undefined, code: string) =>
  error?.code === code

/** Russian text for the `error` query parameter better-auth adds to verification redirects. */
export function linkErrorMessage(code: string | undefined): string | null {
  if (!code) return null
  return code === 'EMAIL_ALREADY_VERIFIED'
    ? (rules.EMAIL_ALREADY_VERIFIED?.message ?? INVALID_LINK_ERROR)
    : INVALID_LINK_ERROR
}
