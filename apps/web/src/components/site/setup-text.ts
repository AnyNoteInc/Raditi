import type { ConnectionCheckReason, ProvisioningErrorCode } from '@repo/domain'

import { sourceReasonText } from '@/components/projects/wizard/reason-text'

// What the screen «Настраиваем сайт» says: where the first import of the site is, and why it
// stopped. Safe texts only: no message of a server, no path, no detail of our own machinery.

/** What the import is doing; `step` is known only while the stage runs. */
export function setupStageText(stage: { status: string | null; step: string | null }): {
  title: string
  note: string
} {
  if (stage.status === 'running' && stage.step === 'publish') {
    return {
      title: 'Сохраняем первоначальную версию',
      note: 'Файлы скопированы. Сохраняем их как первую версию сайта.',
    }
  }
  if (stage.status === 'running') {
    return {
      title: 'Копируем файлы сайта',
      note: 'Скачиваем файлы сайта с сервера и следим, чтобы в копию не попали пароли. Если файлов много, это может занять до часа.',
    }
  }
  return {
    title: 'Ожидаем начала настройки',
    note: 'Настройка скоро начнётся.',
  }
}

/** Retries and replaced accesses together, per site and hour (siteConnectionLimits.retriesPerHour). */
export const RETRIES_PER_HOUR = 6

const later = 'Попробуйте повторить немного позже.'
const ours = 'Сохранить версию сайта не получилось по нашей причине. ' + later

/** The codes only an import has; the reasons of a connection are said as the wizard says them. */
const importTexts: Record<Exclude<ProvisioningErrorCode, ConnectionCheckReason>, string> = {
  access_missing: 'Сохранённый доступ к файлам сайта не найден. Укажите доступ заново.',
  access_mismatch:
    'Сохранённый доступ к файлам сайта не совпадает с настройками проекта. Укажите доступ заново.',
  access_refused: 'Продолжить настройку сейчас нельзя. ' + later,
  access_value_common:
    'Пароль от доступа встречается во многих файлах сайта — так бывает с короткими и простыми паролями. Задайте на хостинге пароль сложнее и укажите доступ заново.',
  repository_not_configured: ours,
  repository_not_created: ours,
  repository_push_failed: ours,
  repository_mismatch:
    'Для этого сайта уже сохранена другая первоначальная версия, и повтор её не заменит. Напишите нам — мы разберёмся.',
  source_too_large:
    'Сайт слишком большой для копирования: мы копируем сайты до 100 000 файлов и до 128 МБ вместе с медиа.',
  source_inconsistent: 'Файлы на сервере менялись, пока мы их копировали. Попробуйте повторить.',
  source_has_secrets:
    'В файлах сайта слишком много мест, похожих на пароли и ключи доступа, поэтому копию мы не сохранили. Напишите нам — мы разберёмся.',
  source_empty:
    'В папке сайта не нашлось файлов, которые можно сохранить. Проверьте папку и укажите доступ заново.',
  scan_failed: 'Не удалось проверить файлы сайта. Попробуйте повторить.',
  schema_unreadable: 'Не удалось прочитать устройство базы данных. Попробуйте повторить.',
  timed_out:
    'Копирование заняло больше часа и было остановлено. Попробуйте повторить; если не поможет, напишите нам.',
  interrupted: 'Настройка прервалась по нашей причине. Попробуйте повторить.',
  internal: 'Что-то пошло не так по нашей причине. Попробуйте повторить.',
}

/**
 * The reasons of a connection that mean something else once the access was saved: it worked
 * when the project was added, so what changed is the server.
 */
const savedAccessTexts: Partial<Record<ConnectionCheckReason, (platform: string) => string>> = {
  host_key_changed: () =>
    'Сервер назвал не тот ключ, который вы подтвердили, поэтому мы не стали подключаться. Если сервер переезжал или его переустанавливали, укажите доступ заново и сверьте новый ключ.',
  auth_failed: () =>
    'Сервер не принял сохранённые данные для входа. Если пароль или ключ меняли, укажите доступ заново.',
  tls_required: () =>
    'Сервер больше не принимает подключения без шифрования. Укажите доступ заново и выберите FTPS в поле «Защита соединения».',
  not_found: () =>
    'Папки сайта на сервере не нашлось. Если файлы переносили, укажите доступ заново.',
  not_site_root: (platform) =>
    `В папке сайта больше нет файлов сайта на ${platform}. Если файлы переносили, укажите доступ заново.`,
}

/** Why the setup stopped; `null` is a stop without a code. */
export function setupErrorText(
  code: ProvisioningErrorCode | null,
  context: { kind: string; platform: string },
): string {
  if (code === null) return 'Настройка сайта не завершилась. Попробуйте повторить.'
  if (Object.hasOwn(importTexts, code)) {
    return importTexts[code as keyof typeof importTexts]
  }
  const reason = code as ConnectionCheckReason
  return savedAccessTexts[reason]?.(context.platform) ?? sourceReasonText(reason, context)
}
