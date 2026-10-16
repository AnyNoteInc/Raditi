import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createPrismaClient, findPersonalWorkspace, type PrismaClient } from '@repo/db'
import { createYookassaClient, parseWebhookEvent, type YookassaClient } from '@repo/yookassa'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { checkoutReturnUrl, startCheckout, syncOrder } from './checkout.ts'
import type { BillingDeps } from './deps.ts'
import { orderFailureReasons } from './failure-text.ts'
import { giftAuditActions } from './ledger.ts'
import { getCreditBalances } from './read-models.ts'
import { settleOrderByPaymentId, settlementAuditActions } from './settlement.ts'
import { billingFixtures, GIFT_GRANTED, GIFT_ONLY, TEST_APP_URL } from './testing.ts'

// Checkout and settlement against the fake ЮKassa of the local stands, through the real client:
// the fake checks the request as the API would (the key, one-stage capture, no receipt), shows
// the payment page and sends notifications. A small server stands in for the notification
// route of web. The full stand with web and core is M5.15.

const databaseUrl = process.env.DATABASE_URL

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
const fakeModule = new URL('../../../infra/dev/billing-verify/fake-yookassa.mjs', import.meta.url)

const SHOP = { shopId: '123456', secretKey: 'test_synthetic-key' }

describe.skipIf(!databaseUrl)('checkout against the fake ЮKassa', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  let fake: FakeYookassa
  let receiver: Server
  let shop: YookassaClient
  let deps: BillingDeps
  /** What the stand-in for the notification route answered, in order. */
  let answers: number[] = []

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
    // The route of web in small: the body only names the payment, which is then read back.
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        void (async () => {
          const event = parseWebhookEvent(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          if (event.event === 'payment.succeeded' || event.event === 'payment.canceled') {
            await settleOrderByPaymentId(deps, { paymentId: event.object.id })
          }
          return 200
        })()
          .catch(() => 500)
          .then((status) => {
            answers.push(status)
            res.writeHead(status).end()
          })
      })
    })
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
    const { port } = receiver.address() as AddressInfo
    const { startFakeYookassa } = (await import(fakeModule.href)) as FakeModule
    fake = await startFakeYookassa({ ...SHOP, webhookUrl: `http://127.0.0.1:${port}/` })
    shop = createYookassaClient({ ...SHOP, baseUrl: fake.apiUrl })
    deps = {
      prisma: db,
      yookassa: shop,
      appUrl: TEST_APP_URL,
      appEnv: 'test',
      autopayments: true,
    }
  })
  afterEach(async () => {
    await control('reset')
    answers = []
    await fixtures.cleanup()
  })
  afterAll(async () => {
    await fake.close()
    await new Promise((resolve) => receiver.close(resolve))
    await db.$disconnect()
  })

  async function control<T = unknown>(command: string, body: object = {}): Promise<T> {
    const response = await fetch(`${fake.controlUrl}/${command}`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`The fake refused «${command}»: ${response.status}`)
    return (await response.json()) as T
  }

  /** The customer on the payment page of the fake: «Оплатить» or «Отказаться». */
  async function onPaymentPage(confirmationUrl: string, action: 'pay' | 'refuse') {
    const response = await fetch(confirmationUrl, {
      method: 'POST',
      body: new URLSearchParams({ action }),
      redirect: 'manual',
    })
    expect(response.status).toBe(303)
    // Every notification the click caused has been answered.
    await fake.settle()
    return response.headers.get('location')
  }

  async function setup() {
    const { userId } = await fixtures.user()
    const plan = await fixtures.plan({ isActive: true })
    return { userId, plan }
  }

  async function workspaceOf(userId: string) {
    const workspace = await findPersonalWorkspace(db, { userId, appEnv: 'test' })
    if (workspace === null) throw new Error('The user has no personal workspace')
    return workspace.id
  }

  it('pays a tariff with consent: the notification alone switches it on', async () => {
    const { userId, plan } = await setup()

    const checkout = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true })
    const order = await db.order.findUniqueOrThrow({ where: { id: checkout.orderId } })
    // The request passed the checks of the fake and carried the key of the order.
    const requests = await (await fetch(`${fake.controlUrl}/requests`)).json()
    expect(requests).toMatchObject([
      {
        method: 'POST',
        path: '/v3/payments',
        idempotenceKey: order.idempotenceKey,
        status: 200,
        body: { capture: true, save_payment_method: true },
      },
    ])
    const cameBackTo = await onPaymentPage(checkout.confirmationUrl, 'pay')

    expect(cameBackTo).toBe(checkoutReturnUrl(TEST_APP_URL, checkout.orderId))
    expect(answers).toEqual([200])
    const workspaceId = await workspaceOf(userId)
    const paid = await db.order.findUniqueOrThrow({ where: { id: checkout.orderId } })
    expect(paid).toMatchObject({ status: 'paid', periodStart: paid.paidAt })
    expect(paid.paidAt).toBeInstanceOf(Date)
    const subscriptions = await db.subscription.findMany({ where: { workspaceId } })
    expect(subscriptions).toHaveLength(1)
    expect(subscriptions[0]).toMatchObject({
      id: paid.subscriptionId,
      status: 'active',
      planId: plan.id,
      periodAnchor: paid.paidAt,
      cancelAtPeriodEnd: false,
      // The fake names a saved method after its payment, as ЮKassa does.
      paymentMethodId: order.yookassaPaymentId,
      paymentMethodType: 'bank_card',
      paymentMethodCardType: 'Mir',
      paymentMethodLast4: '4444',
    })
    expect((await getCreditBalances(db, workspaceId)).tariff).toEqual({
      balance: 30,
      held: 0,
      available: 30,
    })
    // The return page then finds everything done and applies nothing again.
    expect(await syncOrder(deps, { userId, orderId: checkout.orderId })).toMatchObject({
      status: 'paid',
      refundNeeded: false,
      subscription: { autoRenewal: true, paymentMethod: { label: 'Карта «Мир» ••\u00a04444' } },
    })
    expect(await db.creditLedger.count({ where: { orderId: checkout.orderId } })).toBe(1)
  })

  it('pays a tariff when the notification is lost: the return page settles it', async () => {
    const { userId, plan } = await setup()
    await control('webhooks', { enabled: false })

    const checkout = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: false })
    await onPaymentPage(checkout.confirmationUrl, 'pay')

    expect(answers).toEqual([])
    expect(await db.order.findUnique({ where: { id: checkout.orderId } })).toMatchObject({
      status: 'pending',
    })
    expect(await syncOrder(deps, { userId, orderId: checkout.orderId })).toMatchObject({
      status: 'paid',
      subscription: { status: 'active', autoRenewal: false, paymentMethod: null },
    })
    const workspaceId = await workspaceOf(userId)
    expect(await db.subscription.count({ where: { workspaceId } })).toBe(1)
    // The quota of the tariff beside the gift the checkout granted with the workspace.
    expect(await getCreditBalances(db, workspaceId)).toMatchObject({
      tariff: { balance: 30, held: 0, available: 30 },
      gift: GIFT_GRANTED,
      totalAvailable: 65,
    })
  })

  it('applies nothing for a payment that was returned before anybody looked at the order', async () => {
    const { userId, plan } = await setup()
    await control('webhooks', { enabled: false })
    const choice = { userId, planSlug: plan.slug, autoRenew: true }
    const checkout = await startCheckout(deps, choice)
    await onPaymentPage(checkout.confirmationUrl, 'pay')
    const order = await db.order.findUniqueOrThrow({ where: { id: checkout.orderId } })
    const paymentId = order.yookassaPaymentId ?? ''
    // The notification was lost; an operator returns the money, as the ЮKassa cabinet does.
    await shop.createRefund(
      { payment_id: paymentId, amount: { value: order.amount.toFixed(2), currency: 'RUB' } },
      randomUUID(),
    )
    // The shop still calls the payment succeeded.
    expect(await shop.getPayment(paymentId)).toMatchObject({
      status: 'succeeded',
      refunded_amount: { value: '4900.00', currency: 'RUB' },
    })

    expect(await syncOrder(deps, { userId, orderId: checkout.orderId })).toMatchObject({
      status: 'failed',
      failureText: 'Платёж возвращён. Оформите оплату заново.',
      refundNeeded: false,
      subscription: null,
    })
    const workspaceId = await workspaceOf(userId)
    expect(await db.subscription.count({ where: { workspaceId } })).toBe(0)
    // Nothing but the gift of the registration, which the checkout granted with the workspace.
    expect(await getCreditBalances(db, workspaceId)).toEqual(GIFT_ONLY)
    const audit = await db.auditLog.findMany({ where: { workspaceId } })
    expect(audit.map((entry) => entry.action)).toEqual([giftAuditActions.grant])
    // Paying again starts a new order with a page of its own.
    const again = await startCheckout(deps, choice)
    expect(again.orderId).not.toBe(checkout.orderId)
    expect(again.confirmationUrl).not.toBe(checkout.confirmationUrl)
  })

  it('keeps no method of a payment without consent that the shop saved anyway', async () => {
    const { userId, plan } = await setup()
    await control('save-anyway', { enabled: true })

    const checkout = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: false })
    await onPaymentPage(checkout.confirmationUrl, 'pay')

    expect(answers).toEqual([200])
    const payment = await deps.yookassa.getPayment(
      (await db.order.findUniqueOrThrow({ where: { id: checkout.orderId } })).yookassaPaymentId ??
        '',
    )
    expect(payment.payment_method).toMatchObject({ saved: true })
    const workspaceId = await workspaceOf(userId)
    expect(await db.subscription.findFirst({ where: { workspaceId } })).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: true,
      paymentMethodId: null,
      paymentMethodType: null,
      paymentMethodLast4: null,
    })
    const audit = await db.auditLog.findMany({ where: { workspaceId } })
    expect(audit.map((entry) => entry.action).sort()).toEqual([
      giftAuditActions.grant,
      settlementAuditActions.subscriptionStart,
    ])
  })

  it('fails the order of a customer who leaves the payment page', async () => {
    const { userId, plan } = await setup()

    const checkout = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true })
    await onPaymentPage(checkout.confirmationUrl, 'refuse')

    expect(answers).toEqual([200])
    expect(await db.order.findUnique({ where: { id: checkout.orderId } })).toMatchObject({
      status: 'failed',
      failureReason: 'expired_on_confirmation',
    })
    expect(await db.subscription.count({ where: { workspaceId: await workspaceOf(userId) } })).toBe(
      0,
    )
    expect(await syncOrder(deps, { userId, orderId: checkout.orderId })).toMatchObject({
      status: 'failed',
      failureText: 'Время на оплату истекло. Оформите оплату заново.',
    })
  })

  it('applies nothing for a notification that says «paid» about an unpaid payment', async () => {
    const { userId, plan } = await setup()
    const checkout = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true })
    const { yookassaPaymentId } = await db.order.findUniqueOrThrow({
      where: { id: checkout.orderId },
    })

    // A forged body; the API of the fake still says the payment is pending.
    await control('notify', {
      paymentId: yookassaPaymentId,
      event: 'payment.succeeded',
      object: { status: 'succeeded', paid: true },
    })

    expect(answers).toEqual([200])
    expect(await db.order.findUnique({ where: { id: checkout.orderId } })).toMatchObject({
      status: 'pending',
      paidAt: null,
    })
    const workspaceId = await workspaceOf(userId)
    expect(await db.subscription.count({ where: { workspaceId } })).toBe(0)
    expect(await getCreditBalances(db, workspaceId)).toEqual(GIFT_ONLY)
  })

  // ЮKassa has not approved autopayments for the shop yet: it answers 403 `forbidden` to a
  // payment that asks to save its method, and takes one that does not (the fake after a real
  // shop, AnyNote 13.05.2026). YOOKASSA_AUTOPAYMENTS says which of the two shops this is.
  describe('at a shop without approved autopayments', () => {
    beforeEach(() => control('autopayments', { enabled: false }))

    const requestsOf = async () =>
      (await (await fetch(`${fake.controlUrl}/requests`)).json()) as {
        path: string
        status: number
        body: Record<string, unknown>
      }[]

    it('with the switch left on, refuses the customer who agreed to auto-renewal and leaves nothing behind', async () => {
      const { userId, plan } = await setup()

      await expect(
        startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true }),
      ).rejects.toMatchObject({ code: 'BILLING_PAYMENTS_NOT_CONFIGURED', httpStatus: 503 })

      // The refusal of the shop is an answer: asked once, not repeated.
      expect(await requestsOf()).toMatchObject([
        { path: '/v3/payments', status: 403, body: { save_payment_method: true } },
      ])
      const workspaceId = await workspaceOf(userId)
      // No order waits for a payment nobody can make, and nothing was charged or applied.
      expect(await db.order.findMany({ where: { workspaceId } })).toMatchObject([
        {
          status: 'failed',
          failureReason: orderFailureReasons.checkoutRejected,
          yookassaPaymentId: null,
          paidAt: null,
        },
      ])
      expect(await db.subscription.count({ where: { workspaceId } })).toBe(0)
      expect(await getCreditBalances(db, workspaceId)).toEqual(GIFT_ONLY)
      expect(answers).toEqual([])

      // The same customer then pays without the consent: an explicit `false` goes through.
      const checkout = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: false })
      await onPaymentPage(checkout.confirmationUrl, 'pay')

      expect(answers).toEqual([200])
      expect((await requestsOf()).filter(({ path }) => path === '/v3/payments')).toMatchObject([
        { status: 403 },
        { status: 200, body: { save_payment_method: false } },
      ])
      expect(await syncOrder(deps, { userId, orderId: checkout.orderId })).toMatchObject({
        status: 'paid',
        subscription: { status: 'active', autoRenewal: false, paymentMethod: null },
      })
      expect(await getCreditBalances(db, workspaceId)).toMatchObject({
        tariff: { balance: 30, held: 0, available: 30 },
        gift: GIFT_GRANTED,
        totalAvailable: 65,
      })
      expect(await db.order.count({ where: { workspaceId, status: 'pending' } })).toBe(0)
    })

    it('with the switch off, asks the shop for nothing it refuses: the field is left out and the tariff is sold', async () => {
      const { userId, plan } = await setup()
      const oneTimeOnly = { ...deps, autopayments: false }

      // The consent is refused by the platform itself: the shop is not asked.
      await expect(
        startCheckout(oneTimeOnly, { userId, planSlug: plan.slug, autoRenew: true }),
      ).rejects.toMatchObject({ code: 'BILLING_AUTO_RENEWAL_UNAVAILABLE', httpStatus: 409 })
      expect(await requestsOf()).toEqual([])

      const checkout = await startCheckout(oneTimeOnly, {
        userId,
        planSlug: plan.slug,
        autoRenew: false,
      })
      const [request, ...others] = await requestsOf()
      expect(others).toEqual([])
      expect(request).toMatchObject({ path: '/v3/payments', status: 200 })
      // The form a real shop without the approval accepted.
      expect(request?.body).not.toHaveProperty('save_payment_method')
      await onPaymentPage(checkout.confirmationUrl, 'pay')

      expect(answers).toEqual([200])
      const workspaceId = await workspaceOf(userId)
      expect(await db.subscription.findFirst({ where: { workspaceId } })).toMatchObject({
        status: 'active',
        cancelAtPeriodEnd: true,
        paymentMethodId: null,
      })
      expect(await db.order.findMany({ where: { workspaceId } })).toMatchObject([
        { id: checkout.orderId, status: 'paid', savePaymentMethod: false },
      ])
    })
  })
})
