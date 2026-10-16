/**
 * Why a task failed, as the customer is told — the closed catalogue of the feed design
 * (docs/research/2026-10-client-feed/feed-design.md, «Причины сбоя для клиента»). A feed row
 * stores the code only; the Russian text is chosen when the row is shown, so a corrected
 * wording also reaches old rows. Raw failure text never enters either.
 */
export const feedFailureCodes = [
  'technical',
  'timeout',
  'too_large',
  'task_limit',
  'credits_out',
  'forbidden_change',
  'secret_found',
  'site_files',
  'site_held',
  'content_refused',
  'unavailable',
  'not_accepted',
] as const
export type FeedFailureCode = (typeof feedFailureCodes)[number]

/** What an unknown code is read as, and what every unknown technical cause maps to. */
export const FEED_FAILURE_FALLBACK: FeedFailureCode = 'technical'

export const feedFailureText: Readonly<Record<FeedFailureCode, string>> = Object.freeze({
  technical: 'Не получилось выполнить задачу из-за технического сбоя.',
  timeout: 'Агент не уложился в 20 минут. Попробуйте разбить задачу на несколько небольших.',
  too_large:
    'Работа получилась слишком большой, и мы не смогли её сохранить. Попробуйте разбить задачу на несколько небольших.',
  task_limit:
    'Задача оказалась больше, чем получается сделать за один заход. Попробуйте разбить её на несколько небольших.',
  credits_out:
    'Лимиты закончились: кредитов не хватило, чтобы закончить задачу, и работа остановлена. Сколько кредитов осталось и когда начислятся новые — в разделе «Использование».',
  forbidden_change:
    'Агент попытался изменить то, что менять нельзя, и мы не сохранили его работу. Попробуйте описать задачу по-другому.',
  secret_found:
    'В изменениях нашлось что-то похожее на пароль или ключ, поэтому мы не сохранили работу агента. Попросите агента не добавлять пароли и ключи в файлы.',
  site_files:
    'С файлами этого сайта агент пока не умеет работать. Напишите нам — поможем разобраться.',
  site_held:
    'При работе с сайтом произошёл сбой, мы его разбираем. Новые задачи для этого сайта пока недоступны.',
  content_refused:
    'Мы не можем выполнить эту задачу: её не пропустила проверка безопасности. Начните новый диалог и опишите задачу по-другому.',
  unavailable: 'Сейчас мы не можем взять задачу в работу. Попробуйте ещё раз немного позже.',
  not_accepted:
    'Задачи для этого сайта пока не принимаются. Напишите нам — расскажем, когда это изменится.',
})

/**
 * Whether the code alone allows «Попробовать ещё». The button also needs the site not left in
 * doubt and a counted attempt to spare — the server decides that (`canRetry` of the task head).
 */
export const feedFailureRetry: Readonly<Record<FeedFailureCode, boolean>> = Object.freeze({
  technical: true,
  timeout: true,
  too_large: true,
  task_limit: true,
  credits_out: false,
  forbidden_change: true,
  secret_found: true,
  site_files: false,
  site_held: false,
  content_refused: false,
  unavailable: true,
  not_accepted: false,
})
