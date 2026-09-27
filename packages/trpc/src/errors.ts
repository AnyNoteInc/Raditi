import { isDomainError, type DomainError } from '@repo/domain'
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
 * a code the user may meet gets its Russian text here, any other shows the text of its
 * tRPC code.
 */
const MESSAGE_BY_DOMAIN_CODE: Readonly<Record<string, string>> = {
  BAD_REQUEST: INVALID_INPUT_MESSAGE,
  FORBIDDEN: 'Недостаточно прав',
  NOT_FOUND: 'Не нашли то, что вы ищете',
  CONFLICT: UNAVAILABLE_MESSAGE,
  NOT_IMPLEMENTED: 'Эта возможность ещё в разработке',
  [CONSENT_REQUIRED]: CONSENT_REQUIRED_MESSAGE,
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
  SITE_HELD:
    'Нужно проверить, что случилось с прошлой работой на сайте. Мы напишем, когда можно продолжить',
  SANDBOX_COMMAND_FAILED:
    'Агент не смог выполнить работу из-за технического сбоя. Попробуйте ещё раз немного позже',
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

function textFor(code: TRPC_ERROR_CODE_KEY, domainCode: string | null): string {
  if (domainCode !== null && Object.hasOwn(MESSAGE_BY_DOMAIN_CODE, domainCode)) {
    return MESSAGE_BY_DOMAIN_CODE[domainCode]!
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
  return new TRPCError({ code, message: textFor(code, error.code), cause: error })
}

/**
 * The only texts a client ever sees: by DomainError code, else by tRPC code. Raw messages
 * (English domain messages, zod issues, tRPC's own errors, driver errors) never leave the
 * server outside development.
 */
export function clientMessage(error: TRPCError): string {
  return textFor(error.code, isDomainError(error.cause) ? error.cause.code : null)
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
