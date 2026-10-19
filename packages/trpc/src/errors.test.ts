import {
  badRequest,
  billingAlreadyOnPlan,
  billingAutoRenewalUnavailable,
  billingCreditRateMissing,
  billingCreditsHeld,
  billingDailyLimitReached,
  billingNoLiveSubscription,
  billingNotEnoughCredits,
  billingNothingToChange,
  billingOrderNotFound,
  billingPackNeedsSubscription,
  billingPaymentDeclined,
  billingPaymentInProgress,
  billingPaymentsNotConfigured,
  billingPlanNotFound,
  billingPlanSiteLimit,
  billingSubscriptionExists,
  billingSubscriptionPastDue,
  billingTaskNeedsSubscription,
  billingUnpaidWorkLimit,
  conflict,
  DomainError,
  forbidden,
  notFound,
  notImplemented,
  siteConnectionLimits,
  taskRefusal,
  taskRefusalReasons,
  type TaskRefusalReason,
} from '@repo/domain'
import { TRPCError } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  clientMessage,
  formatError,
  INTERNAL_ERROR_MESSAGE,
  INVALID_INPUT_MESSAGE,
  toTRPCError,
  trpcCodeForStatus,
} from './errors.ts'
import { createCallerFactory, publicProcedure, router, type Context } from './trpc.ts'

describe('toTRPCError', () => {
  it.each([
    [notFound('Site not found'), 'NOT_FOUND', 'Не нашли то, что вы ищете'],
    [forbidden('Not the owner'), 'FORBIDDEN', 'Недостаточно прав'],
    [conflict('Task is running'), 'CONFLICT', 'Действие сейчас недоступно'],
    [notImplemented('Bitrix'), 'NOT_IMPLEMENTED', 'Эта возможность ещё в разработке'],
    [badRequest('Bad site URL'), 'BAD_REQUEST', INVALID_INPUT_MESSAGE],
    [
      new DomainError('QUOTA_EXCEEDED', 'Quota exceeded', 402),
      'PAYMENT_REQUIRED',
      'Для этого действия нужна оплата',
    ],
    [new DomainError('TEAPOT', 'Teapot', 418), 'BAD_REQUEST', INVALID_INPUT_MESSAGE],
    [new DomainError('BROKEN', 'Broken', 599), 'INTERNAL_SERVER_ERROR', INTERNAL_ERROR_MESSAGE],
  ])('maps %s to %s with a Russian message', (domainError, code, message) => {
    const error = toTRPCError(domainError)

    expect(error).toBeInstanceOf(TRPCError)
    expect(error).toMatchObject({ code, message, cause: domainError })
  })

  it.each([
    ['PUBLICATION_TOO_LARGE', 413, 'PAYLOAD_TOO_LARGE', 'Изменения получились слишком большими'],
    ['SNAPSHOT_TOO_LARGE', 413, 'PAYLOAD_TOO_LARGE', 'Работа агента заняла слишком много места'],
    ['REPOSITORY_TOO_LARGE', 413, 'PAYLOAD_TOO_LARGE', 'Файлы сайта занимают слишком много места'],
    [
      'REPOSITORY_UNSUPPORTED',
      422,
      'UNPROCESSABLE_CONTENT',
      'Часть файлов сайта агент пока не умеет обрабатывать',
    ],
    ['PUBLICATION_FORBIDDEN', 502, 'BAD_GATEWAY', 'файлы, которые менять нельзя'],
    ['PUBLICATION_SECRET', 502, 'BAD_GATEWAY', 'похожее на пароль или ключ'],
    ['SNAPSHOT_NOT_WRITTEN', 502, 'BAD_GATEWAY', 'Не удалось сохранить работу агента'],
    ['SNAPSHOT_SAVE_FAILED', 502, 'BAD_GATEWAY', 'Не удалось сохранить работу агента'],
    ['SNAPSHOT_LOAD_FAILED', 502, 'BAD_GATEWAY', 'Не удалось восстановить прошлую работу'],
    ['TURN_INTERRUPTED', 409, 'CONFLICT', 'Работа агента остановлена'],
    ['TURN_EXEC_FAILED', 502, 'BAD_GATEWAY', 'Агент не смог закончить работу'],
    ['TURN_OUTPUT_REJECTED', 502, 'BAD_GATEWAY', 'Не удалось принять результат работы агента'],
    ['TURN_OUTPUT_TOO_LARGE', 413, 'PAYLOAD_TOO_LARGE', 'Агент написал слишком много'],
    ['DRIVER_PREPARE_INVALID', 502, 'BAD_GATEWAY', 'Не удалось подготовить агента'],
    ['LEASE_LOST', 409, 'CONFLICT', 'Работа агента прервана'],
    ['SITE_BUSY', 409, 'CONFLICT', 'С сайтом сейчас идёт другая работа'],
    ['SITE_HELD', 409, 'CONFLICT', 'С прошлой работой на сайте произошёл сбой'],
    ['SANDBOX_COMMAND_FAILED', 502, 'BAD_GATEWAY', 'технического сбоя'],
    ['RUNNER_UNAVAILABLE', 503, 'SERVICE_UNAVAILABLE', 'Не получается связаться с агентом'],
    ['EXEC_LOST', 502, 'BAD_GATEWAY', 'Работа агента прервалась'],
    ['GIT_OPERATION_FAILED', 502, 'BAD_GATEWAY', 'файлы сайта'],
  ] as const)(
    'gives the turn failure %s its own Russian text, without English or jargon',
    (domainCode, status, code, text) => {
      const error = toTRPCError(new DomainError(domainCode, 'English text for the logs', status))
      expect(error.code).toBe(code)
      expect(error.message).toContain(text)
      expect(error.message).not.toMatch(/[A-Za-z]/)
      expect(clientMessage(error)).toBe(error.message)
    },
  )

  it.each([
    [
      'BILLING_PAYMENTS_NOT_CONFIGURED',
      billingPaymentsNotConfigured,
      'SERVICE_UNAVAILABLE',
      'Оплата сейчас недоступна. Попробуйте ещё раз немного позже',
    ],
    [
      'BILLING_PLAN_NOT_FOUND',
      billingPlanNotFound,
      'NOT_FOUND',
      'Этот тариф сейчас не продаётся. Обновите страницу и выберите другой',
    ],
    [
      'BILLING_SUBSCRIPTION_EXISTS',
      billingSubscriptionExists,
      'CONFLICT',
      'Тариф уже оформлен. Обновите страницу, чтобы увидеть его',
    ],
    [
      'BILLING_PLAN_SITE_LIMIT',
      billingPlanSiteLimit,
      'CONFLICT',
      'У вас больше сайтов, чем входит в этот тариф. Выберите тариф, в который они помещаются',
    ],
    [
      'BILLING_PAYMENT_DECLINED',
      billingPaymentDeclined,
      'PAYMENT_REQUIRED',
      'Платёж не прошёл. Попробуйте ещё раз или выберите другой способ оплаты',
    ],
    [
      'BILLING_ORDER_NOT_FOUND',
      billingOrderNotFound,
      'NOT_FOUND',
      'Не нашли такой заказ. Проверьте ссылку или откройте «Тарифы» в настройках',
    ],
    [
      'BILLING_PAYMENT_IN_PROGRESS',
      billingPaymentInProgress,
      'CONFLICT',
      'Предыдущий платёж ещё обрабатывается. Подождите пару минут и обновите страницу',
    ],
    [
      'BILLING_PACK_NEEDS_SUBSCRIPTION',
      billingPackNeedsSubscription,
      'CONFLICT',
      'Пакет кредитов можно купить только при действующем тарифе. Сначала оформите или оплатите тариф',
    ],
    [
      'BILLING_NOT_ENOUGH_CREDITS',
      billingNotEnoughCredits,
      'PAYMENT_REQUIRED',
      'Лимиты закончились: кредитов не хватает, чтобы начать задачу. Купите пакет кредитов или дождитесь начисления по тарифу — подробности в разделе «Использование»',
    ],
    [
      'BILLING_DAILY_LIMIT_REACHED',
      billingDailyLimitReached,
      'CONFLICT',
      'Лимит задач на сегодня исчерпан. Новую задачу можно будет поставить завтра',
    ],
    [
      'BILLING_TASK_NEEDS_SUBSCRIPTION',
      billingTaskNeedsSubscription,
      'PAYMENT_REQUIRED',
      'Чтобы ставить задачи, нужен действующий тариф. Выберите или оплатите его в разделе «Тарифы»',
    ],
    [
      'BILLING_CREDITS_HELD',
      billingCreditsHeld,
      'CONFLICT',
      'Все кредиты отложены под задачи в работе. Дождитесь, пока они закончатся, или купите пакет кредитов',
    ],
    [
      'BILLING_UNPAID_WORK_LIMIT',
      billingUnpaidWorkLimit,
      'CONFLICT',
      'Новые задачи временно не принимаются: слишком много задач остановилось без результата. Напишите нам — разберёмся, в чём дело',
    ],
    [
      'BILLING_CREDIT_RATE_MISSING',
      billingCreditRateMissing,
      'SERVICE_UNAVAILABLE',
      'Задачи сейчас не принимаются: мы обновляем расчёт кредитов. Попробуйте ещё раз немного позже',
    ],
    [
      'BILLING_NO_LIVE_SUBSCRIPTION',
      billingNoLiveSubscription,
      'CONFLICT',
      'У вас нет действующего тарифа. Обновите страницу, чтобы увидеть, что изменилось',
    ],
    [
      'BILLING_NOTHING_TO_CHANGE',
      billingNothingToChange,
      'CONFLICT',
      'Это уже сделано. Обновите страницу, чтобы увидеть изменения',
    ],
    [
      'BILLING_ALREADY_ON_PLAN',
      billingAlreadyOnPlan,
      'CONFLICT',
      'Этот тариф у вас уже есть или уже выбран на следующий период. Обновите страницу, чтобы увидеть изменения',
    ],
    [
      'BILLING_SUBSCRIPTION_PAST_DUE',
      billingSubscriptionPastDue,
      'CONFLICT',
      'Сначала оплатите тариф: последнее списание не прошло. Откройте «Тарифы» и нажмите «Оплатить сейчас»',
    ],
    [
      'BILLING_AUTO_RENEWAL_UNAVAILABLE',
      billingAutoRenewalUnavailable,
      'CONFLICT',
      'Автопродление пока недоступно. Оформите тариф без него: он будет действовать месяц',
    ],
  ] as const)(
    'gives the billing refusal %s its own Russian text that says what to do next',
    (domainCode, refusal, code, text) => {
      const domainError = refusal()
      expect(domainError.code).toBe(domainCode)

      const error = toTRPCError(domainError)

      expect(error).toMatchObject({ code, message: text, cause: domainError })
      expect(clientMessage(error)).toBe(text)
      // Its own: not what any other refusal with this status says.
      const generic = toTRPCError(new DomainError('UNLISTED', 'Unlisted', domainError.httpStatus))
      expect(text).not.toBe(generic.message)
      // No English and no codes; the seller issues neither VAT prices nor receipts.
      expect(text).not.toMatch(/[A-Za-z]|НДС|чек/i)
      // Formal «вы» or an impersonal sentence, and a next step after the first one.
      expect(text).not.toMatch(/(?:^|[^а-яё])(?:ты|тебя|тебе|твой|твоя|твоё|твои)(?:[^а-яё]|$)/i)
      expect(text.split('. ').length).toBeGreaterThanOrEqual(2)
    },
  )

  it.each([
    [
      'SITE_CONNECTION_UNAVAILABLE',
      503,
      'SERVICE_UNAVAILABLE',
      'Подключение сайтов сейчас недоступно. Попробуйте ещё раз немного позже',
    ],
    ['SITE_STACK_NOT_CONNECTABLE', 400, 'BAD_REQUEST', 'Эту платформу мы пока не подключаем'],
    [
      'SITE_CHECKS_LIMITED',
      429,
      'TOO_MANY_REQUESTS',
      'Слишком много проверок подряд. Подождите несколько минут и попробуйте снова',
    ],
    [
      'SITE_CONNECTIONS_BUSY',
      429,
      'TOO_MANY_REQUESTS',
      'Сейчас подключаются три ваших сайта. Дождитесь, пока закончится хотя бы одно подключение',
    ],
    [
      'PROJECT_CREATION_IN_PROGRESS',
      409,
      'CONFLICT',
      'Проект уже добавляется. Подождите несколько секунд',
    ],
    [
      'PROJECT_REQUEST_CONFLICT',
      409,
      'CONFLICT',
      'Из этого окна уже добавлен проект с другим адресом. Откройте список проектов или начните добавление заново',
    ],
    [
      'SITE_SETUP_NOT_FAILED',
      409,
      'CONFLICT',
      'Настройку сейчас нельзя повторить. Обновите страницу, чтобы увидеть, как она идёт',
    ],
    [
      'SITE_SETUP_RETRIES_LIMITED',
      429,
      'TOO_MANY_REQUESTS',
      'Повторять настройку можно не чаще шести раз в час. Попробуйте немного позже',
    ],
    [
      'SITE_SETUP_UNAVAILABLE',
      409,
      'CONFLICT',
      'Настройку этого сайта уже нельзя повторить. Обновите страницу, чтобы увидеть, что изменилось',
    ],
  ] as const)(
    'gives the refusal %s of the site connection wizard its own Russian text',
    (domainCode, status, code, text) => {
      const domainError = new DomainError(domainCode, 'English text for the logs', status)

      const error = toTRPCError(domainError)

      expect(error).toMatchObject({ code, message: text, cause: domainError })
      expect(clientMessage(error)).toBe(text)
      const generic = toTRPCError(new DomainError('UNLISTED', 'Unlisted', status))
      expect(text).not.toBe(generic.message)
      // No English, no jargon of the protocols, no final full stop; formal «вы» or impersonal.
      expect(text).not.toMatch(/[A-Za-z]|SSH|FTP|Vault/)
      expect(text).not.toMatch(/\.$/)
      expect(text).not.toMatch(/(?:^|[^а-яё])(?:ты|тебя|тебе|твой|твоя|твоё|твои)(?:[^а-яё]|$)/i)
    },
  )

  it('names in its words the very limits of the wizard that the texts promise', () => {
    // The texts spell the numbers out; a changed limit must change its sentence too.
    expect(siteConnectionLimits.connectionsInProgressPerUser).toBe(3)
    expect(siteConnectionLimits.retriesPerHour).toBe(6)
  })

  it('falls back by status class', () => {
    expect(trpcCodeForStatus(451)).toBe('BAD_REQUEST')
    expect(trpcCodeForStatus(507)).toBe('INTERNAL_SERVER_ERROR')
  })
})

describe('domain errors in procedures', () => {
  const testRouter = router({
    missing: publicProcedure.query(() => {
      throw notFound('Site not found')
    }),
    busy: publicProcedure.query(async () => {
      await Promise.resolve()
      throw conflict('Task is running')
    }),
    crash: publicProcedure.query(() => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432')
    }),
  })
  const ctx = { headers: new Headers(), session: null, user: null } as unknown as Context
  const caller = createCallerFactory(testRouter)(ctx)

  it('get the matching code and the Russian text', async () => {
    await expect(caller.missing()).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Не нашли то, что вы ищете',
    })
    await expect(caller.busy()).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Действие сейчас недоступно',
    })
  })

  it('leave other failures internal', async () => {
    await expect(caller.crash()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
  })
})

describe('formatError', () => {
  const shape = (code: string, httpStatus: number, message: string) => ({
    message,
    code: -32000,
    data: { code, httpStatus, path: 'site.get', stack: 'Error: at secret.ts:1' },
  })

  it('shows the Russian text of the domain code, never the domain message or the stack', () => {
    const cause = notImplemented('Bitrix adapter')
    const error = new TRPCError({ code: 'NOT_IMPLEMENTED', message: cause.message, cause })

    const formatted = formatError(shape('NOT_IMPLEMENTED', 501, cause.message), error, false)

    expect(formatted.message).toBe('Эта возможность ещё в разработке')
    expect(formatted.data).toEqual({
      code: 'NOT_IMPLEMENTED',
      httpStatus: 501,
      path: 'site.get',
      domainCode: 'NOT_IMPLEMENTED',
    })
  })

  it('falls back to the text of the tRPC code for an unlisted domain code', () => {
    const cause = new DomainError('QUOTA_EXCEEDED', 'Daily quota exceeded', 402)
    const error = new TRPCError({ code: 'PAYMENT_REQUIRED', cause })

    const formatted = formatError(shape('PAYMENT_REQUIRED', 402, cause.message), error, false)

    expect(formatted.message).toBe('Для этого действия нужна оплата')
    expect(formatted.data.domainCode).toBe('QUOTA_EXCEEDED')
  })

  it('hides the text of unexpected errors outside dev', () => {
    const error = new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      cause: new Error('password=hunter2'),
    })
    const formatted = formatError(
      shape('INTERNAL_SERVER_ERROR', 500, 'password=hunter2'),
      error,
      false,
    )

    expect(formatted.message).toBe(INTERNAL_ERROR_MESSAGE)
    expect(formatted.data).not.toHaveProperty('stack')
    expect(formatted.data).not.toHaveProperty('details')
    expect(formatted.data.domainCode).toBeNull()
  })

  it('replaces zod messages with a generic text and keeps the issues for dev only', () => {
    const zodError = z.object({ url: z.url() }).safeParse({ url: 'nope' }).error
    const error = new TRPCError({ code: 'BAD_REQUEST', cause: zodError })

    const prod = formatError(shape('BAD_REQUEST', 400, error.message), error, false)
    expect(prod.message).toBe(INVALID_INPUT_MESSAGE)
    expect(prod.data).not.toHaveProperty('details')

    const dev = formatError(shape('BAD_REQUEST', 400, error.message), error, true)
    expect(dev.message).toBe(INVALID_INPUT_MESSAGE)
    expect(dev.data.details?.message).toBe(error.message)
    expect(dev.data.details?.issues).toEqual(zodError?.issues)
  })

  it('replaces the English messages of tRPC itself', () => {
    const error = new TRPCError({ code: 'NOT_FOUND', message: 'No procedure found on path "x"' })
    expect(clientMessage(error)).toBe('Не нашли то, что вы ищете')
  })

  it('keeps the Russian text and adds the details for the developer in dev', () => {
    const cause = notFound('Site 42 not found')
    const error = new TRPCError({ code: 'NOT_FOUND', cause })
    const formatted = formatError(shape('NOT_FOUND', 404, 'Site 42 not found'), error, true)

    expect(formatted.message).toBe('Не нашли то, что вы ищете')
    expect(formatted.data.details).toEqual({ message: 'Site 42 not found' })
    expect(formatted.data.stack).toBe('Error: at secret.ts:1')
  })
})

describe('errors over HTTP', () => {
  const testRouter = router({
    missing: publicProcedure.query(() => {
      throw notFound('Site 42 not found')
    }),
    echo: publicProcedure.input(z.object({ url: z.url() })).query(({ input }) => input.url),
  })
  const ctx = { headers: new Headers(), session: null, user: null } as unknown as Context
  const call = (path: string) =>
    fetchRequestHandler({
      endpoint: '/api/trpc',
      req: new Request(`http://localhost:3000/api/trpc/${path}`),
      router: testRouter,
      createContext: () => ctx,
    })
  const errorOf = async (response: Response) =>
    ((await response.json()) as { error: { json: { message: string; data: object } } }).error.json

  it.each([
    ['a domain error', 'missing', 404, 'Не нашли то, что вы ищете', 'Site 42'],
    [
      'invalid input',
      `echo?input=${encodeURIComponent(JSON.stringify({ json: { url: 'nope' } }))}`,
      400,
      INVALID_INPUT_MESSAGE,
      'Invalid URL',
    ],
    ['an unknown procedure', 'nothing.here', 404, 'Не нашли то, что вы ищете', 'No procedure'],
  ])('answer %s in Russian only', async (_case, path, status, message, raw) => {
    const response = await call(path)

    expect(response.status).toBe(status)
    const body = await errorOf(response)
    expect(body.message).toBe(message)
    expect(JSON.stringify(body)).not.toContain(raw)
  })
})

describe('a text that names a number of the refusal', () => {
  const planLimit = (details?: unknown) =>
    new DomainError(
      'PROJECT_PLAN_LIMIT_REACHED',
      'The plan of the workspace allows no more sites',
      403,
      details,
    )
  const another = 'Чтобы добавить ещё один, выберите другой тариф в настройках'

  it.each([
    [1, `В ваш тариф входит один сайт. ${another}`],
    [2, `В ваш тариф входит до 2 сайтов. ${another}`],
    [3, `В ваш тариф входит до 3 сайтов. ${another}`],
    [11, `В ваш тариф входит до 11 сайтов. ${another}`],
    [15, `В ваш тариф входит до 15 сайтов. ${another}`],
    [21, `В ваш тариф входит до 21 сайта. ${another}`],
    [111, `В ваш тариф входит до 111 сайтов. ${another}`],
  ])('names the site limit of the tariff: %i', (maxSites, message) => {
    const error = toTRPCError(planLimit({ maxSites }))

    expect(error).toMatchObject({ code: 'FORBIDDEN', message })
    // The same text on the way to the browser, with the code and without the details.
    expect(clientMessage(error)).toBe(message)
    const shape = {
      message: error.message,
      code: -32003,
      data: { code: 'FORBIDDEN', httpStatus: 403 },
    }
    expect(formatError(shape, error, false)).toEqual({
      ...shape,
      data: { ...shape.data, domainCode: 'PROJECT_PLAN_LIMIT_REACHED' },
    })
  })

  it.each([
    undefined,
    null,
    'three',
    {},
    { maxSites: '3' },
    { maxSites: 0 },
    { maxSites: -1 },
    { maxSites: 2.5 },
    { maxSites: Number.NaN },
    { maxSites: Number.POSITIVE_INFINITY },
  ])('says the same without the number when the details do not carry it: %o', (details) => {
    expect(toTRPCError(planLimit(details)).message).toBe(
      `На вашем тарифе больше нельзя добавить сайт. ${another}`,
    )
  })

  it.each([
    [1, `В тариф, который вы оплачиваете, входит один сайт. ${another}`],
    [3, `В тариф, который вы оплачиваете, входит до 3 сайтов. ${another}`],
    [21, `В тариф, который вы оплачиваете, входит до 21 сайта. ${another}`],
  ])('names the limit of a tariff that is being paid for as such: %i', (maxSites, message) => {
    const error = toTRPCError(planLimit({ maxSites, unpaid: true }))

    expect(error).toMatchObject({ code: 'FORBIDDEN', message })
    expect(clientMessage(error)).toBe(message)
  })

  it.each([false, 'true', 1, null, undefined])(
    'speaks of the tariff the customer has unless the details say «unpaid»: %o',
    (unpaid) => {
      expect(toTRPCError(planLimit({ maxSites: 3, unpaid })).message).toBe(
        `В ваш тариф входит до 3 сайтов. ${another}`,
      )
    },
  )

  describe('the limit of the tariff chosen for the next period', () => {
    // The customer may be on a tariff that holds more: «в ваш тариф входит…» would not be true.
    const takeBack =
      'Чтобы добавить ещё один, отмените переход или выберите другой тариф в настройках'

    it.each([
      [1, `В тариф, который вы выбрали на следующий период, входит один сайт. ${takeBack}`],
      [3, `В тариф, который вы выбрали на следующий период, входит до 3 сайтов. ${takeBack}`],
      [21, `В тариф, который вы выбрали на следующий период, входит до 21 сайта. ${takeBack}`],
    ])('is named as such, with the way to take the choice back: %i', (maxSites, message) => {
      const error = toTRPCError(planLimit({ maxSites, scheduled: true }))

      expect(error).toMatchObject({ code: 'FORBIDDEN', message })
      expect(clientMessage(error)).toBe(message)
      expect(message).not.toContain('В ваш тариф')
    })

    it.each([false, 'true', 1, null, undefined])(
      'is not spoken of unless the details say «scheduled»: %o',
      (scheduled) => {
        expect(toTRPCError(planLimit({ maxSites: 3, scheduled })).message).toBe(
          `В ваш тариф входит до 3 сайтов. ${another}`,
        )
      },
    )

    it('gives way to a tariff that is being paid for: its charge cannot be taken back', () => {
      expect(toTRPCError(planLimit({ maxSites: 1, unpaid: true, scheduled: true })).message).toBe(
        `В тариф, который вы оплачиваете, входит один сайт. ${another}`,
      )
    })

    it('says the same without the number as any other limit', () => {
      expect(toTRPCError(planLimit({ scheduled: true })).message).toBe(
        `На вашем тарифе больше нельзя добавить сайт. ${another}`,
      )
    })
  })

  it('reads the details of that code only', () => {
    expect(
      toTRPCError(new DomainError('FORBIDDEN', 'Not the owner', 403, { maxSites: 3 })).message,
    ).toBe('Недостаточно прав')
    expect(
      toTRPCError(new DomainError('PROJECT_LIMIT_REACHED', 'Ceiling', 403, { maxSites: 3 }))
        .message,
    ).toBe('Вы добавили максимальное число сайтов. Напишите нам, если нужно больше')
  })
})

describe('the text of a refused task, built from the details of its refusal', () => {
  const NBSP = String.fromCharCode(0xa0)
  /** The refusal of the queue as it is thrown: the code of the reason, and the numbers. */
  const refused = (reason: TaskRefusalReason, spendable = 0, held = 0, needed = 5) =>
    taskRefusal({ reason, spendable, held, needed })
  const GENERAL = {
    notEnough:
      'Лимиты закончились: кредитов не хватает, чтобы начать задачу. Купите пакет кредитов или дождитесь начисления по тарифу — подробности в разделе «Использование»',
    held: 'Все кредиты отложены под задачи в работе. Дождитесь, пока они закончатся, или купите пакет кредитов',
    needsTariff:
      'Чтобы ставить задачи, нужен действующий тариф. Выберите или оплатите его в разделе «Тарифы»',
    dailyLimit: 'Лимит задач на сегодня исчерпан. Новую задачу можно будет поставить завтра',
    unpaidLimit:
      'Новые задачи временно не принимаются: слишком много задач остановилось без результата. Напишите нам — разберёмся, в чём дело',
    rateMissing:
      'Задачи сейчас не принимаются: мы обновляем расчёт кредитов. Попробуйте ещё раз немного позже',
  }
  const choosePlan = 'Выберите тариф в разделе «Тарифы»'

  it.each([
    [1, 'Лимиты закончились: остался 1 кредит, а на новую задачу нужно не меньше 5.'],
    [2, 'Лимиты закончились: осталось 2 кредита, а на новую задачу нужно не меньше 5.'],
    [3, 'Лимиты закончились: осталось 3 кредита, а на новую задачу нужно не меньше 5.'],
    [4, 'Лимиты закончились: осталось 4 кредита, а на новую задачу нужно не меньше 5.'],
  ])('names the few credits that are left: %i', (spendable, first) => {
    const error = toTRPCError(refused('below_start', spendable))

    expect(error).toMatchObject({
      code: 'PAYMENT_REQUIRED',
      message: `${first} Купите пакет кредитов или дождитесь начисления по тарифу`,
    })
    expect(clientMessage(error)).toBe(error.message)
  })

  it('says «limits ran out» in general words when no credit is left, or when the numbers do not say «a few»', () => {
    expect(toTRPCError(refused('empty', 0)).message).toBe(GENERAL.notEnough)
    // The numbers of another refusal under this code: nothing is made up from them.
    expect(toTRPCError(billingNotEnoughCredits()).message).toBe(GENERAL.notEnough)
    expect(
      toTRPCError(
        billingNotEnoughCredits({ reason: 'below_start', spendable: 7, held: 0, needed: 5 }),
      ).message,
    ).toBe(GENERAL.notEnough)
  })

  it.each([
    [1, '1'],
    [45, '45'],
    [90, '90'],
    [2500, `2${NBSP}500`],
    [12345, `12${NBSP}345`],
  ])('names how many credits tasks in work have set aside: %i', (held, printed) => {
    expect(toTRPCError(refused('held', 2, held))).toMatchObject({
      code: 'CONFLICT',
      message: `Кредиты заняты задачами в работе: под них отложено ${printed}. Дождитесь, пока задачи закончатся, или купите пакет кредитов`,
    })
  })

  it('says «credits are set aside» in general words without the number', () => {
    expect(toTRPCError(billingCreditsHeld()).message).toBe(GENERAL.held)
    expect(
      toTRPCError(billingCreditsHeld({ reason: 'held', spendable: 0, held: 0, needed: 5 })).message,
    ).toBe(GENERAL.held)
  })

  it.each([
    ['gift_spent', 0, 'Подарочные кредиты закончились.'],
    ['gift_below_start', 1, 'Остался 1 подарочный кредит, а на новую задачу нужно не меньше 5.'],
    ['gift_below_start', 3, 'Осталось 3 подарочных кредита, а на новую задачу нужно не меньше 5.'],
    [
      'trial_unpaid_limit',
      15,
      'Пробные задачи закончились: несколько задач остановились без результата, и без тарифа мы больше не можем их принимать.',
    ],
    [
      'gift_site_used',
      35,
      'На этом сайте подарочные кредиты уже использовались в другом аккаунте.',
    ],
  ] as const)(
    'tells why a task needs a tariff, and then the way to one: %s, %i left',
    (reason, spendable, first) => {
      expect(toTRPCError(refused(reason, spendable))).toMatchObject({
        code: 'PAYMENT_REQUIRED',
        message: `${first} ${choosePlan}`,
      })
    },
  )

  it.each(['past_due', 'ended'] as const)(
    'says «a tariff is needed» in general words for a tariff that is %s',
    (reason) => {
      expect(toTRPCError(refused(reason)).message).toBe(GENERAL.needsTariff)
    },
  )

  it('says the general words of the code when the details are not those of a refused task', () => {
    for (const details of [
      undefined,
      null,
      'gift_spent',
      {},
      { reason: 'gift_spent' },
      { reason: 'no_such_reason', spendable: 0, held: 0, needed: 5 },
      { reason: 'gift_below_start', spendable: '3', held: 0, needed: 5 },
      { reason: 'gift_below_start', spendable: 2.5, held: 0, needed: 5 },
      { reason: 'gift_below_start', spendable: -1, held: 0, needed: 5 },
      // Anything beside the four fields: the details are not what the queue throws.
      { reason: 'gift_spent', spendable: 0, held: 0, needed: 5, userId: 'u' },
    ]) {
      const error = new DomainError('BILLING_TASK_NEEDS_SUBSCRIPTION', 'Refused', 402, details)
      expect(toTRPCError(error).message).toBe(GENERAL.needsTariff)
    }
  })

  it('keeps the general words of the codes whose refusal names no number', () => {
    expect(toTRPCError(refused('daily_limit', 290)).message).toBe(GENERAL.dailyLimit)
    expect(toTRPCError(refused('trial_daily_limit', 20)).message).toBe(GENERAL.dailyLimit)
    expect(toTRPCError(refused('unpaid_limit', 300)).message).toBe(GENERAL.unpaidLimit)
    expect(toTRPCError(refused('rate_missing', 300)).message).toBe(GENERAL.rateMissing)
  })

  it('gives every reason of a refusal a text that passes the rules of a client text', () => {
    for (const reason of taskRefusalReasons) {
      for (const [spendable, held] of [
        [0, 0],
        [3, 0],
        [2, 45],
        [300, 0],
      ] as const) {
        const error = toTRPCError(refused(reason, spendable, held))
        const text = clientMessage(error)
        // No English and no codes; the seller issues neither VAT prices nor receipts.
        expect(text).not.toMatch(/[A-Za-z]|НДС|чек/i)
        expect(text).not.toMatch(/(?:^|[^а-яё])(?:ты|тебя|тебе|твой|твоя|твоё|твои)(?:[^а-яё]|$)/i)
        // A next step after the first sentence, and no full stop at the end, like the others.
        expect(text.split('. ').length).toBeGreaterThanOrEqual(2)
        expect(text.endsWith('.')).toBe(false)
        // The numbers of the refusal never leave as they are: the browser gets a sentence.
        const shape = {
          message: text,
          code: -32000,
          data: { code: error.code, httpStatus: 402 },
        }
        const formatted = formatError(shape, error, false)
        expect(formatted.message).toBe(text)
        expect(formatted.data).toEqual({
          ...shape.data,
          domainCode: error.cause && (error.cause as DomainError).code,
        })
        expect(JSON.stringify(formatted)).not.toContain('spendable')
      }
    }
  })
})

describe('the refusals of a dialog, its preview and its release', () => {
  const codes = [
    ['CHAT_NOT_CONFIGURED', 503],
    ['TASK_NOT_ACCEPTED', 409],
    ['TASK_TEXT_EMPTY', 400],
    ['TASK_TEXT_TOO_LONG', 400],
    ['TASK_TEXT_HAS_SECRET', 400],
    ['TASK_TEXT_INVALID', 400],
    ['TASK_BUSY', 409],
    ['TASK_FINISHED', 409],
    ['TASK_CONTINUE_REQUIRED', 409],
    ['TASK_NOTHING_TO_CONTINUE', 409],
    ['TASK_ATTEMPTS_EXHAUSTED', 409],
    ['TASK_NOTHING_TO_RETRY', 409],
    ['CHAT_COMMAND_UNAVAILABLE', 409],
    ['RELEASE_IN_PROGRESS', 409],
    ['RELEASE_CONFIRMATION_INVALID', 400],
    ['RELEASE_CONFIRMATION_EXPIRED', 409],
    ['RELEASE_CANDIDATE_CHANGED', 409],
    ['RELEASE_VERSION_TAKEN', 409],
    ['RELEASE_REVIEW_REQUIRED', 409],
    ['RELEASE_VERSION_NOT_OFFERED', 409],
    ['RELEASE_UNDO_PLAN_CHANGED', 409],
    ['RELEASE_UNDO_VERSION_TAKEN', 409],
    ['PREVIEW_NOT_READY', 409],
    ['SITE_ENV_NOT_ALLOWED', 403],
    ['SITE_ENV_NAME_INVALID', 400],
    ['SITE_ENV_NAME_RESERVED', 400],
    ['SITE_ENV_VALUE_INVALID', 400],
    ['SITE_ENV_HOSTS_INVALID', 400],
    ['SITE_ENV_CONSENT_REQUIRED', 400],
    ['SITE_ENV_AGENT_CLOSED', 409],
    ['SITE_ENV_LIMIT', 409],
    ['SITE_ENV_HOSTS_LIMIT', 409],
    ['SITE_ENV_CHANGED', 409],
  ] as const

  it.each(codes)('gives %s its own Russian text on «вы», without English', (domainCode, status) => {
    const error = toTRPCError(new DomainError(domainCode, 'English text for the logs', status))
    const generic = toTRPCError(new DomainError('UNLISTED', 'Unlisted', status))

    expect(error.message).not.toBe(generic.message)
    expect(error.message).not.toMatch(/[A-Za-z]/)
    expect(error.message).not.toMatch(
      /(?:^|[^а-яё])(?:ты|тебя|тебе|твой|твоя|твоё|твои)(?:[^а-яё]|$)/i,
    )
    expect(error.message).not.toMatch(/\.$/)
  })

  it('tells why a dialog is not taken by the reason of the refusal', () => {
    const text = (reason?: string) =>
      toTRPCError(
        new DomainError(
          'TASK_NOT_ACCEPTED',
          'Not accepted',
          409,
          reason === undefined ? undefined : { reason },
        ),
      ).message
    expect(text('site_not_active')).toContain('сайт ещё не подключён')
    expect(text('not_synthetic')).toContain('тестовая среда')
    expect(text('class_unavailable')).toContain('не можем повторить работу')
    expect(text('other')).toBe('Задания для этого сайта сейчас не принимаются')
    expect(text()).toBe('Задания для этого сайта сейчас не принимаются')
  })

  it('says of a refused command what the list of commands says of it', () => {
    const text = (details: unknown) =>
      toTRPCError(new DomainError('CHAT_COMMAND_UNAVAILABLE', 'Refused', 409, details)).message
    expect(text({ command: 'release', refusal: 'not_allowed' })).toBe(
      'Выпускать и отменять версии могут владелец и администраторы',
    )
    expect(text({ command: 'reset', refusal: 'busy' })).toBe('Подождите: агент ещё работает')
    expect(text({ refusal: 'launch' })).toBe(
      'Эта команда сейчас недоступна. Обновите страницу, чтобы увидеть, что изменилось',
    )
    expect(text(null)).toBe(
      'Эта команда сейчас недоступна. Обновите страницу, чтобы увидеть, что изменилось',
    )
  })

  it('names the refusal of a command to the screen, and nothing else of the details', () => {
    const shape = { message: 'Refused', code: -32009, data: { code: 'CONFLICT', httpStatus: 409 } }
    const formatted = (code: string, details: unknown) =>
      formatError(shape, toTRPCError(new DomainError(code, 'Refused', 409, details)), false)

    expect(
      formatted('CHAT_COMMAND_UNAVAILABLE', { command: 'preview', refusal: 'preview_failed' }),
    ).toEqual({
      ...shape,
      message:
        'Предпросмотр не удалось подготовить. Сбросьте данные предпросмотра — мы соберём его заново',
      data: {
        ...shape.data,
        domainCode: 'CHAT_COMMAND_UNAVAILABLE',
        refusal: 'preview_failed',
      },
    })
    // An unknown refusal, or the details of another code, are not passed on.
    expect(formatted('CHAT_COMMAND_UNAVAILABLE', { refusal: 'launch' }).data).not.toHaveProperty(
      'refusal',
    )
    expect(formatted('TASK_NOT_ACCEPTED', { refusal: 'busy' }).data).not.toHaveProperty('refusal')
  })
})
