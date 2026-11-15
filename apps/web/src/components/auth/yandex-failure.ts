// What the sign-in page says after a failed round trip through Yandex ID. A plain module, not
// a client one: the server page of the sign-in calls it.

/** The query the sign-in page reads after a failed round trip; better-auth adds `error`. */
export const YANDEX_FAILED_PARAM = 'yandex'

export const YANDEX_FAILED_TEXT = 'Не удалось войти через Яндекс ID. Попробуйте ещё раз.'

/** better-auth's error codes of the callback that a user can act on. */
const ERROR_TEXT: Record<string, string> = {
  account_not_linked:
    'Этот адрес уже зарегистрирован в Радити, но ещё не подтверждён. Войдите по почте и паролю и подтвердите адрес — после этого можно входить и через Яндекс ID.',
  access_denied: 'Вы не дали Радити доступ к Яндекс ID. Чтобы войти, разрешите доступ.',
}

/** The text for `?yandex=…&error=…` on the sign-in page, or undefined without a failure. */
export function yandexFailureText(params: {
  yandex?: string | string[]
  error?: string | string[]
}): string | undefined {
  if (params.yandex === undefined) return undefined
  const code = Array.isArray(params.error) ? params.error[0] : params.error
  return (code && ERROR_TEXT[code]) || YANDEX_FAILED_TEXT
}
