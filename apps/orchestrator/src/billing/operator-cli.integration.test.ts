import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  autoRenewalAuditActions,
  grantPackCredits,
  grantTariffCredits,
  refundAuditActions,
  renewalAuditActions,
  renewalJobAuditActions,
  renewalKey,
  settleOrder,
  settleRefund,
  settlementAuditActions,
  settleStuckOrders,
  writeBillingAudit,
} from '@repo/billing'
import { createPrismaClient, ensurePersonalWorkspace, type PrismaClient } from '@repo/db'
import { createYookassaClient, parseWebhookEvent, type YookassaClient } from '@repo/yookassa'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { FORBIDDEN_CHARGES_HINT, type BillingCommand } from './operator-cli.ts'

// The four commands as an operator runs them: the real scripts in a process of their own, the
// real ЮKassa client against the fake of the local stands, and PostgreSQL. A small server
// stands in for the notification route of web, as in the fake-shop test of @repo/billing. Only
// on a disposable database: `billing:refunds-needed` lists every open entry of the database,
// and the pass of stuck orders that one test runs closes every stuck order it finds.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

interface FakeYookassa {
  apiUrl: string
  controlUrl: string
  settle(): Promise<void>
  close(): Promise<void>
}
interface FakeModule {
  startFakeYookassa(options: {
    shopId: string
    secretKey: string
    webhookUrl: string
  }): Promise<FakeYookassa>
}
// A script of the stands, not a package: loaded by its address, typed by what the test uses.
const fakeModule = new URL(
  '../../../../infra/dev/billing-verify/fake-yookassa.mjs',
  import.meta.url,
)
const cwd = fileURLToPath(new URL('../../', import.meta.url))

const SHOP = { shopId: '123456', secretKey: 'test_synthetic-key' }
const WHO = ['--operator', 'operator-test']
const START = new Date('2026-10-04T09:00:00.000Z')
const END = new Date('2026-11-04T09:00:00.000Z')

describe.skipIf(!enabled)('operator billing commands with PostgreSQL and the fake ЮKassa', () => {
  let db: PrismaClient
  let fake: FakeYookassa
  let receiver: Server
  let shop: YookassaClient
  /** What the stand-in for the notification route made of every `refund.succeeded`. */
  let settlements: string[] = []
  const userIds: string[] = []
  const workspaceIds: string[] = []
  const planIds: string[] = []
  const emails: string[] = []

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        void (async () => {
          const event = parseWebhookEvent(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          if (event.event === 'refund.succeeded') {
            const settled = await settleRefund(
              { prisma: db, yookassa: shop },
              { refundId: event.object.id },
            )
            settlements.push(settled.state)
          }
          return 200
        })()
          .catch(() => 500)
          .then((status) => res.writeHead(status).end())
      })
    })
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
    const { port } = receiver.address() as AddressInfo
    const { startFakeYookassa } = (await import(fakeModule.href)) as FakeModule
    fake = await startFakeYookassa({ ...SHOP, webhookUrl: `http://127.0.0.1:${port}/` })
    shop = createYookassaClient({ ...SHOP, baseUrl: fake.apiUrl })
  })
  afterEach(async () => {
    await control('reset')
    settlements = []
    // The letter of a payment that a test applied.
    for (const email of emails.splice(0)) {
      await db.outboxEvent.deleteMany({
        where: { topic: 'notifications', payload: { path: ['to'], equals: email } },
      })
    }
    const workspaces = { workspaceId: { in: workspaceIds.splice(0) } }
    await db.creditLedger.deleteMany({ where: { account: workspaces } })
    await db.billingAccount.deleteMany({ where: workspaces })
    await db.order.deleteMany({ where: workspaces })
    await db.subscription.deleteMany({ where: workspaces })
    await db.auditLog.deleteMany({ where: workspaces })
    await db.workspace.deleteMany({ where: { id: workspaces.workspaceId } })
    await db.plan.deleteMany({ where: { id: { in: planIds.splice(0) } } })
    await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } })
  })
  afterAll(async () => {
    await fake.close()
    await new Promise((resolve) => receiver.close(resolve))
    await db.$disconnect()
  })

  async function control<T = unknown>(name: string, body?: object): Promise<T> {
    const response = await fetch(`${fake.controlUrl}/${name}`, {
      method: body === undefined && name === 'state' ? 'GET' : 'POST',
      ...(name === 'state' ? {} : { body: JSON.stringify(body ?? {}) }),
    })
    if (!response.ok) throw new Error(`The fake refused «${name}»: ${response.status}`)
    return (await response.json()) as T
  }
  const refundsOfShop = async () =>
    (
      await control<{ refunds: { id: string; payment_id: string; description?: string }[] }>(
        'state',
      )
    ).refunds
  const refundRequests = async () => {
    const response = await fetch(`${fake.controlUrl}/requests`)
    const requests = (await response.json()) as {
      method: string
      path: string
      status?: number
      idempotenceKey?: string
      body?: { description?: string; metadata?: unknown }
    }[]
    return requests.filter((request) => request.method === 'POST' && request.path === '/v3/refunds')
  }

  /** The command as the operator runs it: explicit environment, nothing inherited but PATH. */
  function run(name: BillingCommand, args: string[], env: Record<string, string> = {}) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [`scripts/billing-${name}.mjs`, ...args], {
          cwd,
          env: {
            PATH: process.env.PATH,
            APP_ENV: 'test',
            DATABASE_URL: databaseUrl,
            YOOKASSA_SHOP_ID: SHOP.shopId,
            YOOKASSA_SECRET_KEY: SHOP.secretKey,
            YOOKASSA_API_URL: fake.apiUrl,
            // Only billing:settle-payment with a payment id reads it.
            APP_URL: 'https://raditi.example',
            ...env,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
        child.once('error', reject)
        child.once('close', (code) => {
          clearTimeout(timer)
          resolve({
            code,
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
          })
        })
      },
    )
  }

  /** A payment the customer has made on the page of the fake. */
  async function paidPayment(orderId: string): Promise<string> {
    const payment = await shop.createPayment(
      {
        amount: { value: '4900.00', currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: 'https://raditi.example/return' },
        metadata: { order_id: orderId },
      },
      randomUUID(),
    )
    await control('complete', { paymentId: payment.id })
    return payment.id
  }

  /** A customer on a tariff until 4 November: a paid order of its period, 30 credits granted. */
  async function customer() {
    const email = `${randomUUID()}@billing.example.ru`
    const user = await db.user.create({ data: { name: 'Billing verification', email } })
    userIds.push(user.id)
    emails.push(email)
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspace(tx, { userId: user.id, appEnv: 'test' }),
    )
    workspaceIds.push(workspace.id)
    const plan = await db.plan.create({
      data: {
        slug: `test-${randomUUID()}`,
        name: 'Проверочный',
        kind: 'quota',
        price: '4900.00',
        creditsPerMonth: 30,
        maxSites: 1,
        isActive: false,
      },
    })
    planIds.push(plan.id)
    const subscription = await db.subscription.create({
      data: {
        workspaceId: workspace.id,
        planId: plan.id,
        status: 'active',
        currentPeriodStart: START,
        currentPeriodEnd: END,
        periodAnchor: START,
        paymentMethodId: 'pm-saved',
        paymentMethodType: 'bank_card',
      },
    })
    const order = await db.order.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        planId: plan.id,
        subscriptionId: subscription.id,
        kind: 'subscription',
        amount: '4900.00',
        status: 'paid',
        idempotenceKey: randomUUID(),
        periodStart: START,
        periodEnd: END,
        paidAt: START,
      },
    })
    const paymentId = await paidPayment(order.id)
    await db.order.update({ where: { id: order.id }, data: { yookassaPaymentId: paymentId } })
    await db.$transaction((tx) =>
      grantTariffCredits(tx, { workspaceId: workspace.id, orderId: order.id, credits: 30 }),
    )
    return {
      email,
      userId: user.id,
      workspaceId: workspace.id,
      planId: plan.id,
      subscriptionId: subscription.id,
      orderId: order.id,
      paymentId,
    }
  }
  type Customer = Awaited<ReturnType<typeof customer>>

  /** A second tariff order of the customer, paid while the tariff is on: its money must go back. */
  async function paidTwice(c: Customer) {
    const order = await db.order.create({
      data: {
        workspaceId: c.workspaceId,
        userId: c.userId,
        planId: c.planId,
        kind: 'subscription',
        amount: '4900.00',
        status: 'pending',
        idempotenceKey: randomUUID(),
      },
    })
    const paymentId = await paidPayment(order.id)
    await db.order.update({ where: { id: order.id }, data: { yookassaPaymentId: paymentId } })
    expect(
      await settleOrder(
        { prisma: db, yookassa: shop, appUrl: 'https://raditi.example' },
        { orderId: order.id },
      ),
    ).toMatchObject({ state: 'paid', refundNeeded: true })
    return { orderId: order.id, paymentId }
  }

  /** A pack the customer has bought and been granted: a paid pack order of 10 credits. */
  async function boughtPack(c: Customer) {
    const plan = await db.plan.create({
      data: {
        slug: `test-${randomUUID()}`,
        name: 'Проверочный пакет',
        kind: 'pack',
        price: '1990.00',
        packCredits: 10,
        isActive: false,
      },
    })
    planIds.push(plan.id)
    const order = await db.order.create({
      data: {
        workspaceId: c.workspaceId,
        userId: c.userId,
        planId: plan.id,
        kind: 'pack',
        amount: '1990.00',
        status: 'paid',
        idempotenceKey: randomUUID(),
        paidAt: START,
      },
    })
    await db.$transaction((tx) =>
      grantPackCredits(tx, { workspaceId: c.workspaceId, orderId: order.id, credits: 10 }),
    )
    return { orderId: order.id, credits: 10 }
  }

  const entries = (c: Customer, action: string) =>
    db.auditLog.findMany({ where: { workspaceId: c.workspaceId, action } })

  it('returns a payment, ends the tariff, and makes no second refund when run again', async () => {
    const c = await customer()
    const args = [c.orderId, '--reason', 'Письмо клиента от 4 октября', ...WHO]

    const first = await run('refund', [...args, '--end-subscription'])

    expect(first.stderr).toBe('')
    expect(first.code).toBe(0)
    expect(first.stdout).toContain(`Заказ ${c.orderId}: тариф, 4900.00 ₽, оплачен.`)
    expect(first.stdout).toContain('Оператор: operator-test. Причина: Письмо клиента от 4 октября')
    expect(first.stdout).toContain('Действие: вернуть 4900.00 ₽ через ЮKassa (весь платёж).')
    expect(first.stdout).toContain(
      'Дополнительно: завершить тариф сейчас; доступные кредиты тарифа сгорят.',
    )
    expect(first.stdout).toMatch(/Возврат [0-9a-f-]{36} проведён/)
    expect(first.stdout).toMatch(/Тариф завершён .* МСК; сгорело кредитов тарифа: 30\./)
    // The fake has notified of the refund, and the route has answered.
    await fake.settle()

    const [made, ...others] = await refundsOfShop()
    expect(others).toEqual([])
    expect(made).toMatchObject({ payment_id: c.paymentId })
    expect(await db.order.findUniqueOrThrow({ where: { id: c.orderId } })).toMatchObject({
      status: 'refunded',
      yookassaRefundId: made?.id,
    })
    expect(
      await db.subscription.findUniqueOrThrow({ where: { id: c.subscriptionId } }),
    ).toMatchObject({ status: 'cancelled', cancelAtPeriodEnd: true })
    const balance = await db.billingAccount.findFirstOrThrow({
      where: { workspaceId: c.workspaceId, unit: 'credit_tariff' },
    })
    expect(balance.balance.toFixed(2)).toBe('0.00')
    // The notification of our own refund is never taken for one made in the cabinet, whether
    // it came before the command had stored the refund or after.
    expect(settlements).toEqual(['refunded'])
    expect(await entries(c, refundAuditActions.refundOutside)).toEqual([])
    expect(await entries(c, refundAuditActions.refund)).toMatchObject([
      { actorType: 'operator', actorId: 'operator-test', targetId: c.orderId },
    ])
    expect(await entries(c, renewalJobAuditActions.subscriptionEnd)).toMatchObject([
      { actorType: 'operator', meta: { reason: 'refund', expiredCredits: 30 } },
    ])

    const second = await run('refund', [...args, '--end-subscription'])

    expect(second.stderr).toBe('')
    expect(second.code).toBe(0)
    expect(second.stdout).toContain(`Заказ ${c.orderId}: тариф, 4900.00 ₽, возвращён.`)
    expect(second.stdout).toContain('Деньги уже возвращены')
    expect(second.stdout).toContain('второй возврат не создан')
    expect(second.stdout).toContain('Тариф уже был завершён раньше.')
    await fake.settle()
    expect(await refundsOfShop()).toHaveLength(1)
    const requests = await refundRequests()
    expect(requests.map((request) => request.idempotenceKey)).toEqual([`refund.${c.orderId}`])
    // The refund is marked as the platform's own by its description, which the shop returns
    // with it; no metadata is sent, and the operator's reason stays in the audit log.
    expect(requests[0]?.body).toMatchObject({ description: `Возврат по заказу ${c.orderId}` })
    expect(requests[0]?.body?.metadata).toBeUndefined()
    expect(made).toMatchObject({ description: `Возврат по заказу ${c.orderId}` })
    expect(await entries(c, refundAuditActions.refund)).toHaveLength(1)
    // Neither run printed the key of the shop.
    for (const output of [first, second]) {
      expect(output.stdout + output.stderr).not.toContain(SHOP.secretKey)
    }
  })

  it('moves only the money without an option', async () => {
    const c = await customer()

    const result = await run('refund', [c.orderId, '--reason', 'Двойное списание', ...WHO])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      'Тариф и кредиты клиента не меняются: возвращаются только деньги.',
    )
    await fake.settle()
    expect((await db.order.findUniqueOrThrow({ where: { id: c.orderId } })).status).toBe('refunded')
    expect(
      await db.subscription.findUniqueOrThrow({ where: { id: c.subscriptionId } }),
    ).toMatchObject({ status: 'active', currentPeriodEnd: END, cancelAtPeriodEnd: false })
    expect(await entries(c, refundAuditActions.refund)).toMatchObject([
      { meta: { moneyOnly: true, reason: 'Двойное списание' } },
    ])
  })

  it('refuses a payment that was returned in the cabinet, which leaves its audit entry', async () => {
    const c = await customer()
    // «In the cabinet»: a refund of the shop that no request of the platform asked for.
    const cabinet = await shop.createRefund(
      { payment_id: c.paymentId, amount: { value: '1000.00', currency: 'RUB' } },
      randomUUID(),
    )
    await fake.settle()

    expect(settlements).toEqual(['outside'])
    expect(await entries(c, refundAuditActions.refundOutside)).toMatchObject([
      {
        actorType: 'system',
        targetId: c.orderId,
        meta: { refundId: cabinet.id, refundAmount: '1000.00', orderAmount: '4900.00' },
      },
    ])

    const result = await run('refund', [c.orderId, '--reason', 'Письмо', ...WHO])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('По платежу уже есть возврат, о котором заказ не знает')
    expect(result.stdout).not.toContain('проведён')
    // A part went back: the shop is asked for nothing more than the payment.
    expect(await refundRequests()).toHaveLength(1)
    expect(await db.order.findUniqueOrThrow({ where: { id: c.orderId } })).toMatchObject({
      status: 'paid',
      yookassaRefundId: null,
    })
    expect(await entries(c, refundAuditActions.refund)).toEqual([])

    // Marking it as returned in the cabinet is refused as well: not all of it went back.
    const marked = await run('refund', [
      c.orderId,
      '--refunded-in-cabinet',
      '--reason',
      'Письмо',
      ...WHO,
    ])
    expect(marked.code).toBe(1)
    expect(marked.stderr).toContain(
      '--refunded-in-cabinet не подходит: по данным ЮKassa платёж не возвращён полностью.',
    )
    expect((await db.order.findUniqueOrThrow({ where: { id: c.orderId } })).status).toBe('paid')
  })

  it('marks a payment returned in the cabinet in full as refunded, and then ends the tariff', async () => {
    const c = await customer()
    await shop.createRefund(
      { payment_id: c.paymentId, amount: { value: '4900.00', currency: 'RUB' } },
      randomUUID(),
    )
    await fake.settle()
    const args = [c.orderId, '--reason', 'Вернули в кабинете 4 октября', ...WHO]

    // Without the option: the command asks the shop once whether the refund is its own (the
    // shop refuses to make another), then tells the operator what to do.
    const plain = await run('refund', args)

    expect(plain.code).toBe(1)
    expect(plain.stderr).toContain('повторите команду с --refunded-in-cabinet')
    const asked = await refundRequests()
    expect(asked.map((request) => request.status)).toEqual([200, 400])
    expect(await refundsOfShop()).toHaveLength(1)

    const marked = await run('refund', [...args, '--refunded-in-cabinet', '--end-subscription'])

    expect(marked.stderr).toBe('')
    expect(marked.code).toBe(0)
    expect(marked.stdout).toContain(
      'Действие: отметить заказ возвращённым без запроса на возврат, если ЮKassa подтвердит, что весь платёж (4900.00 ₽) уже возвращён в кабинете.',
    )
    expect(marked.stdout).toContain(
      'Заказ отмечен возвращённым: по данным ЮKassa весь платёж возвращён в кабинете. Запрос на возврат не отправлялся.',
    )
    expect(marked.stdout).toMatch(/Тариф завершён .* МСК; сгорело кредитов тарифа: 30\./)
    // Nothing more was asked of the shop.
    expect(await refundRequests()).toHaveLength(2)
    const order = await db.order.findUniqueOrThrow({ where: { id: c.orderId } })
    expect(order).toMatchObject({ status: 'refunded', yookassaRefundId: null })
    expect(order.refundedAmount?.toFixed(2)).toBe('4900.00')
    expect(order.refundedAt).toBeInstanceOf(Date)
    expect(
      await db.subscription.findUniqueOrThrow({ where: { id: c.subscriptionId } }),
    ).toMatchObject({ status: 'cancelled' })
    expect(await entries(c, refundAuditActions.refund)).toMatchObject([
      { actorType: 'operator', meta: { cabinet: true, refundId: null, tariff: 'ended' } },
    ])

    const again = await run('refund', [...args, '--refunded-in-cabinet'])
    expect(again.code).toBe(0)
    expect(again.stdout).toContain(
      'Заказ уже возвращён (возврат из кабинета ЮKassa): второй возврат не создан.',
    )
    expect(await entries(c, refundAuditActions.refund)).toHaveLength(1)
  })

  it('says of a refunded order whose tariff has renewed that the tariff goes on, not that no money moved', async () => {
    const c = await customer()
    const args = [c.orderId, '--reason', 'Письмо клиента', ...WHO]
    expect((await run('refund', args)).code).toBe(0)
    await fake.settle()
    // The tariff renews: another order pays for its next month.
    await db.subscription.update({
      where: { id: c.subscriptionId },
      data: { currentPeriodStart: END, currentPeriodEnd: new Date('2026-12-04T09:00:00.000Z') },
    })

    const result = await run('refund', [...args, '--end-subscription'])

    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Деньги уже возвращены')
    expect(result.stdout).toContain(
      'Тариф не завершён: он уже перешёл в следующий период, оплаченный другим заказом.',
    )
    expect(result.stdout + result.stderr).not.toContain('Деньги не возвращались')
    expect(
      await db.subscription.findUniqueOrThrow({ where: { id: c.subscriptionId } }),
    ).toMatchObject({ status: 'active' })
  })

  it('lists a refunded order whose option was asked for while the refund was pending, with the command to run', async () => {
    const c = await customer()
    // What a pending refund leaves once its notification has settled it: the fake's refunds
    // succeed at once, so the state is written as `refundOrder` and `settleRefund` leave it.
    await db.order.update({
      where: { id: c.orderId },
      data: {
        status: 'refunded',
        yookassaRefundId: `refund-${randomUUID()}`,
        refundedAt: new Date(),
        refundedAmount: '4900.00',
      },
    })
    await writeBillingAudit(db, {
      actor: { type: 'operator', id: 'operator-test' },
      workspaceId: c.workspaceId,
      action: refundAuditActions.refund,
      target: { type: 'order', id: c.orderId },
      meta: {
        reason: 'Письмо клиента',
        refundStatus: 'pending',
        endSubscription: true,
        takeCredits: false,
        tariff: null,
        credits: null,
      },
    })

    const listed = await run('refunds-needed', [])

    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain('Возврат проведён, параметр не применён: 1.')
    expect(listed.stdout).toContain(`заказ ${c.orderId} (тариф, возвращён `)
    const command = `billing:refund -- ${c.orderId} --end-subscription --reason "<причина>"`
    expect(listed.stdout).toContain(`возврат проведён, параметр не применён: повторите ${command}`)

    // The command as the list names it.
    const applied = await run('refund', [
      c.orderId,
      '--end-subscription',
      '--reason',
      'Письмо клиента',
      ...WHO,
    ])
    expect(applied.code).toBe(0)
    expect(applied.stdout).toMatch(/Тариф завершён .* МСК/)

    const after = await run('refunds-needed', [])
    expect(after.stdout).not.toContain('параметр не применён')
    expect(after.stdout).not.toContain(c.orderId)
  })

  it('lists a refunded pack whose credits were asked for while the refund was pending, with the command to run', async () => {
    const c = await customer()
    const pack = await boughtPack(c)
    const packBalance = async () =>
      (
        await db.billingAccount.findFirstOrThrow({
          where: { workspaceId: c.workspaceId, unit: 'credit_pack' },
        })
      ).balance.toFixed(2)
    expect(await packBalance()).toBe('10.00')
    // As above: the state a pending refund leaves once its notification has settled it.
    await db.order.update({
      where: { id: pack.orderId },
      data: {
        status: 'refunded',
        yookassaRefundId: `refund-${randomUUID()}`,
        refundedAt: new Date(),
        refundedAmount: '1990.00',
      },
    })
    await writeBillingAudit(db, {
      actor: { type: 'operator', id: 'operator-test' },
      workspaceId: c.workspaceId,
      action: refundAuditActions.refund,
      target: { type: 'order', id: pack.orderId },
      meta: {
        reason: 'Письмо клиента',
        refundStatus: 'pending',
        endSubscription: false,
        takeCredits: true,
        tariff: null,
        credits: null,
      },
    })

    const listed = await run('refunds-needed', [])

    expect(listed.stderr).toBe('')
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain('Возврат проведён, параметр не применён: 1.')
    expect(listed.stdout).toContain(`заказ ${pack.orderId} (пакет кредитов`)
    // The option is printed as the parser reads it, and only the one that was asked for.
    const command = `billing:refund -- ${pack.orderId} --take-credits --reason "<причина>"`
    expect(listed.stdout).toContain(`возврат проведён, параметр не применён: повторите ${command}`)

    // The option is for the order of a pack: the tariff order is refused by the option's name.
    const tariffOrder = await run('refund', [
      c.orderId,
      '--take-credits',
      '--reason',
      'Письмо клиента',
      ...WHO,
    ])
    expect(tariffOrder.code).toBe(1)
    expect(tariffOrder.stderr).toMatch(/^--take-credits /)
    expect(await refundRequests()).toEqual([])
    expect(await packBalance()).toBe('10.00')

    // The command as the list names it.
    const applied = await run('refund', [
      pack.orderId,
      '--take-credits',
      '--reason',
      'Письмо клиента',
      ...WHO,
    ])
    expect(applied.stderr).toBe('')
    expect(applied.code).toBe(0)
    expect(applied.stdout).toContain(`Заказ ${pack.orderId}: пакет кредитов, `)
    expect(applied.stdout).toContain('Деньги уже возвращены')
    expect(applied.stdout).toMatch(/^Дополнительно: снять доступные кредиты этого пакета\.$/m)
    expect(applied.stdout).toMatch(new RegExp(`^Снято кредитов пакета: ${pack.credits}\\.$`, 'm'))
    expect(await packBalance()).toBe('0.00')
    // The newest entry of the order says what was asked for and what came of it.
    const written = await db.auditLog.findMany({
      where: { action: refundAuditActions.refund, targetId: pack.orderId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    expect(written).toHaveLength(2)
    expect(written[0]).toMatchObject({
      actorType: 'operator',
      meta: { takeCredits: true, credits: 'taken', takenCredits: pack.credits },
    })

    const after = await run('refunds-needed', [])
    expect(after.stdout).not.toContain('параметр не применён')
    expect(after.stdout).not.toContain(pack.orderId)
  })

  it('refuses an order that does not exist and one that is not paid, with exit code 1', async () => {
    const c = await customer()
    await db.order.update({ where: { id: c.orderId }, data: { status: 'failed' } })

    const unpaid = await run('refund', [c.orderId, '--reason', 'Письмо', ...WHO])
    const missing = await run('refund', [randomUUID(), '--reason', 'Письмо', ...WHO])

    expect(unpaid.code).toBe(1)
    expect(unpaid.stderr).toBe('Заказ не оплачен: вернуть можно только оплаченный заказ.\n')
    expect(missing.code).toBe(1)
    expect(missing.stderr).toBe('Заказ не найден.\n')
    expect(missing.stdout).toBe('')
    expect(await refundRequests()).toEqual([])
  })

  it('lists the money that waits to be returned until the command has returned it', async () => {
    const c = await customer()
    const extra = await paidTwice(c)

    const listed = await run('refunds-needed', [])

    expect(listed.stderr).toBe('')
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain(`заказ ${extra.orderId} (оплачен) · платёж ${extra.paymentId}`)
    expect(listed.stdout).toContain('к возврату 4900.00 ₽ из 4900.00 ₽')
    expect(listed.stdout).toContain('причина: тариф уже действовал, когда заказ оплатили')
    expect(listed.stdout).toContain(`как вернуть: billing:refund -- ${extra.orderId}`)
    // The order the tariff was started with owes nothing.
    expect(listed.stdout).not.toContain(c.orderId)

    expect((await run('refund', [extra.orderId, '--reason', 'Двойная оплата', ...WHO])).code).toBe(
      0,
    )
    await fake.settle()

    const after = await run('refunds-needed', ['--limit', '10'])
    expect(after.code).toBe(0)
    expect(after.stdout).not.toContain(extra.orderId)
  })

  it('switches auto-renewal off by the email, once, under the name of the OS user', async () => {
    const c = await customer()

    const first = await run('stop-renewal', [c.email, '--reason', 'Письмо клиента'])

    expect(first.stderr).toBe('')
    expect(first.code).toBe(0)
    expect(first.stdout).toContain(`Действие: отключить автопродление тарифа, клиент ${c.email}.`)
    // The address the database holds is shown next to what was switched off.
    expect(first.stdout).toContain(
      `Автопродление отключено: клиент ${c.email}, подписка ${c.subscriptionId}`,
    )
    expect(first.stdout).toContain(
      'Тариф действует до 04.11.2026 12:00 МСК и больше не списывается.',
    )
    // The command reads no shop setting: it names the condition, true at either value of it.
    expect(first.stdout).toContain(
      'Способ оплаты сохранён: клиент может включить автопродление снова, если магазину разрешены автоплатежи (YOOKASSA_AUTOPAYMENTS=on).',
    )
    const subscription = await db.subscription.findUniqueOrThrow({
      where: { id: c.subscriptionId },
    })
    expect(subscription).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: true,
      paymentMethodId: 'pm-saved',
      currentPeriodEnd: END,
    })
    expect(subscription.cancelledAt).toBeInstanceOf(Date)
    expect(await entries(c, autoRenewalAuditActions.operatorStop)).toMatchObject([
      {
        actorType: 'operator',
        actorId: userInfo().username,
        targetId: c.subscriptionId,
        meta: { reason: 'Письмо клиента', namedBy: 'email' },
      },
    ])

    const second = await run('stop-renewal', ['--workspace', c.workspaceId, '--reason', 'Письмо'])

    expect(second.code).toBe(1)
    expect(second.stderr).toBe('Автопродление уже отключено.\n')
    expect(await entries(c, autoRenewalAuditActions.operatorStop)).toHaveLength(1)
  })

  it('finds no tariff to stop for an address nobody has, and for a workspace without one', async () => {
    const nobody = await run('stop-renewal', [
      `${randomUUID()}@billing.example.ru`,
      '--reason',
      'Письмо',
      ...WHO,
    ])
    const empty = await run('stop-renewal', [
      '--workspace',
      randomUUID(),
      '--reason',
      'Письмо',
      ...WHO,
    ])

    expect(nobody.code).toBe(1)
    expect(nobody.stderr).toBe('Пользователь с таким адресом не найден.\n')
    expect(empty.code).toBe(1)
    expect(empty.stderr).toBe('У клиента нет действующего тарифа.\n')
  })

  it('does not take an underscore in the address for «any character»', async () => {
    const c = await customer()
    const tag = randomUUID()
    await db.user.update({
      where: { id: c.userId },
      data: { email: `ivan.petrov.${tag}@billing.example.ru` },
    })

    const result = await run('stop-renewal', [
      `ivan_petrov.${tag}@billing.example.ru`,
      '--reason',
      'Письмо',
      ...WHO,
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toBe('Пользователь с таким адресом не найден.\n')
    expect(
      await db.subscription.findUniqueOrThrow({ where: { id: c.subscriptionId } }),
    ).toMatchObject({ cancelAtPeriodEnd: false })
    expect(await entries(c, autoRenewalAuditActions.operatorStop)).toEqual([])
  })

  /**
   * The paid period of the customer ended an hour ago and its renewal charge was started
   * `minutesAgo` minutes ago: a pending renewal order, with a payment or without one.
   */
  async function chargeUnderWay(c: Customer, minutesAgo: number, paymentId: string | null) {
    const now = Date.now()
    const start = new Date(now - 31 * 24 * 60 * 60_000)
    const end = new Date(now - 60 * 60_000)
    await db.subscription.update({
      where: { id: c.subscriptionId },
      data: {
        currentPeriodStart: start,
        currentPeriodEnd: end,
        periodAnchor: start,
        renewalNoticePeriodEnd: end,
      },
    })
    const order = await db.order.create({
      data: {
        workspaceId: c.workspaceId,
        userId: c.userId,
        planId: c.planId,
        subscriptionId: c.subscriptionId,
        kind: 'subscription',
        amount: '4900.00',
        status: 'pending',
        idempotenceKey: renewalKey(c.subscriptionId, end),
        yookassaPaymentId: paymentId,
        createdAt: new Date(now - minutesAgo * 60_000),
      },
    })
    return { orderId: order.id, key: order.idempotenceKey, periodEnd: end }
  }

  it('tells the operator of a renewal charge that is already at the bank', async () => {
    const c = await customer()
    await chargeUnderWay(c, 30, `payment-${randomUUID()}`)

    const result = await run('stop-renewal', [c.email, '--reason', 'Письмо клиента', ...WHO])

    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/Оплаченный период закончился \d\d\.\d\d\.\d{4} \d\d:\d\d МСК\./)
    expect(result.stdout).toContain(
      'Списание за следующий период уже отправлено в банк и не останавливается: если платёж пройдёт, тариф продлится ещё на месяц',
    )
    expect(result.stdout).not.toContain('Тариф действует до')
    expect(result.stdout).not.toContain('больше не списывается')
    expect(await entries(c, autoRenewalAuditActions.operatorStop)).toMatchObject([
      { meta: { renewalCharge: 'at_bank' } },
    ])
  })

  it('applies a renewal charge whose answer was lost once the operator names its payment', async () => {
    const c = await customer()
    const charge = await chargeUnderWay(c, 30, null)

    const stopped = await run('stop-renewal', [c.email, '--reason', 'Письмо клиента', ...WHO])

    expect(stopped.code).toBe(0)
    expect(stopped.stdout).toContain(
      'Списание за следующий период отправлено, ответа ЮKassa нет; повторяться оно не будет.',
    )
    expect(await entries(c, autoRenewalAuditActions.operatorStop)).toMatchObject([
      { meta: { renewalCharge: 'unanswered' } },
    ])

    // The shop did make the payment. The operator finds it in the cabinet by the order id.
    const paymentId = await paidPayment(charge.orderId)
    const settled = await run('settle-payment', [paymentId])

    expect(settled.stderr).toBe('')
    expect(settled.code).toBe(0)
    expect(settled.stdout).toContain(
      `Действие: перечитать платёж ${paymentId} в ЮKassa; если он создан для заказа платформы, у которого нет платежа, привязать его к заказу и провести заказ.`,
    )
    expect(settled.stdout).toContain(`Платёж привязан к заказу ${charge.orderId}.`)
    expect(settled.stdout).toContain(
      `Платёж ${paymentId}: заказ ${charge.orderId} оплачен и зачислен.`,
    )
    expect(await db.order.findUniqueOrThrow({ where: { id: charge.orderId } })).toMatchObject({
      status: 'paid',
      yookassaPaymentId: paymentId,
    })
    const renewed = await db.subscription.findUniqueOrThrow({ where: { id: c.subscriptionId } })
    // One more month, the last: auto-renewal stays off.
    expect(renewed).toMatchObject({ status: 'active', cancelAtPeriodEnd: true })
    expect(renewed.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now())
    expect(renewed.currentPeriodStart).toEqual(charge.periodEnd)
    expect(await entries(c, settlementAuditActions.paymentAttached)).toMatchObject([
      { actorType: 'system', targetId: charge.orderId, meta: { paymentId } },
    ])

    // Named again: the order holds the payment now, and nothing happens twice.
    const again = await run('settle-payment', [paymentId])
    expect(again.code).toBe(0)
    expect(again.stdout).toContain(
      `Действие: перечитать платёж ${paymentId} в ЮKassa и провести заказ ${charge.orderId}.`,
    )
    expect(again.stdout).not.toContain('привязан')
    expect(await entries(c, settlementAuditActions.paymentAttached)).toHaveLength(1)
    // Neither run printed the key of the shop.
    expect(settled.stdout + again.stdout).not.toContain(SHOP.secretKey)
  })

  it('lists a charge that was given up without an answer until its payment is found or said to be missing', async () => {
    const found = await customer()
    const missing = await customer()
    // Thirteen hours ago: a repeat is no longer safe, and the pass of stuck orders gives up.
    const charges = {
      found: await chargeUnderWay(found, 13 * 60, null),
      missing: await chargeUnderWay(missing, 13 * 60, null),
    }
    await db.subscription.updateMany({
      where: { id: { in: [found.subscriptionId, missing.subscriptionId] } },
      data: { cancelAtPeriodEnd: true, cancelledAt: new Date() },
    })
    const pass = await settleStuckOrders({
      prisma: db,
      yookassa: shop,
      appUrl: 'https://raditi.example',
      settings: { noticeDays: 3, pastDueDays: 7 },
    })
    expect(pass.counts.gave_up).toBe(2)
    expect(await entries(found, renewalAuditActions.unknownResult)).toHaveLength(1)

    const listed = await run('refunds-needed', [])

    expect(listed.stderr).toBe('')
    expect(listed.code).toBe(0)
    // Nobody knows of any money yet.
    expect(listed.stdout).toContain('Заказов, ожидающих возврата, нет.')
    expect(listed.stdout).toContain('Списания без ответа: 2.')
    // Once for the section: what a 403 `forbidden` in the log of core means for these charges.
    expect(listed.stdout.split(FORBIDDEN_CHARGES_HINT)).toHaveLength(2)
    expect(FORBIDDEN_CHARGES_HINT).toContain(
      'ЮKassa ответила 403: у магазина нет права на автоплатежи. Платежа тогда не было: искать его в кабинете незачем — обратитесь в ЮKassa',
    )
    for (const [c, charge] of [
      [found, charges.found],
      [missing, charges.missing],
    ] as const) {
      expect(listed.stdout).toContain(
        ` · заказ ${charge.orderId} · подписка ${c.subscriptionId} · 4900.00 ₽ · ключ запроса ${charge.key}`,
      )
      expect(listed.stdout).toMatch(
        new RegExp(
          `как проверить: в кабинете ЮKassa найдите платёж на эту сумму, созданный с .* МСК в течение 12 часов; в его данных order_id = ${charge.orderId}`,
        ),
      )
      expect(listed.stdout).toContain(
        `платежа нет: billing:settle-payment -- --order ${charge.orderId} --not-found --reason "<причина>"`,
      )
    }
    expect(listed.stdout).toContain(
      'платёж нашёлся: billing:settle-payment -- <идентификатор платежа>',
    )

    // One payment is found in the cabinet: the money was taken for an order that is closed.
    const paymentId = await paidPayment(charges.found.orderId)
    const settled = await run('settle-payment', [paymentId])
    expect(settled.code).toBe(0)
    expect(settled.stdout).toContain(`Платёж привязан к заказу ${charges.found.orderId}.`)
    expect(settled.stdout).toContain(
      `Платёж ${paymentId} прошёл, а заказ ${charges.found.orderId} закрыт (оплата не прошла). Деньги нужно вернуть: заказ есть в billing:refunds-needed.`,
    )

    // The other was looked for and is not there.
    const closing = [
      '--order',
      charges.missing.orderId,
      '--not-found',
      '--reason',
      'В кабинете платежа нет',
      ...WHO,
    ]
    const closed = await run('settle-payment', closing)
    expect(closed.stderr).toBe('')
    expect(closed.code).toBe(0)
    expect(closed.stdout).toContain(
      `Действие: закрыть запись о списании без ответа по заказу ${charges.missing.orderId}: платежа в ЮKassa нет.`,
    )
    expect(closed.stdout).toContain('Оператор: operator-test. Причина: В кабинете платежа нет')
    expect(closed.stdout).toContain(
      `Запись закрыта: заказ ${charges.missing.orderId} больше не показывается в billing:refunds-needed.`,
    )
    expect(await entries(missing, renewalAuditActions.unknownResultChecked)).toMatchObject([
      {
        actorType: 'operator',
        actorId: 'operator-test',
        targetId: charges.missing.orderId,
        meta: { reason: 'В кабинете платежа нет', found: false },
      },
    ])
    const repeated = await run('settle-payment', closing)
    expect(repeated.code).toBe(0)
    expect(repeated.stdout).toContain('уже была закрыта раньше: ничего не изменено.')
    expect(await entries(missing, renewalAuditActions.unknownResultChecked)).toHaveLength(1)

    const after = await run('refunds-needed', [])
    expect(after.stdout).not.toContain('Списания без ответа')
    expect(after.stdout).not.toContain(charges.missing.orderId)
    expect(after.stdout).toContain('Ожидают возврата: 1.')
    expect(after.stdout).toContain(
      `заказ ${charges.found.orderId} (оплата не прошла) · платёж ${paymentId}`,
    )
    expect(after.stdout).toContain('причина: платёж прошёл после закрытия заказа')
    expect(after.stdout).toContain('как вернуть: в кабинете ЮKassa')
  })

  it('refuses to settle a payment nobody knows and to close an order that is no such charge', async () => {
    const c = await customer()

    const stray = randomUUID()
    const unknown = await run('settle-payment', [stray])
    const paid = await run('settle-payment', [
      '--order',
      c.orderId,
      '--not-found',
      '--reason',
      'Письмо',
      ...WHO,
    ])
    const nobody = await run('settle-payment', [
      '--order',
      randomUUID(),
      '--not-found',
      '--reason',
      'Письмо',
      ...WHO,
    ])

    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toBe(
      `Платёж ${stray} не относится ни к одному заказу: ЮKassa его не знает, либо в его данных нет заказа платформы без платежа на ту же сумму. Записи не изменены.\n`,
    )
    // A shop that does not answer is not «the payment is nobody's», and no refund is spoken of.
    const silent = await run('settle-payment', [stray], {
      YOOKASSA_API_URL: 'http://127.0.0.1:1/v3',
    })
    expect(silent.code).toBe(1)
    expect(silent.stderr).toBe(
      'ЮKassa не ответила или ответила непонятно: платёж не проведён. Повторите команду позже — повтор безопасен.\n',
    )
    expect(paid.code).toBe(1)
    expect(paid.stderr).toMatch(/^Заказ не числится списанием без ответа: закрывать нечего\./)
    expect(nobody.code).toBe(1)
    expect(nobody.stderr).toBe('Заказ не найден.\n')
    expect(await db.auditLog.count({ where: { workspaceId: c.workspaceId } })).toBe(0)
  })
})
