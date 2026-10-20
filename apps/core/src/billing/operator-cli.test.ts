import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { refundRefusals, stopRenewalRefusals, type OrderRefund } from '@repo/billing'
import {
  billingNoLiveSubscription,
  billingNothingToChange,
  billingOrderNotFound,
  conflict,
  notFound,
} from '@repo/domain'
import { YookassaApiError, YookassaError } from '@repo/yookassa'
import { describe, expect, it, vi } from 'vitest'

import {
  billingHelp,
  operatorFailure,
  parseBillingArguments,
  refundReport,
  runBillingCommand,
  settlementReport,
  stopReport,
  type BillingCommand,
} from './operator-cli.ts'

const ORDER = '0199a000-0000-7000-8000-0000000000b2'
const WORKSPACE = '0199a000-0000-7000-8000-0000000000a1'
const PAYMENT = '2d8b8b6a-000f-5000-8000-1f4b0f6f0b1e'
const REFUSED = /^Неверные параметры команды биллинга\. Используйте --help\.$/
const UNFINISHED =
  'Команда биллинга не завершена. Проверьте окружение и доступность базы данных и ЮKassa.'
const cwd = fileURLToPath(new URL('../../', import.meta.url))
const commands = ['refund', 'stop-renewal', 'refunds-needed', 'settle-payment', 'rates'] as const
/** Arguments that between them name every option a command reads; the parser takes each list. */
const everyOption: Record<BillingCommand, string[][]> = {
  refund: [
    [
      ORDER,
      '--reason',
      'r',
      '--operator',
      'o',
      '--end-subscription',
      '--take-credits',
      '--refunded-in-cabinet',
    ],
  ],
  'stop-renewal': [
    ['client@example.ru', '--reason', 'r', '--operator', 'o'],
    ['--workspace', WORKSPACE, '--reason', 'r'],
  ],
  'refunds-needed': [['--limit', '25']],
  'settle-payment': [['--order', ORDER, '--not-found', '--reason', 'r', '--operator', 'o']],
  rates: [
    [
      '--file',
      'rates.json',
      '--reason',
      'r',
      '--operator',
      'o',
      '--effective-from',
      '2026-11-01T00:00:00+03:00',
      '--confirm-exposure',
      '--confirm-mixed-models',
    ],
  ],
}
/** The options a text names, as an operator would copy them. */
const optionsNamed = (text: string) => new Set(text.match(/--[a-z][a-z-]*/g))

function command(name: BillingCommand, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [`scripts/billing-${name}.mjs`, ...args], {
      cwd,
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      })
    })
  })
}

describe('operator billing commands', () => {
  it.each(commands)(
    'native %s entrypoint supports help without env or service connections',
    async (name) => {
      expect(parseBillingArguments(name, ['--', '--help'])).toEqual({ command: name, help: true })
      expect(parseBillingArguments(name, ['-h'])).toEqual({ command: name, help: true })
      const result = await command(name, ['--help'])
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(billingHelp(name))
      expect(result.stderr).toBe('')
    },
  )

  it('says in every help which environment the command needs, and names no option of another', () => {
    for (const name of commands) {
      expect(billingHelp(name)).toContain('APP_ENV и DATABASE_URL')
      expect(billingHelp(name)).toContain('не загружает .env')
    }
    expect(billingHelp('refund')).toContain('YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY')
    // As the core role: a shop in production says whether its autopayments are approved.
    for (const name of ['refund', 'settle-payment'] as const) {
      expect(billingHelp(name)).toContain('в production — ещё YOOKASSA_AUTOPAYMENTS, как у core')
    }
    expect(billingHelp('refund')).toContain('--refunded-in-cabinet')
    expect(billingHelp('refund')).not.toContain('APP_URL')
    expect(billingHelp('stop-renewal')).not.toContain('YOOKASSA')
    expect(billingHelp('refunds-needed')).not.toContain('YOOKASSA')
    expect(billingHelp('refunds-needed')).not.toContain('--operator')
    // The rates are the platform's own: the command never addresses the shop.
    expect(billingHelp('rates')).not.toContain('YOOKASSA')
    expect(billingHelp('rates')).not.toContain('APP_URL')
    // Settling a payment applies it, and the letter of an applied payment links to the app.
    expect(billingHelp('settle-payment')).toContain(
      'с идентификатором платежа — ещё APP_URL, YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY',
    )
    expect(billingHelp('settle-payment')).toContain('--not-found')
  })

  it('names in every help and every refusal only options the parser reads', () => {
    // An operator copies an option from what the command printed: a name the parser does not
    // read would be refused, and what the option was for would not happen.
    const read = {} as Record<BillingCommand, Set<string>>
    for (const name of commands) {
      for (const args of everyOption[name]) {
        expect(parseBillingArguments(name, args)).toMatchObject({ command: name, help: false })
      }
      read[name] = optionsNamed(everyOption[name].flat().join(' '))
    }
    // A help names every option of its command, and nothing else that looks like one.
    for (const name of commands) expect(optionsNamed(billingHelp(name))).toEqual(read[name])
    // A refusal may send the operator to another command, never to an option nobody reads.
    const anyCommand = new Set(commands.flatMap((name) => [...read[name]]))
    for (const refusal of [
      ...Object.values(refundRefusals),
      ...Object.values(stopRenewalRefusals),
    ]) {
      for (const option of optionsNamed(operatorFailure(conflict(refusal)).message)) {
        expect(anyCommand).toContain(option)
      }
    }
  })

  it('names the option that takes the credits of a refunded pack where the operator looks for it', () => {
    const usage = billingHelp('refund')
    // In the synopsis, between the two other options, and on a line of its own that says what
    // it does.
    expect(usage).toContain('[--end-subscription] [--take-credits] [--refunded-in-cabinet]')
    expect(usage).toContain(
      '\n--take-credits — снять доступные кредиты возвращаемого пакета; занятые задачами и потраченные не затрагиваются.\n',
    )
    expect(usage).toContain(
      '\n--end-subscription — завершить сейчас тариф, оплаченный этим заказом; доступные кредиты тарифа сгорают.\n',
    )
    // The refusal of an order that is not a pack starts with the option it is about.
    expect(operatorFailure(conflict(refundRefusals.notPack)).message).toBe(
      '--take-credits подходит только заказу пакета кредитов.',
    )
  })

  it('reads a refund: the order, the reason and what else to do', () => {
    expect(parseBillingArguments('refund', [ORDER, '--reason', 'Письмо от 4 октября'])).toEqual({
      command: 'refund',
      help: false,
      value: {
        orderId: ORDER,
        reason: 'Письмо от 4 октября',
        endSubscription: false,
        takeCredits: false,
        refundedInCabinet: false,
      },
    })
    expect(
      parseBillingArguments('refund', [
        '--',
        '--end-subscription',
        '--reason',
        '  по письму  ',
        ORDER.toUpperCase(),
        '--operator',
        'Виктория',
      ]),
    ).toMatchObject({
      value: { orderId: ORDER, reason: 'по письму', operator: 'Виктория', endSubscription: true },
    })
    expect(
      parseBillingArguments('refund', [ORDER, '--take-credits', '--reason', 'r']),
    ).toMatchObject({ value: { takeCredits: true, endSubscription: false } })
    expect(
      parseBillingArguments('refund', [
        ORDER,
        '--refunded-in-cabinet',
        '--end-subscription',
        '--reason',
        'r',
      ]),
    ).toMatchObject({
      value: { refundedInCabinet: true, endSubscription: true, takeCredits: false },
    })
  })

  it('reads a payment to settle, or an order whose payment the shop does not hold', () => {
    expect(parseBillingArguments('settle-payment', ['--', PAYMENT])).toEqual({
      command: 'settle-payment',
      help: false,
      value: { paymentId: PAYMENT },
    })
    expect(
      parseBillingArguments('settle-payment', [
        '--order',
        ORDER.toUpperCase(),
        '--not-found',
        '--reason',
        'В кабинете платежа нет',
        '--operator',
        'Виктория',
      ]),
    ).toEqual({
      command: 'settle-payment',
      help: false,
      value: {
        order: ORDER,
        notFound: true,
        reason: 'В кабинете платежа нет',
        operator: 'Виктория',
      },
    })
  })

  it('reads whose auto-renewal to stop: by the email or by the workspace', () => {
    expect(
      parseBillingArguments('stop-renewal', ['client@example.ru', '--reason', 'Письмо']),
    ).toEqual({
      command: 'stop-renewal',
      help: false,
      value: { email: 'client@example.ru', reason: 'Письмо' },
    })
    expect(
      parseBillingArguments('stop-renewal', ['--workspace', WORKSPACE, '--reason', 'Письмо']),
    ).toMatchObject({ value: { workspace: WORKSPACE, reason: 'Письмо' } })
  })

  it('reads how many orders to list', () => {
    expect(parseBillingArguments('refunds-needed', [])).toEqual({
      command: 'refunds-needed',
      help: false,
      value: {},
    })
    expect(parseBillingArguments('refunds-needed', ['--limit', '25'])).toMatchObject({
      value: { limit: 25 },
    })
  })

  it.each([
    ['refund', []],
    ['refund', [ORDER]],
    ['refund', ['--reason', 'r']],
    ['refund', ['not-an-order', '--reason', 'r']],
    ['refund', [ORDER, ORDER, '--reason', 'r']],
    ['refund', [ORDER, '--reason']],
    ['refund', [ORDER, '--reason', '--end-subscription']],
    ['refund', [ORDER, '--reason', 'r', '--reason', 'r']],
    ['refund', [ORDER, '--reason', 'r', '--end-subscription', '--end-subscription']],
    ['refund', [ORDER, '--reason', 'r', '--amount', '100.00']],
    ['refund', [ORDER, '--reason', 'r', '--workspace', WORKSPACE]],
    ['refund', [ORDER, '--reason', 'r'.repeat(501)]],
    ['refund', [ORDER, '--reason', 'r', '--operator', 'o'.repeat(129)]],
    ['refund', [ORDER, '--reason', 'r', '-x']],
    ['refund', [ORDER, '--reason', 'r', '--refunded-in-cabinet', '--refunded-in-cabinet']],
    ['refund', [ORDER, '--reason', 'r', '--not-found']],
    ['settle-payment', []],
    ['settle-payment', [PAYMENT, PAYMENT]],
    ['settle-payment', ['payment id']],
    ['settle-payment', ['p'.repeat(65)]],
    ['settle-payment', ['платёж']],
    ['settle-payment', [PAYMENT, '--reason', 'r']],
    ['settle-payment', [PAYMENT, '--not-found']],
    ['settle-payment', [PAYMENT, '--order', ORDER, '--not-found', '--reason', 'r']],
    // An order alone says nothing: the operator has to state that no payment was found, and why.
    ['settle-payment', ['--order', ORDER]],
    ['settle-payment', ['--order', ORDER, '--reason', 'r']],
    ['settle-payment', ['--order', ORDER, '--not-found']],
    ['settle-payment', ['--order', 'not-an-order', '--not-found', '--reason', 'r']],
    ['settle-payment', ['--not-found', '--reason', 'r']],
    ['settle-payment', ['--order', ORDER, '--not-found', '--reason', 'r', '--end-subscription']],
    ['stop-renewal', ['--reason', 'r']],
    ['stop-renewal', ['client@example.ru']],
    ['stop-renewal', ['not an email', '--reason', 'r']],
    ['stop-renewal', ['client@example.ru', '--workspace', WORKSPACE, '--reason', 'r']],
    ['stop-renewal', ['--workspace', 'not-a-workspace', '--reason', 'r']],
    ['stop-renewal', ['client@example.ru', '--reason', 'r', '--end-subscription']],
    ['refunds-needed', ['--limit', '0']],
    ['refunds-needed', ['--limit', '501']],
    ['refunds-needed', ['--limit', '1.5']],
    ['refunds-needed', ['--limit']],
    ['refunds-needed', [ORDER]],
    ['refunds-needed', ['--reason', 'r']],
  ] as const)('rejects malformed %s options with fixed text: %j', (name, args) => {
    expect(() => parseBillingArguments(name, args)).toThrow(REFUSED)
  })

  // Cases are named, not printed with %j: the reporter would write the controls to the terminal.
  it.each([
    ['U+009B, an 8-bit CSI', 'a\u009bb'],
    ['an escape sequence', 'a\u001b[2Jb'],
    ['a line feed', 'a\nb'],
    ['a tab', 'a\tb'],
  ] as const)(
    'rejects a reason or an operator with %s: it would reach the terminal and the audit log',
    (_name, text) => {
      expect(() => parseBillingArguments('refund', [ORDER, '--reason', text])).toThrow(REFUSED)
      expect(() =>
        parseBillingArguments('refund', [ORDER, '--reason', 'r', '--operator', text]),
      ).toThrow(REFUSED)
      expect(() =>
        parseBillingArguments('stop-renewal', ['client@example.ru', '--reason', text]),
      ).toThrow(REFUSED)
    },
  )

  it('shows fixed operator reasons and hides everything else', () => {
    for (const message of [
      ...Object.values(refundRefusals),
      ...Object.values(stopRenewalRefusals),
    ]) {
      const shown = operatorFailure(conflict(message)).message
      expect(shown).toMatch(/^[А-Я-]/)
      expect(shown).not.toBe(UNFINISHED)
    }
    const elsewhere = operatorFailure(conflict(refundRefusals.refundedElsewhere)).message
    expect(elsewhere).toContain('в кабинете ЮKassa')
    // What to do next: the whole payment returned in the cabinet is marked by an option.
    expect(elsewhere).toContain('повторите команду с --refunded-in-cabinet')
    // Thrown only while no money of the order has been asked for (`refundOrder`), so it is true.
    expect(operatorFailure(conflict(refundRefusals.notCurrentPeriod)).message).toContain(
      'Деньги не возвращались',
    )
    for (const refusal of [refundRefusals.cabinetNotFull, refundRefusals.cabinetOwnRefund]) {
      const shown = operatorFailure(conflict(refusal)).message
      expect(shown).toMatch(/^--refunded-in-cabinet не подходит: /)
      expect(shown).toContain('Записи не изменены')
    }
    expect(operatorFailure(conflict(refundRefusals.notUnknownCharge)).message).toMatch(
      /^Заказ не числится списанием без ответа/,
    )
    expect(operatorFailure(billingOrderNotFound()).message).toBe('Заказ не найден.')
    expect(operatorFailure(billingNoLiveSubscription()).message).toBe(
      'У клиента нет действующего тарифа.',
    )
    expect(operatorFailure(billingNothingToChange()).message).toBe('Автопродление уже отключено.')
    for (const hidden of [
      new Error('connect ECONNREFUSED postgresql://raditi:private-password@127.0.0.1:5432'),
      conflict('private-unlisted refusal'),
      // The message of a refusal under another code is not a refusal of ours.
      notFound(refundRefusals.notPaid),
      new TypeError('private'),
      'private',
    ]) {
      expect(operatorFailure(hidden).message).toBe(UNFINISHED)
    }
  })

  it('tells a request the shop refused from one whose outcome nobody knows', () => {
    const refused = operatorFailure(
      new YookassaApiError('invalid_request: private description', 400, 'invalid_request', {
        description: 'private-body',
      }),
    ).message
    expect(refused).toBe('ЮKassa отклонила запрос (HTTP 400, invalid_request). Записи не изменены.')
    // A code that is not a plain word is not shown.
    expect(
      operatorFailure(new YookassaApiError('x', 404, 'private code\u001b[2J', {})).message,
    ).toBe('ЮKassa отклонила запрос (HTTP 404). Записи не изменены.')
    for (const unknown of [
      new YookassaError('YooKassa request timed out', { retryable: true }),
      new YookassaApiError('internal_server_error: private', 500, undefined, {}),
      new YookassaApiError('too_many_requests', 429, 'too_many_requests', {}),
      new YookassaError('Unexpected YooKassa response'),
    ]) {
      const shown = operatorFailure(unknown).message
      expect(shown).toContain('исход запроса неизвестен')
      expect(shown).toContain('второй возврат не будет создан')
      expect(shown).not.toContain('private')
    }
  })

  it('asks for APP_ENV before anything else, and for the database by the name of its variable', async () => {
    const args = [ORDER, '--reason', 'r', '--operator', 'operator-test']
    const noEnv = await command('refund', args)
    expect(noEnv.code).toBe(1)
    expect(noEnv.stdout).toBe('')
    expect(noEnv.stderr).toBe('Задайте APP_ENV: development, test или production.\n')

    const noDatabase = await command('refund', args, { APP_ENV: 'test' })
    expect(noDatabase.code).toBe(1)
    expect(noDatabase.stderr).toContain('Окружение задано неверно')
    expect(noDatabase.stderr).toContain('DATABASE_URL')
  })

  it('refuses a refund without a shop, and a broken shop without showing its values', async () => {
    const write = vi.fn<(text: string) => void>()
    const env = {
      APP_ENV: 'test',
      DATABASE_URL: 'postgresql://raditi:private-password@127.0.0.1:1/raditi',
    }
    const args = [ORDER, '--reason', 'r', '--operator', 'operator-test']

    await expect(runBillingCommand('refund', args, env, write)).rejects.toThrow(
      /^ЮKassa не настроена: задайте YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY\.$/,
    )
    const broken = runBillingCommand(
      'refund',
      args,
      { ...env, YOOKASSA_SHOP_ID: 'private-shop', YOOKASSA_SECRET_KEY: 'private-secret-key' },
      write,
    )
    await expect(broken).rejects.toThrow(/Окружение задано неверно.*YOOKASSA_SHOP_ID/s)
    await expect(broken).rejects.not.toThrow(/private/)
    // The local fake is refused in production before anything is asked of anybody.
    await expect(
      runBillingCommand(
        'refund',
        args,
        {
          ...env,
          APP_ENV: 'production',
          YOOKASSA_SHOP_ID: '123456',
          YOOKASSA_SECRET_KEY: 'private-secret-key',
          YOOKASSA_API_URL: 'http://127.0.0.1:4010/v3',
        },
        write,
      ),
    ).rejects.toThrow(/Окружение задано неверно.*YOOKASSA_API_URL/s)
    // And a shop in production has to say whether its autopayments are approved, as for core.
    const unsaid = runBillingCommand(
      'refund',
      args,
      {
        ...env,
        APP_ENV: 'production',
        YOOKASSA_SHOP_ID: '123456',
        YOOKASSA_SECRET_KEY: 'private-secret-key',
      },
      write,
    )
    await expect(unsaid).rejects.toThrow(
      /Окружение задано неверно.*YOOKASSA_AUTOPAYMENTS: must be set to on or off in production/s,
    )
    await expect(unsaid).rejects.not.toThrow(/private/)
    expect(write).not.toHaveBeenCalled()
  })

  it('hides why the database could not be reached', async () => {
    const result = await command('refunds-needed', [], {
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://raditi:private-password@127.0.0.1:1/raditi',
    })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`${UNFINISHED}\n`)
    expect(result.stderr).not.toContain('private')
  })

  it('reads no shop setting for the commands that never address the shop', async () => {
    // A shop in production that has not said whether its autopayments are approved: web, core
    // and the two commands that call ЮKassa do not start there (see the refund above). These
    // three never read the shop settings — stopping auto-renewal is what an owner is told to
    // do in exactly that state —, so they get as far as the database, which is not there.
    const env = {
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://raditi:private-password@127.0.0.1:1/raditi',
      YOOKASSA_SHOP_ID: '123456',
      YOOKASSA_SECRET_KEY: 'private-secret-key',
    }
    const who = ['--reason', 'r', '--operator', 'operator-test']
    for (const [name, args, announced] of [
      ['stop-renewal', ['anna@example.ru', ...who], 'Действие: отключить автопродление тарифа'],
      [
        'settle-payment',
        ['--order', ORDER, '--not-found', ...who],
        'Действие: закрыть запись о списании без ответа',
      ],
      ['refunds-needed', [], null],
    ] as const) {
      const write = vi.fn<(text: string) => void>()
      const run = runBillingCommand(name, args, env, write)

      // Not «Окружение задано неверно: … YOOKASSA_AUTOPAYMENTS …»: the database was asked.
      await expect(run).rejects.toMatchObject({ message: UNFINISHED })
      const said = write.mock.calls.map(([text]) => text).join('')
      if (announced === null) expect(said).toBe('')
      else expect(said).toContain(announced)
    }
  })

  it('refuses to settle a payment without a shop or without the address of the app', async () => {
    const write = vi.fn<(text: string) => void>()
    const env = {
      APP_ENV: 'test',
      DATABASE_URL: 'postgresql://raditi:private-password@127.0.0.1:1/raditi',
    }
    const shop = { YOOKASSA_SHOP_ID: '123456', YOOKASSA_SECRET_KEY: 'test_private-secret-key' }

    await expect(runBillingCommand('settle-payment', [PAYMENT], env, write)).rejects.toThrow(
      /^ЮKassa не настроена: задайте YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY\.$/,
    )
    const noAppUrl = runBillingCommand('settle-payment', [PAYMENT], { ...env, ...shop }, write)
    await expect(noAppUrl).rejects.toThrow(/Окружение задано неверно.*APP_URL/s)
    await expect(noAppUrl).rejects.not.toThrow(/private/)
    await expect(
      runBillingCommand(
        'settle-payment',
        [PAYMENT],
        { ...env, ...shop, APP_URL: 'ftp://raditi.example' },
        write,
      ),
    ).rejects.toThrow(/Окружение задано неверно.*APP_URL/s)
    // As for the core role: letters of production link to an https origin only.
    await expect(
      runBillingCommand(
        'settle-payment',
        [PAYMENT],
        {
          ...env,
          ...shop,
          YOOKASSA_AUTOPAYMENTS: 'on',
          APP_ENV: 'production',
          APP_URL: 'http://raditi.example',
        },
        write,
      ),
    ).rejects.toThrow(/^Окружение задано неверно: APP_URL: must use https in production$/)
    // Nothing was announced before the environment was found fit.
    expect(write).not.toHaveBeenCalled()
  })

  describe('what the operator is told after auto-renewal was switched off', () => {
    const now = new Date('2026-10-04T09:00:00.000Z')
    const ahead = new Date('2026-11-04T09:00:00.000Z')
    const behind = new Date('2026-10-04T06:00:00.000Z')
    const report = (
      periodEnd: Date,
      renewalCharge: 'none' | 'at_bank' | 'unanswered',
      status: 'active' | 'past_due' = 'active',
    ) => stopReport({ status, periodEnd, renewalCharge }, now)

    it('says until when the tariff works only while that moment is ahead', () => {
      expect(report(ahead, 'none')).toEqual([
        'Тариф действует до 04.11.2026 12:00 МСК и больше не списывается.',
      ])
      expect(report(behind, 'none')).toEqual([
        'Оплаченный период закончился 04.10.2026 09:00 МСК: списаний больше не будет, тариф завершится при ближайшей проверке.',
      ])
      // The very moment of the end is not ahead.
      expect(report(now, 'none')[0]).toMatch(/^Оплаченный период закончился /)
    })

    it('never says «больше не списывается» while a charge of the period is under way', () => {
      const atBank = report(behind, 'at_bank')
      expect(atBank).toEqual([
        'Оплаченный период закончился 04.10.2026 09:00 МСК.',
        'Списание за следующий период уже отправлено в банк и не останавливается: если платёж пройдёт, тариф продлится ещё на месяц, после этого списаний не будет. Вернуть эти деньги можно командой billing:refund по заказу продления.',
      ])
      const unanswered = report(behind, 'unanswered')
      expect(unanswered).toEqual([
        'Оплаченный период закончился 04.10.2026 09:00 МСК.',
        'Списание за следующий период отправлено, ответа ЮKassa нет; повторяться оно не будет. Если деньги списаны, тариф продлится на месяц, когда придёт уведомление ЮKassa; если оно не придёт, примерно через 12 часов заказ появится в billing:refunds-needed как списание без ответа.',
      ])
      for (const lines of [atBank, unanswered, report(ahead, 'at_bank')]) {
        expect(lines.join(' ')).not.toContain('больше не списывается')
        expect(lines.join(' ')).not.toContain('списаний больше не будет')
      }
      expect(report(ahead, 'at_bank')[0]).toBe('Тариф действует до 04.11.2026 12:00 МСК.')
    })

    it('says of an overdue tariff only that nothing is charged by itself', () => {
      expect(report(behind, 'none', 'past_due')).toEqual([
        'Тариф ждёт оплаты: автоматических списаний не будет.',
      ])
    })
  })

  describe('what the operator is told of the credits after a refund', () => {
    const REFUND = '2f1c3e5a-0015-5000-8000-1a2b3c4d5e6f'
    const refunded = (patch: Partial<OrderRefund> = {}): OrderRefund => ({
      orderId: ORDER,
      state: 'refunded',
      refundId: REFUND,
      amount: '1990.00',
      requested: true,
      settled: true,
      cabinet: false,
      cancellation: null,
      tariff: null,
      credits: null,
      ...patch,
    })
    const done = `Возврат ${REFUND} проведён: заказ отмечен возвращённым.`

    it('says that a refund ЮKassa has not finished changed neither the tariff nor the credits', () => {
      expect(refundReport(refunded({ state: 'pending', settled: false }))).toEqual([
        `Возврат ${REFUND} принят ЮKassa и ещё обрабатывается. Заказ остаётся оплаченным, тариф и кредиты не изменены.`,
        'Повторите команду с теми же параметрами позже: второй возврат не будет создан.',
      ])
    })

    it('counts the credits of the tariff that expired with it', () => {
      const tariff = {
        outcome: 'ended',
        subscriptionId: WORKSPACE,
        expiredCredits: 30,
        endedAt: new Date('2026-10-04T09:00:00.000Z'),
      } as const
      expect(refundReport(refunded({ tariff }))).toEqual([
        done,
        'Тариф завершён 04.10.2026 12:00 МСК; сгорело кредитов тарифа: 30.',
      ])
    })

    it.each([
      [{ outcome: 'taken', credits: 10 }, 'Снято кредитов пакета: 10.'],
      [{ outcome: 'taken', credits: 1 }, 'Снято кредитов пакета: 1.'],
      [{ outcome: 'already_taken', credits: 10 }, 'Кредиты пакета уже были сняты раньше (10).'],
      [
        { outcome: 'nothing_available' },
        'Снимать нечего: кредиты пакета потрачены или заняты задачами.',
      ],
    ] as const)('says what became of the credits of a refunded pack: %o', (credits, line) => {
      expect(refundReport(refunded({ credits }))).toEqual([done, line])
    })
  })

  describe('what the operator is told after a payment was settled by hand', () => {
    it.each([
      ['paid', false, `Платёж ${PAYMENT}: заказ ${ORDER} оплачен и зачислен.`],
      [
        'paid',
        true,
        `Платёж ${PAYMENT}: заказ ${ORDER} оплачен, но не зачислен. Деньги нужно вернуть: заказ есть в billing:refunds-needed.`,
      ],
      [
        'failed',
        true,
        `Платёж ${PAYMENT} прошёл, а заказ ${ORDER} закрыт (оплата не прошла). Деньги нужно вернуть: заказ есть в billing:refunds-needed.`,
      ],
      [
        'cancelled',
        true,
        `Платёж ${PAYMENT} прошёл, а заказ ${ORDER} закрыт (отменён). Деньги нужно вернуть: заказ есть в billing:refunds-needed.`,
      ],
      [
        'failed',
        false,
        `Платёж ${PAYMENT}: заказ ${ORDER} закрыт без оплаты: платёж не прошёл, возвращать нечего.`,
      ],
      [
        'cancelled',
        false,
        `Платёж ${PAYMENT}: заказ ${ORDER} отменён, денег по платежу нет: возвращать нечего.`,
      ],
      [
        'pending',
        false,
        `Платёж ${PAYMENT}: заказ ${ORDER} ещё ждёт исхода платежа; итог применится по уведомлению ЮKassa или при следующей проверке.`,
      ],
      ['refunded', false, `Платёж ${PAYMENT}: заказ ${ORDER} уже возвращён.`],
    ] as const)('%s, refund needed: %s', (state, refundNeeded, text) => {
      expect(settlementReport(PAYMENT, { state, orderId: ORDER, refundNeeded })).toBe(text)
    })

    it('says that a payment is nobody’s without guessing why', () => {
      expect(settlementReport(PAYMENT, { state: 'unknown' })).toBe(
        `Платёж ${PAYMENT} не относится ни к одному заказу: ЮKassa его не знает, либо в его данных нет заказа платформы без платежа на ту же сумму. Записи не изменены.`,
      )
    })
  })
})
