import { readFileSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'

import {
  approveCreditRate,
  closeUnknownCharge,
  listRefundsNeeded,
  MAX_REFUNDS_NEEDED,
  operatorActionSchema,
  parseCreditRates,
  refundOrder,
  refundReasons,
  refundRefusals,
  settleOrderByPaymentId,
  stopAutoRenewalByOperator,
  stopRenewalRefusals,
  TURN_KEY_LIMIT_RUB,
  type CreditRatePreview,
  type CreditRateRefusal,
  type CreditRatesProblem,
  type OperatorAutoRenewalStop,
  type OrderRefund,
  type OrderSettlement,
  type RefundNeeded,
  type UnappliedRefundOption,
  type UnknownCharge,
} from '@repo/billing'
import { createPrismaClient, dbConfigFromEnv, type PrismaClient } from '@repo/db'
import {
  appEnvSchema,
  envVar,
  isDomainError,
  parseEnv,
  type AppEnv,
  type Env,
  type OrderStatus,
} from '@repo/domain'
import {
  createYookassaClient,
  YookassaApiError,
  YookassaError,
  yookassaConfigFromEnv,
} from '@repo/yookassa'
import { z } from 'zod'

// The operator's commands of billing (docs/plan/37-billing-plan.md, M5.16 and M5.25). Five
// commands, each a thin entrypoint over @repo/billing: no Nest application, no queue, no `.env`
// discovery.
//
//   pnpm --filter orchestrator billing:refund -- <orderId> --reason "…"
//        [--end-subscription] [--take-credits] [--refunded-in-cabinet] [--operator <name>]
//     Returns the whole payment of a paid order through ЮKassa and marks the order refunded.
//     Without an option only the money moves. --end-subscription also ends the tariff the
//     order paid for, now, and expires what is left of its quota; --take-credits also takes the
//     credits of the refunded pack that are still available. Safe to repeat: a second run never
//     makes a second refund, and it is how a refund ЮKassa left pending is finished, how one
//     ЮKassa cancelled is asked for anew and how an option is applied after the money has gone
//     back. --refunded-in-cabinet asks for no refund: the whole payment was returned in the
//     ЮKassa cabinet, and once ЮKassa confirms it the order is marked refunded; the other two
//     options then work as for any refunded order.
//
//   pnpm --filter orchestrator billing:stop-renewal -- <email> --reason "…" [--operator <name>]
//   pnpm --filter orchestrator billing:stop-renewal -- --workspace <UUID> --reason "…"
//     Switches auto-renewal of the customer's tariff off, as the customer's own switch does:
//     the tariff works to the end of its period, the saved payment method stays. Prints the
//     address that matched and where a renewal charge that was started before stands: that
//     charge is not stopped.
//
//   pnpm --filter orchestrator billing:refunds-needed [-- --limit <N>]
//     Lists what waits for an operator, in three sections: the orders whose money waits to be
//     returned (the open `billing.order.refund_needed` audit entries) with order, payment,
//     amount, reason and how to return it; the renewal charges that were given up without an
//     answer («Списания без ответа») with what to look their payment up by; and the refunded
//     orders whose option was asked for while the refund was pending and never applied, with
//     the command to run. Reads only.
//
//   pnpm --filter orchestrator billing:settle-payment -- <paymentId>
//   pnpm --filter orchestrator billing:settle-payment -- --order <orderId> --not-found
//        --reason "…" [--operator <name>]
//     Closes a charge without an answer by a fact. With the id of the payment found in the
//     ЮKassa cabinet: reads the payment back and settles its order exactly as its notification
//     would have (a payment whose id the order never stored is attached to it first); money
//     that came for a closed order then appears in billing:refunds-needed. With --not-found:
//     records that the shop holds no payment of the order, which takes it off the list.
//
//   pnpm --filter orchestrator billing:rates -- --file <rates.json> --reason "…"
//        [--effective-from <ISO instant>] [--confirm-exposure] [--confirm-mixed-models]
//        [--operator <name>]
//     Approves the credit rate K, with or without new accounting rates of the models: the one
//     way a row of `credit_rates` or of `llm_model_prices` is written. The file holds
//     `rubPerCredit`, `basis` and `prices` — a list, possibly empty, of { provider, model,
//     inputPer1m, cacheReadPer1m, cacheWritePer1m, outputPer1m, vatRate, sourceUrl } by the
//     slugs of the catalogue; every amount is a string. The listed price rows and one rate row
//     are written with one start in one transaction: the clock of the database, or a later
//     instant given by --effective-from. Before it writes, the command prints what the rate
//     means for the platform: the accounting cost behind every tariff and pack and its share of
//     the price, the pack and gift credits not spent yet in roubles, the steps of an attempt
//     against the limit of one turn key and credits per million tokens for every enabled model.
//     It writes nothing and exits non-zero when the start is in the past or not later than the
//     newest row there is, when a model is unknown, when the file has prices and no rate, when
//     a tariff would cost more than half of its price or the rate moves by more than a tenth
//     and --confirm-exposure is not given, and when enabled models of one class would have
//     different prices and --confirm-mixed-models is not given. Not safe to repeat: every run
//     that is not refused adds a row. It reads no shop variable.
//
// Environment, given explicitly (the commands load no `.env`): the variables the core role
// reads for the same things — APP_ENV and DATABASE_URL for all five; YOOKASSA_SHOP_ID and
// YOOKASSA_SECRET_KEY for billing:refund and for billing:settle-payment with a payment id, in
// production with YOOKASSA_AUTOPAYMENTS (the shop settings ask for it there; the commands save
// and charge nothing, they are given what core has), and outside production YOOKASSA_API_URL
// for a local fake; APP_URL for billing:settle-payment with a payment id (a payment that is
// applied writes its letter, which links to the app). Nothing secret is taken from the command
// line or printed. On the app VM the commands run in the image of the orchestrator with the
// environment of `core`:
//   docker compose run --rm --no-deps --entrypoint node core scripts/billing-refund.mjs <orderId> …
//
// --operator is the name kept in audit_log; without it the name of the OS user is taken, and a
// process that has none (a container uid) must give the option. Every command prints what it
// is about to do, then what was done, in Russian, and exits non-zero when it was refused or
// the refund did not go through. Refusals are fixed texts: nothing a database, ЮKassa or a
// customer wrote reaches the terminal except ids, amounts and dates.

export type BillingCommand =
  'refund' | 'stop-renewal' | 'refunds-needed' | 'settle-payment' | 'rates'

const invalid = () => new Error('Неверные параметры команды биллинга. Используйте --help.')
class OperatorCommandError extends Error {}

const uuid = z.uuid().transform((id) => id.toLowerCase())
const { operator, reason } = operatorActionSchema.shape

const refundSchema = z.strictObject({
  orderId: uuid,
  reason,
  operator: operator.optional(),
  endSubscription: z.boolean().default(false),
  takeCredits: z.boolean().default(false),
  refundedInCabinet: z.boolean().default(false),
})
const stopSchema = z
  .strictObject({
    email: z.email().max(255).optional(),
    workspace: uuid.optional(),
    reason,
    operator: operator.optional(),
  })
  // The customer is named once: by the address or by the workspace.
  .refine((value) => (value.email === undefined) !== (value.workspace === undefined))
const neededSchema = z.strictObject({
  limit: z
    .string()
    .regex(/^\d{1,4}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_REFUNDS_NEEDED))
    .optional(),
})

// The payment is named by its id alone, or the order with the word that no payment exists.
const settleSchema = z.union([
  z.strictObject({
    // An id of ЮKassa is a UUID; orders.yookassa_payment_id holds 64 characters.
    paymentId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  }),
  z.strictObject({
    order: uuid,
    notFound: z.literal(true),
    reason,
    operator: operator.optional(),
  }),
])

// An instant with its offset, to the millisecond at most: what `credit_rates.effective_from`
// holds. A date without an offset would be read by the clock of whoever runs the command.
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/)
  // The day and the hour as written must exist. `new Date` rolls 30 February over into March
  // and 24:00 into the next day, and a start nobody typed would go into a table that only
  // grows: the written date and time, read as UTC, must print back as they were written.
  .refine((text) => {
    const written = text.slice(0, 16)
    const read = new Date(`${written}Z`)
    return Number.isFinite(read.getTime()) && read.toISOString().startsWith(written)
  })
  .transform((text) => new Date(text))
  .refine((date) => Number.isFinite(date.getTime()))

const ratesSchema = z.strictObject({
  file: z.string().min(1).max(4096),
  reason,
  operator: operator.optional(),
  effectiveFrom: instant.optional(),
  confirmExposure: z.boolean().default(false),
  confirmMixedModels: z.boolean().default(false),
})

export type BillingOptions =
  | { command: BillingCommand; help: true }
  | { command: 'refund'; help: false; value: z.output<typeof refundSchema> }
  | { command: 'stop-renewal'; help: false; value: z.output<typeof stopSchema> }
  | { command: 'refunds-needed'; help: false; value: z.output<typeof neededSchema> }
  | { command: 'settle-payment'; help: false; value: z.output<typeof settleSchema> }
  | { command: 'rates'; help: false; value: z.output<typeof ratesSchema> }

const flags: Record<BillingCommand, Record<string, string>> = {
  refund: {
    '--reason': 'reason',
    '--operator': 'operator',
    '--end-subscription': 'endSubscription',
    '--take-credits': 'takeCredits',
    '--refunded-in-cabinet': 'refundedInCabinet',
  },
  'stop-renewal': { '--reason': 'reason', '--operator': 'operator', '--workspace': 'workspace' },
  'refunds-needed': { '--limit': 'limit' },
  'settle-payment': {
    '--order': 'order',
    '--not-found': 'notFound',
    '--reason': 'reason',
    '--operator': 'operator',
  },
  rates: {
    '--file': 'file',
    '--reason': 'reason',
    '--operator': 'operator',
    '--effective-from': 'effectiveFrom',
    '--confirm-exposure': 'confirmExposure',
    '--confirm-mixed-models': 'confirmMixedModels',
  },
}
const booleans = new Set([
  'endSubscription',
  'takeCredits',
  'refundedInCabinet',
  'notFound',
  'confirmExposure',
  'confirmMixedModels',
])
/** What the one argument without a flag names. */
const positional: Record<BillingCommand, string | null> = {
  refund: 'orderId',
  'stop-renewal': 'email',
  'refunds-needed': null,
  'settle-payment': 'paymentId',
  rates: null,
}

/** Strict argument parsing completes before reading the environment or connecting anywhere. */
export function parseBillingArguments(
  command: BillingCommand,
  written: readonly string[],
): BillingOptions {
  const args = written[0] === '--' ? written.slice(1) : written
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return { command, help: true }
  const value: Record<string, unknown> = {}
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!
    if (!arg.startsWith('-')) {
      const name = positional[command]
      if (name === null || Object.hasOwn(value, name)) throw invalid()
      value[name] = arg
      continue
    }
    const name = flags[command][arg]
    if (!name || Object.hasOwn(value, name)) throw invalid()
    if (booleans.has(name)) value[name] = true
    else {
      const next = args[++at]
      if (!next || next.startsWith('--')) throw invalid()
      value[name] = next
    }
  }
  const schema = {
    refund: refundSchema,
    'stop-renewal': stopSchema,
    'refunds-needed': neededSchema,
    'settle-payment': settleSchema,
    rates: ratesSchema,
  }
  const parsed = schema[command].safeParse(value)
  if (!parsed.success) throw invalid()
  return { command, help: false, value: parsed.data } as BillingOptions
}

export function billingHelp(command: BillingCommand): string {
  const usage = {
    refund:
      'billing:refund -- <UUID заказа> --reason "<причина>" [--end-subscription] [--take-credits] [--refunded-in-cabinet] [--operator <имя>]\n' +
      'Возвращает весь платёж оплаченного заказа через ЮKassa. Без параметров меняются только деньги.\n' +
      '--end-subscription — завершить сейчас тариф, оплаченный этим заказом; доступные кредиты тарифа сгорают.\n' +
      '--take-credits — снять доступные кредиты возвращаемого пакета; занятые задачами и потраченные не затрагиваются.\n' +
      '--refunded-in-cabinet — весь платёж уже вернули в кабинете ЮKassa: запрос на возврат не отправляется, заказ отмечается возвращённым, если ЮKassa это подтверждает.\n' +
      'Повтор команды безопасен: второй возврат не создаётся; им же завершают возврат, который ЮKassa ещё обрабатывала, и заново запрашивают возврат, который ЮKassa отменила.',
    'stop-renewal':
      'billing:stop-renewal -- <email клиента> --reason "<причина>" [--operator <имя>]\n' +
      'Либо: billing:stop-renewal -- --workspace <UUID рабочего пространства> --reason "<причина>".\n' +
      'Отключает автопродление тарифа по обращению клиента. Тариф действует до конца периода, способ оплаты остаётся.',
    'refunds-needed':
      'billing:refunds-needed [-- --limit <число>]\n' +
      'Показывает, что ждёт оператора: заказы, деньги по которым нужно вернуть (заказ, платёж, сумма, причина и способ возврата);\n' +
      'списания автопродления без ответа ЮKassa — и как найти их платёж; возвращённые заказы, у которых не применён запрошенный параметр.',
    'settle-payment':
      'billing:settle-payment -- <идентификатор платежа ЮKassa>\n' +
      'Либо: billing:settle-payment -- --order <UUID заказа> --not-found --reason "<причина>" [--operator <имя>].\n' +
      'Закрывает списание без ответа. С идентификатором платежа, найденного в кабинете ЮKassa, перечитывает платёж и проводит его заказ так же, как уведомление: зачисляет либо просит вернуть деньги.\n' +
      'С --not-found записывает, что платежа по заказу в ЮKassa нет: заказ уходит из списка billing:refunds-needed.',
    rates:
      'billing:rates -- --file <rates.json> --reason "<причина>" [--effective-from <момент ISO со смещением>] [--confirm-exposure] [--confirm-mixed-models] [--operator <имя>]\n' +
      'Утверждает курс кредита и учётные ставки моделей: строки ставок из файла и одна строка курса записываются с одним моментом начала, одной транзакцией. Другим способом курс и ставки не пишутся.\n' +
      'Файл — JSON: rubPerCredit (курс, ₽ учётной стоимости за кредит), basis (основание: корзина, модель, ставки, дата, кто утвердил) и prices — список, возможно пустой, из { provider, model, inputPer1m, cacheReadPer1m, cacheWritePer1m, outputPer1m, vatRate, sourceUrl }; суммы — строками, provider и model — slug из каталога. Пустой prices — изменение одного курса.\n' +
      'Перед записью команда печатает: учётную стоимость каждого тарифа и пакета и её долю в цене, не потраченные кредиты пакетов и подарков в рублях, шаги попытки против предела ключа хода и «кредитов за 1 млн токенов» по включённым моделям.\n' +
      '--effective-from — момент начала позже текущего, например 2026-11-01T00:00:00+03:00; без него — текущее время базы данных. Момент раньше текущего времени или не позже самой новой строки курса или ставок не принимается.\n' +
      '--confirm-exposure — нужен, когда учётная стоимость тарифа выше половины его цены или курс отличается от действующего больше чем на 10 %.\n' +
      '--confirm-mixed-models — нужен, когда у включённых моделей одного класса оказались бы разные ставки.\n' +
      'Повтор команды не безопасен: каждый запуск без отказа добавляет новую строку курса.',
  }
  const shopVariables =
    'YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY (в production — ещё YOOKASSA_AUTOPAYMENTS, как у core; вне production — YOOKASSA_API_URL подделки)'
  const shop = {
    refund: `, ${shopVariables}`,
    'stop-renewal': '',
    'refunds-needed': '',
    'settle-payment': `; с идентификатором платежа — ещё APP_URL, ${shopVariables}`,
    rates: '',
  }[command]
  const who =
    command === 'refunds-needed'
      ? ''
      : '--operator — имя оператора для журнала; без него берётся имя пользователя ОС.\n'
  return `${usage[command]}\n${who}Окружение задаётся явно; команда не загружает .env автоматически. Нужны APP_ENV и DATABASE_URL${shop}.\n`
}

const refusalTexts: Record<string, string> = {
  [refundRefusals.notPaid]: 'Заказ не оплачен: вернуть можно только оплаченный заказ.',
  [refundRefusals.noPayment]: 'У заказа нет платежа ЮKassa: возвращать нечего.',
  [refundRefusals.paymentMismatch]:
    'Платёж в ЮKassa не совпадает с заказом (сумма или статус). Возврат не запрошен: сверьте платёж вручную.',
  [refundRefusals.refundedElsewhere]:
    'По платежу уже есть возврат, о котором заказ не знает: он сделан не этой командой, по всей видимости в кабинете ЮKassa. Второй возврат не создаётся. Если вернули весь платёж, отметьте заказ возвращённым: повторите команду с --refunded-in-cabinet. Если вернули часть, остаток возвращают в кабинете ЮKassa; записи сверьте вручную.',
  [refundRefusals.refundMismatch]:
    'ЮKassa ответила возвратом другого платежа или другой суммы. Записи не изменены: сверьте возврат вручную.',
  [refundRefusals.noTariff]: '--end-subscription не подходит: этот заказ не оплачивал тариф.',
  [refundRefusals.notCurrentPeriod]:
    '--end-subscription не подходит: заказ оплатил не текущий период тарифа. Деньги не возвращались. Верните с --end-subscription заказ текущего периода либо этот заказ без параметра.',
  [refundRefusals.notPack]: '--take-credits подходит только заказу пакета кредитов.',
  [refundRefusals.cabinetNotFull]:
    '--refunded-in-cabinet не подходит: по данным ЮKassa платёж не возвращён полностью. Записи не изменены. Если по платежу ничего не возвращали, верните его этой командой без --refunded-in-cabinet; если вернули часть, верните остаток в кабинете ЮKassa и повторите команду.',
  [refundRefusals.cabinetOwnRefund]:
    '--refunded-in-cabinet не подходит: у заказа есть собственный возврат, запрошенный этой командой. Записи не изменены. Повторите команду без --refunded-in-cabinet: она завершит этот возврат.',
  [refundRefusals.notUnknownCharge]:
    'Заказ не числится списанием без ответа: закрывать нечего. В списке остаются только продления, закрытые без ответа ЮKassa, к которым не привязан платёж.',
  [stopRenewalRefusals.userNotFound]: 'Пользователь с таким адресом не найден.',
  [stopRenewalRefusals.userAmbiguous]:
    'Адрес совпадает больше чем с одним пользователем: укажите рабочее пространство через --workspace.',
}
const codeTexts: Record<string, string> = {
  BILLING_ORDER_NOT_FOUND: 'Заказ не найден.',
  BILLING_NO_LIVE_SUBSCRIPTION: 'У клиента нет действующего тарифа.',
  BILLING_NOTHING_TO_CHANGE: 'Автопродление уже отключено.',
}

/** Only fixed texts reach the operator; anything else may carry a credential or a response. */
export function operatorFailure(error: unknown): Error {
  if (error instanceof OperatorCommandError) return new Error(error.message)
  if (isDomainError(error)) {
    const known = error.code === 'CONFLICT' ? refusalTexts[error.message] : codeTexts[error.code]
    if (known) return new Error(known)
  }
  // A 4xx of the shop about this request: it was not served. The status and the code of the
  // answer are not secrets; its body is not shown.
  if (error instanceof YookassaApiError && !error.retryable) {
    const code = error.code && /^[a-z_]{1,64}$/.test(error.code) ? `, ${error.code}` : ''
    return new Error(`ЮKassa отклонила запрос (HTTP ${error.status}${code}). Записи не изменены.`)
  }
  if (error instanceof YookassaError) {
    return new Error(
      'ЮKassa не ответила или ответила непонятно: исход запроса неизвестен. Повторите команду позже — второй возврат не будет создан.',
    )
  }
  // Database and driver errors may quote a connection string or a row.
  return new Error(
    'Команда биллинга не завершена. Проверьте окружение и доступность базы данных и ЮKassa.',
  )
}

/** parseEnv names variables and rules, never their values. */
function configuration<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    throw new OperatorCommandError(
      `Окружение задано неверно: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`,
    )
  }
}

/** The name the audit entry keeps: the option, else the OS user of the process. */
function operatorName(given: string | undefined): string {
  if (given !== undefined) return given
  let name: string | undefined
  try {
    name = userInfo().username
  } catch {
    // A uid without a passwd entry: a container.
  }
  const parsed = operator.safeParse(name)
  if (!parsed.success) {
    throw new OperatorCommandError('Имя оператора не определено: укажите --operator <имя>.')
  }
  return parsed.data
}

const moscow = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})
const at = (moment: Date) => `${moscow.format(moment).replace(',', '')} МСК`

const orderStatusTexts: Record<OrderStatus, string> = {
  pending: 'ожидает оплаты',
  paid: 'оплачен',
  failed: 'оплата не прошла',
  refunded: 'возвращён',
  cancelled: 'отменён',
}

type Write = (text: string) => void

/** What the refund did, line by line; the lines name ids, amounts and dates only. */
export function refundReport(result: OrderRefund): string[] {
  const lines: string[] = []
  const refund = result.refundId === null ? 'Возврат' : `Возврат ${result.refundId}`
  if (result.state === 'refunded') {
    if (result.cabinet) {
      lines.push(
        'Заказ отмечен возвращённым: по данным ЮKassa весь платёж возвращён в кабинете. Запрос на возврат не отправлялся.',
      )
    } else if (result.settled) lines.push(`${refund} проведён: заказ отмечен возвращённым.`)
    else if (result.requested) {
      lines.push(`${refund} проведён; заказ уже отмечен возвращённым по уведомлению ЮKassa.`)
    } else {
      const how = result.refundId === null ? 'возврат из кабинета ЮKassa' : refund.toLowerCase()
      lines.push(`Заказ уже возвращён (${how}): второй возврат не создан.`)
    }
  } else if (result.state === 'pending') {
    lines.push(
      `${refund} принят ЮKassa и ещё обрабатывается. Заказ остаётся оплаченным, тариф и кредиты не изменены.`,
      'Повторите команду с теми же параметрами позже: второй возврат не будет создан.',
    )
  } else {
    const why = result.cancellation
      ? ` (${result.cancellation.party}: ${result.cancellation.reason})`
      : ''
    lines.push(
      `${refund} отменён ЮKassa${why.replace(/[^\w (:)-]/g, '?')}. Деньги не возвращены, заказ остаётся оплаченным.`,
      'Отменённый возврат окончателен. Когда причина устранена, повторите команду: она отправит новый запрос на возврат.',
    )
  }
  const { tariff, credits } = result
  if (tariff?.outcome === 'ended') {
    lines.push(
      `Тариф завершён ${at(tariff.endedAt)}; сгорело кредитов тарифа: ${tariff.expiredCredits}.`,
    )
  } else if (tariff?.outcome === 'already_ended') lines.push('Тариф уже был завершён раньше.')
  else if (tariff?.outcome === 'not_current') {
    lines.push('Тариф не завершён: он уже перешёл в следующий период, оплаченный другим заказом.')
  }
  if (credits?.outcome === 'taken') lines.push(`Снято кредитов пакета: ${credits.credits}.`)
  else if (credits?.outcome === 'already_taken') {
    lines.push(`Кредиты пакета уже были сняты раньше (${credits.credits}).`)
  } else if (credits?.outcome === 'nothing_available') {
    lines.push('Снимать нечего: кредиты пакета потрачены или заняты задачами.')
  }
  return lines
}

async function runRefund(
  prisma: PrismaClient,
  env: Env,
  value: z.output<typeof refundSchema>,
  write: Write,
): Promise<void> {
  const shop = configuration(() => yookassaConfigFromEnv(env))
  if (shop === null) {
    throw new OperatorCommandError(
      'ЮKassa не настроена: задайте YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY.',
    )
  }
  const who = operatorName(value.operator)
  const order = await prisma.order.findUnique({
    where: { id: value.orderId },
    select: { id: true, kind: true, status: true, amount: true, refundedAt: true },
  })
  if (order === null) throw new OperatorCommandError(codeTexts.BILLING_ORDER_NOT_FOUND)
  const amount = order.amount.toFixed(2)
  const what = { subscription: 'тариф', pack: 'пакет кредитов', topup: 'пополнение' }[order.kind]
  write(`Заказ ${order.id}: ${what}, ${amount} ₽, ${orderStatusTexts[order.status]}.\n`)
  write(`Оператор: ${who}. Причина: ${value.reason}\n`)
  if (order.status === 'refunded') {
    const when = order.refundedAt === null ? '' : ` ${at(order.refundedAt)}`
    write(`Деньги уже возвращены${when}: запрос в ЮKassa не отправляется.\n`)
  } else if (order.status === 'paid' && value.refundedInCabinet) {
    write(
      `Действие: отметить заказ возвращённым без запроса на возврат, если ЮKassa подтвердит, что весь платёж (${amount} ₽) уже возвращён в кабинете.\n`,
    )
  } else if (order.status === 'paid') {
    write(`Действие: вернуть ${amount} ₽ через ЮKassa (весь платёж).\n`)
  }
  if (value.endSubscription) {
    write('Дополнительно: завершить тариф сейчас; доступные кредиты тарифа сгорят.\n')
  }
  if (value.takeCredits) write('Дополнительно: снять доступные кредиты этого пакета.\n')
  if (!value.endSubscription && !value.takeCredits) {
    write('Тариф и кредиты клиента не меняются: возвращаются только деньги.\n')
  }

  const result = await refundOrder(
    { prisma, yookassa: createYookassaClient(shop) },
    {
      orderId: value.orderId,
      operator: who,
      reason: value.reason,
      endSubscription: value.endSubscription,
      takeCredits: value.takeCredits,
      refundedInCabinet: value.refundedInCabinet,
    },
  )
  for (const line of refundReport(result)) write(`${line}\n`)
  if (result.state === 'canceled') throw new OperatorCommandError('Возврат не проведён.')
}

async function runStopRenewal(
  prisma: PrismaClient,
  appEnv: AppEnv,
  value: z.output<typeof stopSchema>,
  write: Write,
): Promise<void> {
  const who = operatorName(value.operator)
  const customer =
    value.email === undefined ? `рабочее пространство ${value.workspace}` : `клиент ${value.email}`
  write(`Действие: отключить автопродление тарифа, ${customer}. Способ оплаты остаётся.\n`)
  write(`Оператор: ${who}. Причина: ${value.reason}\n`)
  const stopped = await stopAutoRenewalByOperator(
    { prisma, appEnv },
    {
      ...(value.email === undefined
        ? { workspaceId: value.workspace }
        : { userEmail: value.email }),
      operator: who,
      reason: value.reason,
    },
  )
  // The address as the database holds it: it differs from the typed one by the case of its
  // letters at most, so it carries nothing the operator did not type.
  const whose = stopped.userEmail === null ? '' : `клиент ${stopped.userEmail}, `
  write(
    `Автопродление отключено: ${whose}подписка ${stopped.subscriptionId}, рабочее пространство ${stopped.workspaceId}.\n`,
  )
  for (const line of stopReport(stopped, new Date())) write(`${line}\n`)
  // The command reads no shop setting, so the condition is named, not checked: a shop that takes
  // one-time payments only offers the customer no «Включить автопродление».
  write(
    stopped.paymentMethodSaved
      ? 'Способ оплаты сохранён: клиент может включить автопродление снова, если магазину разрешены автоплатежи (YOOKASSA_AUTOPAYMENTS=on).\n'
      : 'Сохранённого способа оплаты у тарифа нет.\n',
  )
}

/**
 * What the operator answers the customer with: until when the tariff works, and whether
 * anything may still be charged. A renewal charge that was started before the switch is not
 * stopped by it.
 */
export function stopReport(
  stopped: Pick<OperatorAutoRenewalStop, 'status' | 'periodEnd' | 'renewalCharge'>,
  now: Date,
): string[] {
  if (stopped.status === 'past_due') {
    return ['Тариф ждёт оплаты: автоматических списаний не будет.']
  }
  const ahead = stopped.periodEnd.getTime() > now.getTime()
  const period = ahead
    ? `Тариф действует до ${at(stopped.periodEnd)}`
    : `Оплаченный период закончился ${at(stopped.periodEnd)}`
  if (stopped.renewalCharge === 'at_bank') {
    return [
      `${period}.`,
      'Списание за следующий период уже отправлено в банк и не останавливается: если платёж пройдёт, тариф продлится ещё на месяц, после этого списаний не будет. Вернуть эти деньги можно командой billing:refund по заказу продления.',
    ]
  }
  if (stopped.renewalCharge === 'unanswered') {
    return [
      `${period}.`,
      'Списание за следующий период отправлено, ответа ЮKassa нет; повторяться оно не будет. Если деньги списаны, тариф продлится на месяц, когда придёт уведомление ЮKassa; если оно не придёт, примерно через 12 часов заказ появится в billing:refunds-needed как списание без ответа.',
    ]
  }
  return [
    ahead
      ? `${period} и больше не списывается.`
      : `${period}: списаний больше не будет, тариф завершится при ближайшей проверке.`,
  ]
}

const reasonTexts: Record<string, string> = {
  [refundReasons.amountMismatch]: 'платёж не совпал с заказом (сумма, валюта или номер заказа)',
  [refundReasons.partlyRefunded]: 'часть платежа вернули до зачисления',
  [refundReasons.liveSubscription]: 'тариф уже действовал, когда заказ оплатили',
  [refundReasons.orderClosed]: 'платёж прошёл после закрытия заказа',
  [refundReasons.staleRenewal]: 'продление оплачено, когда тариф его уже не ждал',
}

function neededLines(item: RefundNeeded): string[] {
  const reasonText = (item.reason && reasonTexts[item.reason]) ?? 'причина не распознана'
  const sum =
    item.toReturn === null
      ? `сумма не определена (заказ на ${item.orderAmount} ₽)`
      : `к возврату ${item.toReturn} ₽ из ${item.paidAmount} ₽`
  // One number, not the two it is the larger of: added up, they would count one refund twice.
  const returned = item.returned === '0.00' ? '' : `; по записям возвращено: ${item.returned} ₽`
  const how = item.byCommand
    ? `billing:refund -- ${item.orderId} --reason "<причина>"`
    : 'в кабинете ЮKassa (заказ не оплачен в учёте или платёж уже частично возвращён)'
  return [
    `${at(item.flaggedAt)} · заказ ${item.orderId} (${orderStatusTexts[item.orderStatus]}) · платёж ${item.paymentId ?? '—'}`,
    `  ${sum}${returned}; причина: ${reasonText}`,
    `  как вернуть: ${how}`,
  ]
}

// Ids of the platform's own making; whatever else a row might hold does not reach the terminal.
const plain = (text: string | null) => (text ?? '—').replace(/[^\w.-]/g, '?')

/**
 * What stands above the charges without an answer: how to tell a shop that has no right to
 * autopayments. ЮKassa then answers 403 `forbidden` to every charge, which the pass of core
 * logs and repeats like any request without an answer (`shopAway` of @repo/billing). No payment
 * was made, so there is none to look for in the cabinet: ЮKassa is the one to ask.
 *
 * The log has two lines for one charge, and the hint quotes both as core writes them
 * (`failureLine` of billing-jobs.ts): the first request is logged by the job `charges` with the
 * id of the subscription, every repeat of the next twelve hours by the pass of stuck orders
 * with the id of the order — the one line an operator finds by the order the list prints.
 */
export const FORBIDDEN_CHARGES_HINT =
  '  Сначала посмотрите журнал core. Строка «billing charges: subscription <подписка> not finished: forbidden…» (первый запрос списания) или «billing stuck_orders: order <заказ> not finished: forbidden…» (его повторы в следующие 12 часов) значит, что ЮKassa ответила 403: у магазина нет права на автоплатежи. Платежа тогда не было: искать его в кабинете незачем — обратитесь в ЮKassa, а запись закройте командой с --not-found.'

function unknownChargeLines(charge: UnknownCharge): string[] {
  return [
    `${at(charge.flaggedAt)} · заказ ${charge.orderId} · подписка ${plain(charge.subscriptionId)} · ${charge.amount} ₽ · ключ запроса ${plain(charge.idempotenceKey)}`,
    `  как проверить: в кабинете ЮKassa найдите платёж на эту сумму, созданный с ${at(charge.orderCreatedAt)} в течение 12 часов; в его данных order_id = ${charge.orderId}`,
    '  платёж нашёлся: billing:settle-payment -- <идентификатор платежа>',
    `  платежа нет: billing:settle-payment -- --order ${charge.orderId} --not-found --reason "<причина>"`,
  ]
}

function unappliedOptionLines(item: UnappliedRefundOption): string[] {
  const options = [
    ...(item.endSubscription ? ['--end-subscription'] : []),
    ...(item.takeCredits ? ['--take-credits'] : []),
  ].join(' ')
  const what = item.kind === 'pack' ? 'пакет кредитов' : 'тариф'
  const refunded = item.refundedAt === null ? '' : `, возвращён ${at(item.refundedAt)}`
  return [
    `${at(item.askedAt)} · заказ ${item.orderId} (${what}${refunded})`,
    `  возврат проведён, параметр не применён: повторите billing:refund -- ${item.orderId} ${options} --reason "<причина>"`,
    `  параметр больше не нужен: billing:refund -- ${item.orderId} --reason "<причина>"`,
  ]
}

const shown = (count: number, more: boolean) =>
  `${count}${more ? ' (показаны самые давние; есть ещё)' : ''}`

async function runRefundsNeeded(
  prisma: PrismaClient,
  value: z.output<typeof neededSchema>,
  write: Write,
): Promise<void> {
  const listed = await listRefundsNeeded(
    { prisma },
    value.limit === undefined ? {} : { limit: value.limit },
  )
  const { items, unknownCharges, unappliedOptions } = listed
  if (items.length === 0) write('Заказов, ожидающих возврата, нет.\n')
  else {
    write(`Ожидают возврата: ${shown(items.length, listed.more)}.\n`)
    for (const item of items) for (const line of neededLines(item)) write(`${line}\n`)
  }
  if (unknownCharges.length > 0) {
    write(`Списания без ответа: ${shown(unknownCharges.length, listed.moreUnknownCharges)}.\n`)
    write(`${FORBIDDEN_CHARGES_HINT}\n`)
    for (const charge of unknownCharges) {
      for (const line of unknownChargeLines(charge)) write(`${line}\n`)
    }
  }
  if (unappliedOptions.length > 0) {
    write(
      `Возврат проведён, параметр не применён: ${shown(unappliedOptions.length, listed.moreUnappliedOptions)}.\n`,
    )
    for (const item of unappliedOptions) {
      for (const line of unappliedOptionLines(item)) write(`${line}\n`)
    }
  }
}

// As the core role reads it: the origin a billing letter links to.
const appUrlEnvSchema = z.object({
  APP_URL: envVar(
    z
      .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
      .transform((url) => url.replace(/\/+$/, '')),
  ),
})

/** Where the order of a payment stands after it was read back, in the operator's words. */
export function settlementReport(paymentId: string, settlement: OrderSettlement): string {
  if (settlement.state === 'unknown') {
    return `Платёж ${paymentId} не относится ни к одному заказу: ЮKassa его не знает, либо в его данных нет заказа платформы без платежа на ту же сумму. Записи не изменены.`
  }
  const order = `заказ ${settlement.orderId}`
  if (settlement.refundNeeded) {
    return settlement.state === 'paid'
      ? `Платёж ${paymentId}: ${order} оплачен, но не зачислен. Деньги нужно вернуть: заказ есть в billing:refunds-needed.`
      : `Платёж ${paymentId} прошёл, а ${order} закрыт (${orderStatusTexts[settlement.state]}). Деньги нужно вернуть: заказ есть в billing:refunds-needed.`
  }
  const texts: Record<OrderStatus, string> = {
    paid: `${order} оплачен и зачислен.`,
    pending: `${order} ещё ждёт исхода платежа; итог применится по уведомлению ЮKassa или при следующей проверке.`,
    failed: `${order} закрыт без оплаты: платёж не прошёл, возвращать нечего.`,
    cancelled: `${order} отменён, денег по платежу нет: возвращать нечего.`,
    refunded: `${order} уже возвращён.`,
  }
  return `Платёж ${paymentId}: ${texts[settlement.state]}`
}

async function runSettlePayment(
  prisma: PrismaClient,
  env: Env,
  production: boolean,
  value: z.output<typeof settleSchema>,
  write: Write,
): Promise<void> {
  if ('order' in value) {
    const who = operatorName(value.operator)
    write(
      `Действие: закрыть запись о списании без ответа по заказу ${value.order}: платежа в ЮKassa нет.\n`,
    )
    write(`Оператор: ${who}. Причина: ${value.reason}\n`)
    const closed = await closeUnknownCharge(
      { prisma },
      { orderId: value.order, operator: who, reason: value.reason },
    )
    write(
      closed.recorded
        ? `Запись закрыта: заказ ${closed.orderId} больше не показывается в billing:refunds-needed.\n`
        : `Запись по заказу ${closed.orderId} уже была закрыта раньше: ничего не изменено.\n`,
    )
    return
  }

  const { paymentId } = value
  const shop = configuration(() => yookassaConfigFromEnv(env))
  if (shop === null) {
    throw new OperatorCommandError(
      'ЮKassa не настроена: задайте YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY.',
    )
  }
  const appUrl = configuration(() => parseEnv('billing', appUrlEnvSchema, env).APP_URL)
  if (production && !appUrl.startsWith('https://')) {
    throw new OperatorCommandError(
      'Окружение задано неверно: APP_URL: must use https in production',
    )
  }
  const held = await prisma.order.findUnique({
    where: { yookassaPaymentId: paymentId },
    select: { id: true },
  })
  write(
    held === null
      ? `Действие: перечитать платёж ${paymentId} в ЮKassa; если он создан для заказа платформы, у которого нет платежа, привязать его к заказу и провести заказ.\n`
      : `Действие: перечитать платёж ${paymentId} в ЮKassa и провести заказ ${held.id}.\n`,
  )
  let settlement: OrderSettlement
  try {
    settlement = await settleOrderByPaymentId(
      { prisma, yookassa: createYookassaClient(shop), appUrl },
      { paymentId },
    )
  } catch (error) {
    // The shop was only asked to show the payment: the general text speaks of a refund.
    const refused = error instanceof YookassaApiError && !error.retryable
    if (error instanceof YookassaError && !refused) {
      throw new OperatorCommandError(
        'ЮKassa не ответила или ответила непонятно: платёж не проведён. Повторите команду позже — повтор безопасен.',
      )
    }
    throw error
  }
  if (held === null && settlement.state !== 'unknown') {
    write(`Платёж привязан к заказу ${settlement.orderId}.\n`)
  }
  if (settlement.state === 'unknown') {
    throw new OperatorCommandError(settlementReport(paymentId, settlement))
  }
  write(`${settlementReport(paymentId, settlement)}\n`)
}

// To the second: two rows of rates may start within one minute.
const moscowSeconds = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})
/** A moment of a rate: Moscow time for the eye, the exact instant for a copy. */
const atInstant = (moment: Date) =>
  `${moscowSeconds.format(moment).replace(',', '')} МСК (${moment.toISOString()})`

const sliced = (slugs: readonly string[]) => slugs.map((slug) => plain(slug)).join(', ')

/**
 * What an approval of the credit rate means for the platform, line by line — printed before
 * anything is written. The lines name slugs of the catalogue, amounts and dates only.
 */
export function ratesReport(preview: CreditRatePreview): string[] {
  const lines = [`Начало действия: ${atInstant(preview.effectiveFrom)}.`]
  lines.push(
    preview.previous === null
      ? `На момент начала действующего курса нет. Новый курс — ${preview.rubPerCredit} ₽ учётной стоимости за кредит.`
      : `Действующий курс — ${preview.previous.rubPerCredit} ₽ за кредит, с ${atInstant(preview.previous.effectiveFrom)}. Новый курс — ${preview.rubPerCredit} ₽, изменение ${preview.movePercent} %.`,
  )
  if (preview.plans.length === 0) lines.push('Тарифов и пакетов в продаже нет.')
  else {
    lines.push(
      'Учётная стоимость тарифов и пакетов, выбранных целиком (кредиты × курс), и её доля в цене:',
    )
    for (const plan of preview.plans) {
      const share =
        plan.sharePercent === null ? 'цена нулевая' : `${plan.sharePercent} % цены ${plan.price} ₽`
      const what = plan.kind === 'pack' ? 'пакет' : 'тариф'
      lines.push(
        `  ${plain(plan.slug)} (${what}): ${plan.credits} кредитов — ${plan.costRub} ₽, ${share}`,
      )
    }
  }
  const { pack, gift } = preview.outstanding
  lines.push(
    `Не потраченные кредиты всех рабочих пространств: из пакетов — ${pack.credits} (${pack.costRub} ₽ учётной стоимости), подарочные — ${gift.credits} (${gift.costRub} ₽).`,
  )
  lines.push(
    `Шаги попытки при этом курсе (предел одного ключа хода — ${TURN_KEY_LIMIT_RUB} ₽): ${preview.steps
      .map((step) => `${step.modelClass} — ${step.credits} кредитов, ${step.costRub} ₽`)
      .join('; ')}.`,
  )
  const above = preview.steps.filter((step) => step.aboveKeyLimit).map((step) => step.modelClass)
  if (above.length > 0) {
    lines.push(
      `  Шаг выше предела ключа: ${above.join(', ')}. Такая попытка получит несколько ключей хода подряд.`,
    )
  }
  if (preview.models.length === 0) lines.push('Включённых моделей нет.')
  else {
    lines.push(
      'Кредитов за 1 млн токенов по включённым моделям (вход / кэш / запись в кэш / выход):',
    )
    for (const model of preview.models) {
      const name = `${plain(model.provider)}/${plain(model.model)} (${plain(model.modelClass)})`
      if (model.creditsPer1m === null) {
        lines.push(`  ${name}: ставки нет — модель не сможет работать`)
        continue
      }
      const { input, cacheRead, cacheWrite, output } = model.creditsPer1m
      const source = model.listed ? 'ставки из файла' : 'прежние ставки'
      lines.push(`  ${name}: ${input} / ${cacheRead} / ${cacheWrite} / ${output} — ${source}`)
    }
  }
  if (preview.mixedClasses.length > 0) {
    lines.push(
      `Разные ставки у включённых моделей одного класса: ${sliced(preview.mixedClasses)}. Одна и та же задача будет стоить разное число кредитов в зависимости от аккаунта пула.`,
    )
  }
  if (preview.exposure.plans.length > 0) {
    lines.push(`Учётная стоимость выше половины цены у тарифов: ${sliced(preview.exposure.plans)}.`)
  }
  if (preview.exposure.move) lines.push('Курс отличается от действующего больше чем на 10 %.')
  return lines
}

/** Why the rate was not written, in the operator's words; fixed texts with slugs and dates. */
export function ratesRefusalText(refusal: CreditRateRefusal): string {
  switch (refusal.reason) {
    case 'unknown_model':
      return `В каталоге нет модели ${plain(refusal.provider)}/${plain(refusal.model)}: проверьте slug провайдера и модели в файле.`
    case 'instant_past':
      return `Момент начала раньше текущего времени базы данных — ${atInstant(refusal.now)}. Задним числом курс и ставки не записываются.`
    case 'instant_not_newest': {
      const rows = refusal.table === 'credit_rates' ? 'курса' : 'ставок моделей'
      return `Момент начала не позже самой новой строки ${rows}: она начинается ${atInstant(refusal.newest)}. Новая строка должна начинаться позже всех существующих: задайте --effective-from позже этого момента.`
    }
    case 'enabled_model_price_newer':
      return `У включённой модели ${plain(refusal.provider)}/${plain(refusal.model)} есть ставка, которая начинается позже — ${atInstant(refusal.priceFrom)}. Курс оказался бы старше этой ставки, и резервировать кредиты стало бы нельзя.`
    case 'exposure_unconfirmed':
      return 'Нужно подтверждение --confirm-exposure: учётная стоимость тарифа выше половины его цены либо курс отличается от действующего больше чем на 10 % (строки выше).'
    case 'mixed_models_unconfirmed':
      return `Нужно подтверждение --confirm-mixed-models: у включённых моделей одного класса разные ставки (${sliced(refusal.classes)}).`
  }
}

/** Why the file of rates was not taken. */
export function ratesFileProblemText(problem: CreditRatesProblem): string {
  if (problem.problem === 'prices_without_rate') {
    return 'В файле есть ставки моделей, но нет курса кредита (rubPerCredit). Ставки без курса не записываются: добавьте курс и основание (basis).'
  }
  // Paths into the operator's own file: names of its fields and positions in its lists.
  const fields = problem.fields.map((field) => field.replace(/[^\w.()а-яё]/giu, '?')).join(', ')
  return `Файл ставок не прошёл проверку. Поля: ${fields}. Формат — в --help.`
}

// A file of rates is a few kilobytes; anything larger is not one.
const MAX_RATES_FILE_BYTES = 1_048_576

function readRatesFile(path: string): unknown {
  let text: string
  try {
    if (statSync(path).size > MAX_RATES_FILE_BYTES) {
      throw new OperatorCommandError('Файл ставок слишком большой: это не файл ставок.')
    }
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error instanceof OperatorCommandError) throw error
    throw new OperatorCommandError('Файл ставок не прочитан: проверьте путь и права доступа.')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new OperatorCommandError('Файл ставок не разобран: это не JSON.')
  }
}

async function runRates(
  prisma: PrismaClient,
  value: z.output<typeof ratesSchema>,
  write: Write,
): Promise<void> {
  const who = operatorName(value.operator)
  const parsed = parseCreditRates(readRatesFile(value.file))
  if (!parsed.ok) throw new OperatorCommandError(ratesFileProblemText(parsed))
  const { rates } = parsed
  const what =
    rates.prices.length === 0
      ? 'ставки моделей не меняются'
      : `ставок моделей в файле: ${rates.prices.length}`
  write(
    `Действие: утвердить курс кредита ${rates.rubPerCredit} ₽ учётной стоимости за кредит; ${what}.\n`,
  )
  write(`Оператор: ${who}. Причина: ${value.reason}\n`)
  write(`Основание: ${rates.basis}\n`)

  const approval = await approveCreditRate(
    { prisma },
    {
      rates,
      ...(value.effectiveFrom === undefined ? {} : { effectiveFrom: value.effectiveFrom }),
      confirmExposure: value.confirmExposure,
      confirmMixedModels: value.confirmMixedModels,
      operator: who,
      reason: value.reason,
    },
    // Inside the transaction, before its first write: what is printed is what is decided on.
    { preview: (preview) => ratesReport(preview).forEach((line) => write(`${line}\n`)) },
  )
  if (!approval.approved) {
    const reasons = approval.refusals.map((refusal) => `- ${ratesRefusalText(refusal)}`)
    throw new OperatorCommandError(['Курс и ставки не записаны.', ...reasons].join('\n'))
  }
  write(
    `Записано: курс кредита ${approval.rateId} и ставки моделей (${approval.prices}) действуют с ${atInstant(approval.effectiveFrom)}.\n`,
  )
}

/** Thin operator entrypoint: no app bootstrap, dotenv discovery or secret-bearing logging. */
export async function runBillingCommand(
  command: BillingCommand,
  args: readonly string[],
  env: Env = process.env,
  write: Write = (text) => void process.stdout.write(text),
): Promise<void> {
  const options = parseBillingArguments(command, args)
  if (options.help) {
    write(billingHelp(command))
    return
  }
  const parsedEnv = appEnvSchema.safeParse(env.APP_ENV)
  if (!parsedEnv.success) throw new Error('Задайте APP_ENV: development, test или production.')
  try {
    const config = configuration(() => dbConfigFromEnv(env))
    const prisma = createPrismaClient({ ...config, log: [] })
    try {
      if (options.command === 'refund') await runRefund(prisma, env, options.value, write)
      else if (options.command === 'stop-renewal') {
        await runStopRenewal(prisma, parsedEnv.data, options.value, write)
      } else if (options.command === 'settle-payment') {
        const production = parsedEnv.data === 'production'
        await runSettlePayment(prisma, env, production, options.value, write)
      } else if (options.command === 'rates') await runRates(prisma, options.value, write)
      else await runRefundsNeeded(prisma, options.value, write)
    } finally {
      await prisma.$disconnect().catch(() => undefined)
    }
  } catch (error) {
    throw operatorFailure(error)
  }
}
