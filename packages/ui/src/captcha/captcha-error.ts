export const captchaFailureReasons = ['cancelled', 'network', 'script', 'superseded'] as const
/**
 * - `cancelled`: the visitor closed the challenge window;
 * - `network`: the widget could not reach Yandex;
 * - `script`: captcha.js failed to load or threw — such a check must never count as passed;
 * - `superseded`: a newer `execute()` call replaced this one.
 */
export type CaptchaFailureReason = (typeof captchaFailureReasons)[number]

export class CaptchaError extends Error {
  readonly reason: CaptchaFailureReason

  constructor(reason: CaptchaFailureReason) {
    super(`SmartCaptcha check failed: ${reason}`)
    this.name = 'CaptchaError'
    this.reason = reason
  }
}

/** Checks the name, not `instanceof`: works across duplicated module instances. */
export function isCaptchaError(error: unknown): error is CaptchaError {
  return error instanceof Error && error.name === 'CaptchaError' && 'reason' in error
}

export const CAPTCHA_FAILED_MESSAGE = 'Не удалось пройти проверку. Попробуйте ещё раз.'

const messages: Record<Exclude<CaptchaFailureReason, 'superseded'>, string> = {
  cancelled: 'Проверка не завершена. Нажмите кнопку ещё раз и пройдите проверку до конца.',
  network:
    'Не удалось связаться с сервисом проверки. Проверьте подключение к интернету и попробуйте ещё раз.',
  script: 'Не удалось загрузить проверку. Обновите страницу и попробуйте ещё раз.',
}

/** Text for the form, in Russian; null when a newer attempt replaced this one. */
export function captchaErrorMessage(error: unknown): string | null {
  if (!isCaptchaError(error)) return CAPTCHA_FAILED_MESSAGE
  if (error.reason === 'superseded') return null
  return messages[error.reason]
}
