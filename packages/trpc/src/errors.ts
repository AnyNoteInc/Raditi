import {
  isDomainError,
  taskRefusalDetailsSchema,
  type DomainError,
  type TaskRefusalDetails,
} from '@repo/domain'
import { TRPCError, type TRPC_ERROR_CODE_KEY } from '@trpc/server'

/** Shown instead of the real message of an unexpected failure: it may name tables or hosts. */
export const INTERNAL_ERROR_MESSAGE = 'Что-то пошло не так. Попробуйте ещё раз немного позже'
export const INVALID_INPUT_MESSAGE = 'Проверьте введённые данные'
const UNAVAILABLE_MESSAGE = 'Действие сейчас недоступно'
const SERVICE_DOWN_MESSAGE = 'Сервис временно недоступен. Попробуйте ещё раз немного позже'

/** DomainError code of consentedProcedure: the web sends the user to accept the documents. */
export const CONSENT_REQUIRED = 'CONSENT_REQUIRED'
export const CONSENT_REQUIRED_MESSAGE = 'Примите обновлённые документы, чтобы продолжить'

/** Client text for every tRPC code: what the user sees when nothing more specific is known. */
const MESSAGE_BY_TRPC_CODE: Readonly<Record<TRPC_ERROR_CODE_KEY, string>> = {
  PARSE_ERROR: INVALID_INPUT_MESSAGE,
  BAD_REQUEST: INVALID_INPUT_MESSAGE,
  UNPROCESSABLE_CONTENT: INVALID_INPUT_MESSAGE,
  UNSUPPORTED_MEDIA_TYPE: INVALID_INPUT_MESSAGE,
  PAYLOAD_TOO_LARGE: 'Слишком большой объём данных',
  UNAUTHORIZED: 'Войдите, чтобы продолжить',
  PAYMENT_REQUIRED: 'Для этого действия нужна оплата',
  FORBIDDEN: 'Недостаточно прав',
  NOT_FOUND: 'Не нашли то, что вы ищете',
  METHOD_NOT_SUPPORTED: UNAVAILABLE_MESSAGE,
  CONFLICT: UNAVAILABLE_MESSAGE,
  PRECONDITION_FAILED: UNAVAILABLE_MESSAGE,
  PRECONDITION_REQUIRED: UNAVAILABLE_MESSAGE,
  TOO_MANY_REQUESTS: 'Слишком много запросов. Подождите немного и попробуйте снова',
  TIMEOUT: 'Не дождались ответа. Попробуйте ещё раз',
  CLIENT_CLOSED_REQUEST: 'Запрос отменён',
  NOT_IMPLEMENTED: 'Эта возможность ещё в разработке',
  INTERNAL_SERVER_ERROR: INTERNAL_ERROR_MESSAGE,
  BAD_GATEWAY: SERVICE_DOWN_MESSAGE,
  SERVICE_UNAVAILABLE: SERVICE_DOWN_MESSAGE,
  GATEWAY_TIMEOUT: SERVICE_DOWN_MESSAGE,
}

const SPLIT_TASK = 'Попробуйте разбить задачу на несколько небольших'
const SAVE_FAILED = 'Не удалось сохранить работу агента'

/**
 * Client text per DomainError code. Domain messages are English and meant for the logs;
 * a code the user may meet gets its Russian text here or in MESSAGE_FROM_DETAILS below, any
 * other shows the text of its tRPC code.
 */
const MESSAGE_BY_DOMAIN_CODE: Readonly<Record<string, string>> = {
  BAD_REQUEST: INVALID_INPUT_MESSAGE,
  FORBIDDEN: 'Недостаточно прав',
  NOT_FOUND: 'Не нашли то, что вы ищете',
  CONFLICT: UNAVAILABLE_MESSAGE,
  PROJECT_ALREADY_EXISTS: 'Сайт с таким адресом уже добавлен',
  PROJECT_LIMIT_REACHED: 'Вы добавили максимальное число сайтов. Напишите нам, если нужно больше',
  SITE_ADDRESS_NOT_PUBLIC: 'Укажите адрес сайта, который открывается из интернета',
  // The wizard «Добавить проект» and the screen «Настраиваем сайт» (docs/plan/39-site-connection-wizard.md).
  // Why a check of the files or the database failed is told by its reason, not by these.
  SITE_CONNECTION_UNAVAILABLE:
    'Подключение сайтов сейчас недоступно. Попробуйте ещё раз немного позже',
  SITE_STACK_NOT_CONNECTABLE: 'Эту платформу мы пока не подключаем',
  SITE_CHECKS_LIMITED:
    'Слишком много проверок подряд. Подождите несколько минут и попробуйте снова',
  SITE_CONNECTIONS_BUSY:
    'Сейчас подключаются три ваших сайта. Дождитесь, пока закончится хотя бы одно подключение',
  PROJECT_CREATION_IN_PROGRESS: 'Проект уже добавляется. Подождите несколько секунд',
  // This opening of the wizard already added a project, at another address (its answer was lost).
  PROJECT_REQUEST_CONFLICT:
    'Из этого окна уже добавлен проект с другим адресом. Откройте список проектов или начните добавление заново',
  // Any stage that is not failed: still going, or already done in another tab.
  SITE_SETUP_NOT_FAILED:
    'Настройку сейчас нельзя повторить. Обновите страницу, чтобы увидеть, как она идёт',
  SITE_SETUP_RETRIES_LIMITED:
    'Повторять настройку можно не чаще шести раз в час. Попробуйте немного позже',
  // A failed import of a site that is no longer being connected (activated, paused, archived).
  SITE_SETUP_UNAVAILABLE:
    'Настройку этого сайта уже нельзя повторить. Обновите страницу, чтобы увидеть, что изменилось',
  NOT_IMPLEMENTED: 'Эта возможность ещё в разработке',
  [CONSENT_REQUIRED]: CONSENT_REQUIRED_MESSAGE,
  // Tariffs and their payment: what the customer can do next. Why a bank declined a payment
  // is told by the order itself (paymentFailureText of @repo/billing), not by these.
  BILLING_PAYMENTS_NOT_CONFIGURED: 'Оплата сейчас недоступна. Попробуйте ещё раз немного позже',
  BILLING_PLAN_NOT_FOUND: 'Этот тариф сейчас не продаётся. Обновите страницу и выберите другой',
  BILLING_SUBSCRIPTION_EXISTS: 'Тариф уже оформлен. Обновите страницу, чтобы увидеть его',
  BILLING_PLAN_SITE_LIMIT:
    'У вас больше сайтов, чем входит в этот тариф. Выберите тариф, в который они помещаются',
  BILLING_PAYMENT_DECLINED:
    'Платёж не прошёл. Попробуйте ещё раз или выберите другой способ оплаты',
  BILLING_PAYMENT_IN_PROGRESS:
    'Предыдущий платёж ещё обрабатывается. Подождите пару минут и обновите страницу',
  BILLING_PACK_NEEDS_SUBSCRIPTION:
    'Пакет кредитов можно купить только при действующем тарифе. Сначала оформите или оплатите тариф',
  BILLING_ORDER_NOT_FOUND:
    'Не нашли такой заказ. Проверьте ссылку или откройте «Тарифы» в настройках',
  // The saved payment method and auto-renewal: the page behind the refusal is out of date.
  BILLING_NO_LIVE_SUBSCRIPTION:
    'У вас нет действующего тарифа. Обновите страницу, чтобы увидеть, что изменилось',
  BILLING_NOTHING_TO_CHANGE: 'Это уже сделано. Обновите страницу, чтобы увидеть изменения',
  // The shop takes one-time payments only (YOOKASSA_AUTOPAYMENTS=off).
  BILLING_AUTO_RENEWAL_UNAVAILABLE:
    'Автопродление пока недоступно. Оформите тариф без него: он будет действовать месяц',
  // The tariff of the next period.
  BILLING_ALREADY_ON_PLAN:
    'Этот тариф у вас уже есть или уже выбран на следующий период. Обновите страницу, чтобы увидеть изменения',
  BILLING_SUBSCRIPTION_PAST_DUE:
    'Сначала оплатите тариф: последнее списание не прошло. Откройте «Тарифы» и нажмите «Оплатить сейчас»',
  // A task that is not queued: no credits to reserve, or all of them set aside for tasks in
  // work, the limit of the day, no paid tariff, too much work that ended without a charge.
  BILLING_NOT_ENOUGH_CREDITS:
    'Лимиты закончились: кредитов не хватает, чтобы начать задачу. Купите пакет кредитов или дождитесь начисления по тарифу — подробности в разделе «Использование»',
  BILLING_CREDITS_HELD:
    'Все кредиты отложены под задачи в работе. Дождитесь, пока они закончатся, или купите пакет кредитов',
  BILLING_DAILY_LIMIT_REACHED:
    'Лимит задач на сегодня исчерпан. Новую задачу можно будет поставить завтра',
  BILLING_TASK_NEEDS_SUBSCRIPTION:
    'Чтобы ставить задачи, нужен действующий тариф. Выберите или оплатите его в разделе «Тарифы»',
  BILLING_UNPAID_WORK_LIMIT:
    'Новые задачи временно не принимаются: слишком много задач остановилось без результата. Напишите нам — разберёмся, в чём дело',
  // No usable credit rate: the platform's own state, nothing the customer can pay or change.
  BILLING_CREDIT_RATE_MISSING:
    'Задачи сейчас не принимаются: мы обновляем расчёт кредитов. Попробуйте ещё раз немного позже',
  // Size and count limits of a turn (spec §8): what the client can do about them.
  PUBLICATION_TOO_LARGE: `Изменения получились слишком большими, и мы не можем их сохранить. ${SPLIT_TASK}`,
  SNAPSHOT_TOO_LARGE: `Работа агента заняла слишком много места, и мы не можем её сохранить. ${SPLIT_TASK}`,
  REPOSITORY_TOO_LARGE:
    'Файлы сайта занимают слишком много места, и агент пока не может с ними работать',
  REPOSITORY_UNSUPPORTED:
    'Часть файлов сайта агент пока не умеет обрабатывать: ярлыки, вложенные проекты или файлы с необычными именами. Напишите нам — поможем разобраться',
  // The agent's changes broke a publication rule (spec §8, §10): nothing was saved.
  PUBLICATION_FORBIDDEN:
    'Агент попытался изменить файлы, которые менять нельзя. Изменения не сохранены',
  PUBLICATION_SECRET: 'В изменениях нашлось что-то похожее на пароль или ключ — мы их не сохранили',
  // Turn and snapshot failures (P1, P2).
  SNAPSHOT_NOT_WRITTEN: `${SAVE_FAILED}. Попробуйте ещё раз`,
  SNAPSHOT_SAVE_FAILED: `${SAVE_FAILED}. Мы проверим, что случилось, а до тех пор новые задачи для этого сайта недоступны`,
  SNAPSHOT_LOAD_FAILED:
    'Не удалось восстановить прошлую работу агента. Попробуйте ещё раз немного позже',
  TURN_INTERRUPTED: 'Работа агента остановлена. Если вы её не отменяли, попробуйте ещё раз',
  TURN_EXEC_FAILED: 'Агент не смог закончить работу. Попробуйте ещё раз',
  TURN_OUTPUT_REJECTED: 'Не удалось принять результат работы агента. Попробуйте ещё раз',
  TURN_OUTPUT_TOO_LARGE: `Агент написал слишком много, и мы остановили его работу. ${SPLIT_TASK}`,
  DRIVER_PREPARE_INVALID:
    'Не удалось подготовить агента к работе. Попробуйте ещё раз немного позже',
  LEASE_LOST: 'Работа агента прервана. Попробуйте ещё раз',
  SITE_BUSY: 'С сайтом сейчас идёт другая работа. Попробуйте ещё раз, когда она закончится',
  // Every recovery hold, including ones that clear on their own; no notification exists yet (P12).
  SITE_HELD:
    'С прошлой работой на сайте произошёл сбой, мы её заканчиваем. Попробуйте ещё раз немного позже',
  SANDBOX_COMMAND_FAILED:
    'Агент не смог выполнить работу из-за технического сбоя. Попробуйте ещё раз немного позже',
  // The runner VM did not take the turn or lost touch with it; recovery lost the agent (P2).
  RUNNER_UNAVAILABLE:
    'Не получается связаться с агентом из-за технического сбоя. Попробуйте ещё раз немного позже',
  EXEC_LOST: 'Работа агента прервалась из-за технического сбоя. Попробуйте ещё раз',
  GIT_OPERATION_FAILED:
    'Не удалось получить или сохранить файлы сайта. Попробуйте ещё раз немного позже',
}

const CODE_BY_HTTP_STATUS: Readonly<Record<number, TRPC_ERROR_CODE_KEY>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  408: 'TIMEOUT',
  409: 'CONFLICT',
  412: 'PRECONDITION_FAILED',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'UNPROCESSABLE_CONTENT',
  428: 'PRECONDITION_REQUIRED',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_SERVER_ERROR',
  501: 'NOT_IMPLEMENTED',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
}

export function trpcCodeForStatus(httpStatus: number): TRPC_ERROR_CODE_KEY {
  return (
    CODE_BY_HTTP_STATUS[httpStatus] ?? (httpStatus >= 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST')
  )
}

const ANOTHER_PLAN = 'Чтобы добавить ещё один, выберите другой тариф в настройках'
// The tariff of the next period can be taken back as well as replaced.
const ANOTHER_NEXT_PLAN =
  'Чтобы добавить ещё один, отмените переход или выберите другой тариф в настройках'

/** «до 3 сайтов», «до 21 сайта»: the number with the form of the noun that follows it. */
const sitesUpTo = (count: number) =>
  `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'сайта' : 'сайтов'}`

/** One of three forms of a word by the number before it: 1 кредит, 2 кредита, 5 кредитов. */
function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100
  const units = count % 10
  if (tens >= 11 && tens <= 14) return many
  if (units === 1) return one
  return units >= 2 && units <= 4 ? few : many
}

/** «2 500»: a count of credits, its thousands held together like those of a sum of money. */
const counted = (count: number) =>
  String(count).replace(/\B(?=(\d{3})+$)/g, String.fromCharCode(0xa0))

/**
 * The details of a refused task (`taskRefusal` of @repo/domain), when the error carries them
 * whole: the reason and the three numbers. They never leave the server; a sentence is built
 * from them here.
 */
function refusalOf(details: unknown): TaskRefusalDetails | null {
  const parsed = taskRefusalDetailsSchema.safeParse(details)
  return parsed.success ? parsed.data : null
}

const CHOOSE_PLAN = 'Выберите тариф в разделе «Тарифы»'

/**
 * Why a task is refused without a paid tariff, by the reason of the refusal: what is told
 * first, before the way out. A reason that is not here is told in the general words of its
 * code.
 */
function withoutTariff({ reason, spendable, needed }: TaskRefusalDetails): string | null {
  switch (reason) {
    case 'gift_spent':
      return 'Подарочные кредиты закончились.'
    case 'gift_below_start': {
      const left = plural(spendable, 'Остался', 'Осталось', 'Осталось')
      const gift = plural(
        spendable,
        'подарочный кредит',
        'подарочных кредита',
        'подарочных кредитов',
      )
      return `${left} ${counted(spendable)} ${gift}, а на новую задачу нужно не меньше ${counted(needed)}.`
    }
    case 'trial_unpaid_limit':
      return 'Пробные задачи закончились: несколько задач остановились без результата, и без тарифа мы больше не можем их принимать.'
    case 'gift_site_used':
      return 'На этом сайте подарочные кредиты уже использовались в другом аккаунте.'
    default:
      return null
  }
}

/**
 * Client texts that name a number from the details of their DomainError. The text never
 * depends on the details being there: without the number it says the same in general words.
 */
const MESSAGE_FROM_DETAILS: Readonly<Record<string, (details: unknown) => string>> = {
  // A task that was refused although the page offered it: the page was out of date. The page
  // itself tells these cases from its read model; here the sentence is built from the details
  // of the refusal, with the numbers the customer can check.
  BILLING_NOT_ENOUGH_CREDITS: (details) => {
    const refusal = refusalOf(details)
    // A few credits are left, fewer than a new task needs.
    if (refusal === null || refusal.spendable < 1 || refusal.spendable >= refusal.needed) {
      return MESSAGE_BY_DOMAIN_CODE.BILLING_NOT_ENOUGH_CREDITS!
    }
    const { spendable, needed } = refusal
    const left = plural(spendable, 'остался', 'осталось', 'осталось')
    const credits = plural(spendable, 'кредит', 'кредита', 'кредитов')
    return `Лимиты закончились: ${left} ${counted(spendable)} ${credits}, а на новую задачу нужно не меньше ${counted(needed)}. Купите пакет кредитов или дождитесь начисления по тарифу`
  },
  BILLING_CREDITS_HELD: (details) => {
    const refusal = refusalOf(details)
    if (refusal === null || refusal.held < 1) return MESSAGE_BY_DOMAIN_CODE.BILLING_CREDITS_HELD!
    return `Кредиты заняты задачами в работе: под них отложено ${counted(refusal.held)}. Дождитесь, пока задачи закончатся, или купите пакет кредитов`
  },
  BILLING_TASK_NEEDS_SUBSCRIPTION: (details) => {
    const refusal = refusalOf(details)
    const why = refusal === null ? null : withoutTariff(refusal)
    return why === null
      ? MESSAGE_BY_DOMAIN_CODE.BILLING_TASK_NEEDS_SUBSCRIPTION!
      : `${why} ${CHOOSE_PLAN}`
  },
  // The site limit of the tariff (project.create): `details.maxSites`. `details.unpaid` is
  // true when the limit is of a tariff the customer has started to pay for and does not have yet,
  // `details.scheduled` — when it is of the tariff they chose for the next period: the tariff
  // they have may hold more sites, and «в ваш тариф входит…» would not be true of it.
  PROJECT_PLAN_LIMIT_REACHED: (details) => {
    const {
      maxSites,
      unpaid,
      scheduled,
    }: { maxSites?: unknown; unpaid?: unknown; scheduled?: unknown } =
      typeof details === 'object' && details !== null ? details : {}
    if (typeof maxSites !== 'number' || !Number.isSafeInteger(maxSites) || maxSites < 1) {
      return `На вашем тарифе больше нельзя добавить сайт. ${ANOTHER_PLAN}`
    }
    const included = maxSites === 1 ? 'входит один сайт' : `входит до ${sitesUpTo(maxSites)}`
    if (unpaid === true) return `В тариф, который вы оплачиваете, ${included}. ${ANOTHER_PLAN}`
    if (scheduled === true) {
      return `В тариф, который вы выбрали на следующий период, ${included}. ${ANOTHER_NEXT_PLAN}`
    }
    return `В ваш тариф ${included}. ${ANOTHER_PLAN}`
  },
}

function textFor(code: TRPC_ERROR_CODE_KEY, domainError: DomainError | null): string {
  if (domainError !== null) {
    if (Object.hasOwn(MESSAGE_FROM_DETAILS, domainError.code)) {
      return MESSAGE_FROM_DETAILS[domainError.code]!(domainError.details)
    }
    if (Object.hasOwn(MESSAGE_BY_DOMAIN_CODE, domainError.code)) {
      return MESSAGE_BY_DOMAIN_CODE[domainError.code]!
    }
  }
  return MESSAGE_BY_TRPC_CODE[code]
}

/**
 * The tRPC error for a DomainError. Its message is the Russian client text, so server
 * callers (createCaller in RSC) never show the English domain message either; that one
 * stays in `cause`.
 */
export function toTRPCError(error: DomainError): TRPCError {
  const code = trpcCodeForStatus(error.httpStatus)
  return new TRPCError({ code, message: textFor(code, error), cause: error })
}

/**
 * The only texts a client ever sees: by DomainError code, else by tRPC code. Raw messages
 * (English domain messages, zod issues, tRPC's own errors, driver errors) never leave the
 * server outside development.
 */
export function clientMessage(error: TRPCError): string {
  return textFor(error.code, isDomainError(error.cause) ? error.cause : null)
}

/** Issues of a failed zod (or Standard Schema) validation, if that is what failed. */
function validationIssues(cause: unknown): unknown[] | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined
  const { issues } = cause as { issues?: unknown }
  return Array.isArray(issues) ? issues : undefined
}

interface ErrorShape {
  message: string
  code: number
  data: { code: string; httpStatus: number; path?: string; stack?: string }
}

/** Development only: what actually went wrong. */
export interface ErrorDetails {
  /** The original message: the DomainError's own, zod's or the thrown error's. */
  message: string
  /** Issues of a failed input or output validation. */
  issues?: unknown[]
}

/**
 * Error shape sent to clients: a Russian message on «вы» (clientMessage) and the DomainError
 * code in `data.domainCode`. The original message, zod issues and the stack trace are added
 * only in development.
 */
export function formatError<S extends ErrorShape>(shape: S, error: TRPCError, isDev: boolean) {
  const domainCode = isDomainError(error.cause) ? error.cause.code : null
  const { stack, ...data } = shape.data
  let details: ErrorDetails | undefined
  if (isDev) {
    const issues = validationIssues(error.cause)
    const message = isDomainError(error.cause) ? error.cause.message : error.message
    details = issues ? { message, issues } : { message }
  }
  return {
    ...shape,
    message: clientMessage(error),
    data: {
      ...data,
      domainCode,
      ...(details ? { details } : {}),
      ...(isDev && stack ? { stack } : {}),
    },
  }
}
