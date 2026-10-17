// Scenarios of the renewal charge the scheduler of core makes: the notice and the charge, a
// declined charge, a lost answer, a charge that hangs, the charge that waits for its notice, a
// period that ends by itself, two processes at once, a change of tariff.
import {
  DAY,
  HOUR,
  MINUTE,
  MIR,
  PRICE,
  CREDITS,
  VISA,
  VISA_CARD,
  accountsOf,
  actionsOf,
  auditOf,
  fromNow,
  giftGrant,
  iso,
  journal,
  journalRow,
  journalsOf,
  ledgerHolds,
  madeAt,
  notYet,
  noticed,
  noticesOf,
  orderBecomes,
  orderById,
  orderByKey,
  orderIsOld,
  orderSeen,
  ordersOf,
  outboxOf,
  packBought,
  packIntact,
  periodAfter,
  periodEnded,
  periodEndsAt,
  subscribed,
  subscriptionOf,
} from './scenario-kit.mjs'
import { PAST_DUE_DAYS, moscowMonthLater } from './stand.mjs'

export const scenarios = {}

scenarios['renewal-success'] = async (t) => {
  const { customer, workspaceId, subscription, order: first } = await subscribed(t)
  // Purchased credits are on the account when the tariff is renewed: they outlive the renewal.
  const pack = await packBought(t, customer)

  // Two days before the end of the period: the notice goes out, nothing is charged.
  const ahead = await periodEndsAt(t, subscription.id, fromNow(2 * DAY))
  await noticed(
    t,
    'two days before the end the notice of the charge is recorded',
    workspaceId,
    ahead.end,
    {
      planSlug: 'start',
      amount: PRICE.start,
    },
  )
  await t.until('the customer gets the letter «Скоро спишем 4 900 ₽ за тариф «Старт»»', async () =>
    customer.got('Скоро спишем 4 900 ₽ за тариф «Старт»'),
  )
  await t.passes(['notices', 'charges'])
  t.equal(
    'nothing is charged before the period ends, and the notice is not repeated',
    [
      (await ordersOf(t, workspaceId)).map(({ kind }) => kind),
      (await t.shop.charges()).length,
      (await noticesOf(t, workspaceId)).length,
    ],
    [['subscription', 'pack'], 0, 1],
  )

  // The period ends.
  const ended = await periodEnded(t, subscription.id)
  const renewal = await orderBecomes(
    t,
    'when the period ends the renewal order is made and paid',
    () => orderByKey(t, ended.key),
    'paid',
  )
  const charges = await t.shop.charges()
  t.equal(
    'the saved method was charged once, under the key of the period',
    charges.map(({ idempotenceKey, status, replayed, body }) => ({
      idempotenceKey,
      status,
      replayed,
      amount: body.amount,
      method: body.payment_method_id,
      description: body.description,
      receipt: body.receipt,
      metadata: body.metadata,
    })),
    [
      {
        idempotenceKey: ended.key,
        status: 200,
        replayed: undefined,
        amount: { value: PRICE.start, currency: 'RUB' },
        method: subscription.payment_method_id,
        description: 'Радити: продление тарифа «Старт»',
        receipt: undefined,
        metadata: {
          order_id: renewal.id,
          workspace_id: workspaceId,
          subscription_id: subscription.id,
        },
      },
    ],
  )
  const notices = await noticesOf(t, workspaceId)
  t.equal(
    'the last notice before the charge named exactly what was charged',
    [notices.at(-1).meta, madeAt(notices.at(-1).id) <= madeAt(renewal.id)],
    [{ planSlug: 'start', amount: renewal.amount, chargeAt: iso(ended.end) }, true],
  )
  const moved = await subscriptionOf(t, workspaceId)
  t.equal(
    'the period moved once: from the end of the last one, a month by the anchor',
    {
      status: moved.status,
      plan: moved.plan,
      anchor: iso(moved.period_anchor),
      period: { start: iso(moved.current_period_start), end: iso(moved.current_period_end) },
      notice: moved.renewal_notice_period_end,
    },
    {
      status: 'active',
      plan: 'start',
      anchor: iso(ended.anchor),
      period: periodAfter(ended),
      notice: null,
    },
  )
  t.equal(
    'the renewal order belongs to the owner and pays for the new period',
    {
      user: renewal.user_id,
      kind: renewal.kind,
      amount: renewal.amount,
      subscription: renewal.subscription_id,
      save: renewal.save_payment_method,
      period: { start: iso(renewal.period_start), end: iso(renewal.period_end) },
    },
    {
      user: customer.id,
      kind: 'subscription',
      amount: PRICE.start,
      subscription: subscription.id,
      save: false,
      period: periodAfter(ended),
    },
  )
  const accounts = await packIntact(t, workspaceId, pack, CREDITS.start)
  t.equal(
    'the rest of the old quota expired and the new one was granted, each once',
    journal(accounts.credit_tariff),
    [
      { kind: 'grant', amount: '300.00', key: `order:${first.id}:grant` },
      {
        kind: 'expire',
        amount: '-300.00',
        key: `sub:${subscription.id}:${ended.end.getTime()}:expire`,
      },
      { kind: 'grant', amount: '300.00', key: `order:${renewal.id}:grant` },
    ],
  )
  // The rule of a renewal on the three accounts (the expiry rules of the credits design):
  // only the tariff moves — the gift and the pack are not touched by a period.
  t.equal(
    'a renewal: of the three accounts only the tariff moved — the gift and the pack are the one grant each',
    await journalsOf(t, workspaceId),
    {
      tariff: [
        journalRow.quota(first),
        journalRow.expired(subscription, ended.end),
        journalRow.quota(renewal),
      ],
      gift: [giftGrant(customer.id)],
      pack: [journalRow.pack(pack)],
    },
  )
  const renewalLetter = (await customer.mail('billing.payment_succeeded')).at(-1)
  t.check(
    'the letter of the renewal names the credits of the new period: «Начислили 300 кредитов на этот период.»',
    renewalLetter.key.endsWith(`:${renewal.id}`) &&
      renewalLetter.data.credits === 300 &&
      renewalLetter.text.includes('Начислили 300 кредитов на этот период.'),
    renewalLetter,
  )
  const [renewed] = await auditOf(t, workspaceId, 'billing.subscription.renew')
  t.equal('the audit holds the renewal', renewed.meta, {
    orderId: renewal.id,
    planSlug: 'start',
    planChanged: false,
    amount: PRICE.start,
    credits: 300,
    expiredCredits: 300,
    periodStart: periodAfter(ended).start,
    periodEnd: periodAfter(ended).end,
    reanchored: false,
    notified: true,
  })
  await t.until(
    'the customer gets the letter «Оплата прошла» of the renewal — the third after the tariff and the pack',
    async () => customer.got('Оплата прошла', 3),
  )
  await t.until('and the notice of the charge made today', async () =>
    customer.got('Списание 4 900 ₽ за тариф «Старт»'),
  )
  const overview = await customer.query('billing.overview')
  t.equal(
    '«Тарифы» shows the new period, the fresh quota, the hundred purchased credits and the same card',
    [
      overview.subscription.period,
      overview.subscription.paymentMethod,
      overview.credits.tariff,
      overview.credits.pack,
      overview.renewalCharge,
    ],
    [
      periodAfter(ended),
      { label: MIR },
      { balance: 300, held: 0, available: 300 },
      { balance: 100, held: 0, available: 100 },
      'none',
    ],
  )
  const history = await customer.query('billing.payments', {})
  t.equal(
    '«Оплата» lists both payments of the tariff, the renewal first, and the pack between them',
    history.items.map(({ id, status, amount, period }) => ({ id, status, amount, period })),
    [
      { id: renewal.id, status: 'paid', amount: PRICE.start, period: periodAfter(ended) },
      { id: pack.id, status: 'paid', amount: PRICE.pack, period: null },
      // The period that ended: time passed for the first order together with its subscription.
      {
        id: first.id,
        status: 'paid',
        amount: PRICE.start,
        period: { start: iso(ended.start), end: iso(ended.end) },
      },
    ],
  )

  await t.shop.settle()
  t.equal(
    'the notification of the charge, which may outrun the answer core got, found the order too',
    [
      await t.shop.deliveries(renewal.yookassa_payment_id),
      t.webLog().includes(`payment.succeeded for ${renewal.yookassa_payment_id}: order paid`),
    ],
    [[{ event: 'payment.succeeded', status: 200 }], true],
  )
  await t.passes(['notices', 'charges', 'stuck_orders', 'period_ends'])
  t.equal(
    'further ticks charge nothing more for the period',
    [(await t.shop.charges()).length, (await ordersOf(t, workspaceId)).length],
    [1, 3],
  )
  await packIntact(t, workspaceId, pack, CREDITS.start, 'after further ticks: ')
}

scenarios['renewal-declined'] = async (t) => {
  const { customer, workspaceId, subscription, order: first } = await subscribed(t)
  // Bought while the tariff is paid for (an overdue one sells none): the purchased credits must
  // outlive the debt and the payment by hand that ends it.
  const pack = await packBought(t, customer)
  await t.shop.control('behaviour', {
    target: 'saved',
    behaviour: 'cancel',
    reason: 'insufficient_funds',
    party: 'yoo_money',
  })
  const ended = await periodEnded(t, subscription.id)
  const declined = await orderBecomes(
    t,
    'the bank declines the charge: the renewal order fails',
    () => orderByKey(t, ended.key),
    'failed',
  )
  const overdue = await subscriptionOf(t, workspaceId)
  t.equal(
    'the order keeps the reason of the bank; the tariff is past due in the period that ended',
    {
      reason: declined.failure_reason,
      payment: declined.yookassa_payment_id !== null,
      status: overdue.status,
      since: overdue.past_due_since !== null,
      end: iso(overdue.current_period_end),
      method: overdue.payment_method_id,
    },
    {
      reason: 'insufficient_funds',
      payment: true,
      status: 'past_due',
      since: true,
      end: iso(ended.end),
      method: subscription.payment_method_id,
    },
  )
  const [entry] = await auditOf(t, workspaceId, 'billing.subscription.past_due')
  t.equal(
    'the audit holds the failed charge',
    {
      order: entry.meta.orderId,
      reason: entry.meta.reason,
      amount: entry.meta.amount,
      notified: entry.meta.notified,
    },
    { order: declined.id, reason: 'insufficient_funds', amount: PRICE.start, notified: true },
  )
  await t.until('the customer gets the letter «Оплата не прошла»', async () =>
    customer.got('Оплата не прошла'),
  )
  t.equal(
    'the letter is written once, under the key of the order',
    await outboxOf(t, 'billing.payment_failed', declined.id),
    ['published'],
  )
  let overview = await customer.query('billing.overview')
  t.equal(
    '«Тарифы» shows the tariff as overdue and the day it ends unless paid: seven days later',
    [
      overview.subscription.status,
      overview.subscription.pastDueSince,
      overview.pastDueEndsAt,
      overview.renewalCharge,
    ],
    [
      'past_due',
      iso(overdue.past_due_since),
      iso(new Date(overdue.past_due_since.getTime() + PAST_DUE_DAYS * DAY)),
      'none',
    ],
  )
  let history = await customer.query('billing.payments', {})
  t.equal(
    '«Оплата» shows the failed payment with a sentence for the customer',
    [
      history.items[0].id,
      history.items[0].status,
      history.items[0].failureReason,
      history.items[0].failureText,
    ],
    [
      declined.id,
      'failed',
      'insufficient_funds',
      'Недостаточно средств. Пополните счёт или выберите другой способ оплаты.',
    ],
  )
  t.equal(
    'a pack is not sold while the tariff is overdue, and auto-renewal cannot be switched meanwhile',
    [
      await customer.refusal('billing.startPackCheckout', {}),
      await customer.refusal('billing.resumeAutoRenew', {}),
    ],
    [
      { status: 409, code: 'BILLING_PACK_NEEDS_SUBSCRIPTION' },
      { status: 409, code: 'BILLING_SUBSCRIPTION_PAST_DUE' },
    ],
  )
  await t.passes(['notices', 'charges', 'stuck_orders', 'period_ends'])
  t.equal(
    'the declined charge is not repeated: one request, one renewal order, still past due',
    [
      (await t.shop.charges()).length,
      (await ordersOf(t, workspaceId)).map(({ kind, status }) => `${kind} ${status}`),
      (await subscriptionOf(t, workspaceId)).status,
    ],
    [1, ['subscription paid', 'pack paid', 'subscription failed'], 'past_due'],
  )
  await packIntact(t, workspaceId, pack, CREDITS.start, 'while overdue nothing expires: ')
  overview = await customer.query('billing.overview')
  t.equal(
    'while overdue a task could spend the gift alone: 35 credits; the quota and the pack wait for the payment',
    [overview.credits.spendable, overview.credits.tariff.balance, overview.credits.pack.balance],
    [35, 300, 100],
  )

  // «Оплатить сейчас»: the customer pays by hand, with another card.
  await t.shop.control('card', VISA_CARD)
  const checkout = await customer.mutate('billing.startPastDuePayment', {})
  const created = (await t.shop.sent('POST', '/v3/payments')).at(-1)
  t.equal(
    'the payment by hand is for the tariff at its price and saves the method: auto-renewal is on',
    [created.body.amount.value, created.body.save_payment_method, created.body.payment_method_id],
    [PRICE.start, true, undefined],
  )
  await t.shop.press(checkout.confirmationUrl)
  const paid = await orderBecomes(
    t,
    'the order of the payment by hand is paid',
    () => orderById(t, checkout.orderId),
    'paid',
  )
  const active = await subscriptionOf(t, workspaceId)
  t.equal(
    'the tariff is active for a month from the payment, which is the new anchor',
    {
      status: active.status,
      since: active.past_due_since,
      start: iso(active.current_period_start),
      end: iso(active.current_period_end),
      order: [iso(paid.period_start), iso(paid.period_end)],
      card: [
        active.payment_method_id,
        active.payment_method_card_type,
        active.payment_method_last4,
      ],
      off: active.cancel_at_period_end,
    },
    {
      status: 'active',
      since: null,
      start: iso(active.period_anchor),
      end: iso(moscowMonthLater(active.period_anchor, active.period_anchor)),
      order: [iso(active.current_period_start), iso(active.current_period_end)],
      card: [paid.yookassa_payment_id, 'Visa', '1234'],
      off: false,
    },
  )
  t.check(
    'the new period is counted from the payment, not from the period that ended',
    Math.abs(active.period_anchor.getTime() - Date.now()) < MINUTE,
    active,
  )
  const accounts = await packIntact(t, workspaceId, pack, CREDITS.start, 'paid by hand: ')
  t.equal(
    'the rest of the overdue period expired and the quota was granted anew',
    journal(accounts.credit_tariff),
    [
      { kind: 'grant', amount: '300.00', key: `order:${first.id}:grant` },
      {
        kind: 'expire',
        amount: '-300.00',
        key: `sub:${subscription.id}:${ended.end.getTime()}:expire`,
      },
      { kind: 'grant', amount: '300.00', key: `order:${paid.id}:grant` },
    ],
  )
  // The rule of a payment while overdue on the three accounts: as a renewal, only the tariff.
  t.equal(
    'a payment while overdue: of the three accounts only the tariff moved — the gift and the pack are the one grant each',
    await journalsOf(t, workspaceId),
    {
      tariff: [
        journalRow.quota(first),
        journalRow.expired(subscription, ended.end),
        journalRow.quota(paid),
      ],
      gift: [giftGrant(customer.id)],
      pack: [journalRow.pack(pack)],
    },
  )
  const [reactivated] = await auditOf(t, workspaceId, 'billing.subscription.reactivate')
  t.equal(
    'the audit holds the payment by hand as the customer’s own act',
    reactivated.actor_type,
    'user',
  )
  overview = await customer.query('billing.overview')
  t.equal(
    '«Тарифы» shows the tariff active again, with the new card',
    [overview.subscription.status, overview.subscription.paymentMethod, overview.pastDueEndsAt],
    ['active', { label: VISA }, null],
  )
  history = await customer.query('billing.payments', {})
  t.equal(
    '«Оплата» lists four orders: paid by hand, declined, the pack, the first payment',
    history.items.map(({ kind, status }) => `${kind} ${status}`),
    ['subscription paid', 'subscription failed', 'pack paid', 'subscription paid'],
  )
  t.equal(
    'nothing is owed any more: a second payment by hand is refused',
    await customer.refusal('billing.startPastDuePayment', {}),
    { status: 409, code: 'BILLING_NOTHING_TO_CHANGE' },
  )

  // Not the bank but the shop refuses: it no longer knows the saved method (here it forgets
  // everything), and answers the charge request itself with 400.
  const other = await subscribed(t)
  await t.shop.settle()
  await t.shop.control('reset', {})
  const otherEnded = await periodEnded(t, other.subscription.id)
  const rejected = await orderBecomes(
    t,
    'the shop refuses the charge request itself: the renewal order fails at once',
    () => orderByKey(t, otherEnded.key),
    'failed',
  )
  const [refusal] = await auditOf(t, other.workspaceId, 'billing.subscription.past_due')
  t.equal(
    'no payment was made; the tariff is past due and the audit keeps the answer of the shop',
    [
      rejected.failure_reason,
      rejected.yookassa_payment_id,
      (await subscriptionOf(t, other.workspaceId)).status,
      [refusal.meta.reason, refusal.meta.shopStatus, refusal.meta.notified],
      (await t.shop.state()).payments.length,
    ],
    ['charge_rejected', null, 'past_due', ['charge_rejected', 400, true], 0],
  )
  await t.until('that customer gets the letter «Оплата не прошла» as well', async () =>
    other.customer.got('Оплата не прошла'),
  )
  const refused = (await other.customer.query('billing.payments', {})).items.find(
    ({ id }) => id === rejected.id,
  )
  t.equal(
    '«Оплата» tells the customer to pay the tariff',
    [refused?.status, refused?.failureText],
    ['failed', 'Не получилось списать оплату. Оплатите тариф.'],
  )
  await t.passes(['notices', 'charges', 'stuck_orders'])
  t.equal(
    'the refused request is not repeated',
    (await t.shop.charges()).map(({ idempotenceKey, status }) => [idempotenceKey, status]),
    [[otherEnded.key, 400]],
  )
}

scenarios['renewal-http-500'] = async (t) => {
  // The repeat is what this part shows, so no notification may settle the payment first.
  await t.shop.hold()
  const { customer, workspaceId, subscription } = await subscribed(t)
  // The shop makes the payment and answers 500: the money is taken, core does not know.
  await t.shop.control('behaviour', { target: 'saved', behaviour: 'http-500-once' })
  const ended = await periodEnded(t, subscription.id)
  await t.until('the charge is sent and the shop answers 500', async () =>
    (await t.shop.charges()).some(
      ({ idempotenceKey, status }) => idempotenceKey === ended.key && status === 500,
    ),
  )
  const pending = await orderBecomes(
    t,
    'the renewal order stays unfinished, without a payment',
    () => orderByKey(t, ended.key),
    'pending',
  )
  const taken = (await t.shop.state()).payments.filter(
    (payment) => payment.metadata?.order_id === pending.id,
  )
  t.equal(
    'the shop holds one succeeded payment of the order, which the order does not know',
    [taken.map(({ status }) => status), pending.yookassa_payment_id],
    [['succeeded'], null],
  )
  t.equal(
    '«Тарифы» says the charge is on its way without an answer',
    (await customer.query('billing.overview')).renewalCharge,
    'unanswered',
  )
  await t.passes(['charges', 'stuck_orders', 'period_ends'])
  t.equal(
    'for five minutes nothing is repeated, charged again or ended',
    [(await t.shop.charges()).length, (await subscriptionOf(t, workspaceId)).status],
    [1, 'active'],
  )

  await orderIsOld(t, pending.id, 6 * MINUTE)
  const renewal = await orderBecomes(
    t,
    'six minutes later the pass of stuck orders repeats the charge and the order is paid',
    () => orderByKey(t, ended.key),
    'paid',
  )
  t.equal(
    'the repeat went under the same key with the same body and got the first payment back',
    (await t.shop.charges()).map(({ idempotenceKey, status, replayed, sameRequest }) => ({
      idempotenceKey,
      status,
      replayed,
      sameRequest,
    })),
    [
      { idempotenceKey: ended.key, status: 500, replayed: undefined, sameRequest: undefined },
      { idempotenceKey: ended.key, status: 200, replayed: true, sameRequest: true },
    ],
  )
  t.equal(
    'no second payment was made: the shop still holds one, and the order now names it',
    [
      (await t.shop.state()).payments.filter((payment) => payment.metadata?.order_id === renewal.id)
        .length,
      renewal.yookassa_payment_id,
    ],
    [1, taken[0].id],
  )
  const moved = await subscriptionOf(t, workspaceId)
  t.equal(
    'the period moved once',
    [moved.status, { start: iso(moved.current_period_start), end: iso(moved.current_period_end) }],
    ['active', periodAfter(ended)],
  )
  const accounts = await ledgerHolds(t, workspaceId, { tariff: CREDITS.start, pack: 0 })
  t.equal(
    'the quota of the new period was granted once',
    journal(accounts.credit_tariff).slice(1),
    [
      {
        kind: 'expire',
        amount: '-300.00',
        key: `sub:${subscription.id}:${ended.end.getTime()}:expire`,
      },
      { kind: 'grant', amount: '300.00', key: `order:${renewal.id}:grant` },
    ],
  )
  // The notification that was held arrives late: it finds everything done.
  await t.shop.release()
  const late = await t.shop.control('notify', { paymentId: taken[0].id })
  t.equal('the late notification is answered 200 and changes nothing', late.status, 200)
  await ledgerHolds(
    t,
    workspaceId,
    { tariff: CREDITS.start, pack: 0 },
    'after the late notification ',
  )

  // The same loss with notifications on: the notification finds the order by the payment's own
  // data, attaches the payment and renews the tariff before any repeat is due.
  const other = await subscribed(t)
  await t.shop.control('behaviour', { target: 'saved', behaviour: 'http-500-once' })
  const otherEnded = await periodEnded(t, other.subscription.id)
  const attached = await orderBecomes(
    t,
    'with notifications on, the lost answer is made up for by the notification: the order is paid',
    () => orderByKey(t, otherEnded.key),
    'paid',
  )
  const otherCharges = (await t.shop.charges()).filter(
    ({ idempotenceKey }) => idempotenceKey === otherEnded.key,
  )
  t.equal(
    'one request was enough: the payment was attached to the order by the notification',
    [
      otherCharges.map(({ status }) => status),
      (await auditOf(t, other.workspaceId, 'billing.order.payment_attached')).map(
        ({ actor_type, target_id }) => [actor_type, target_id],
      ),
      attached.yookassa_payment_id !== null,
    ],
    [[500], [['system', attached.id]], true],
  )
  const otherMoved = await subscriptionOf(t, other.workspaceId)
  t.equal(
    'that tariff moved once as well',
    { start: iso(otherMoved.current_period_start), end: iso(otherMoved.current_period_end) },
    periodAfter(otherEnded),
  )
  await ledgerHolds(
    t,
    other.workspaceId,
    { tariff: CREDITS.start, pack: 0 },
    'with notifications on: ',
  )
  await t.passes(['charges', 'stuck_orders'])
  t.equal(
    'and nothing is charged afterwards',
    (await t.shop.charges()).filter(({ idempotenceKey }) => idempotenceKey === otherEnded.key)
      .length,
    1,
  )
}

scenarios['renewal-stuck-pending'] = async (t) => {
  await t.shop.hold()

  // The bank takes its time: the charge is made and has no outcome.
  const slow = await subscribed(t)
  await t.shop.control('behaviour', { target: 'saved', behaviour: 'stay-pending' })
  const ended = await periodEnded(t, slow.subscription.id)
  const hanging = await t.until(
    'the charge hangs at the bank: the order holds a pending payment',
    async () => {
      const order = await orderByKey(t, ended.key)
      return order?.yookassa_payment_id ? order : orderSeen(order)
    },
  )
  t.equal(
    '«Тарифы» says the charge is at the bank',
    [hanging.status, (await slow.customer.query('billing.overview')).renewalCharge],
    ['pending', 'at_bank'],
  )
  await t.passes(['notices', 'charges', 'stuck_orders', 'period_ends'])
  t.equal(
    'while it hangs nothing is charged again and the tariff is neither renewed nor ended',
    [
      (await t.shop.charges()).length,
      (await subscriptionOf(t, slow.workspaceId)).status,
      iso((await subscriptionOf(t, slow.workspaceId)).current_period_end),
    ],
    [1, 'active', iso(ended.end)],
  )
  // The bank says yes; the notification is lost.
  await t.shop.control('complete', { paymentId: hanging.yookassa_payment_id })
  await orderIsOld(t, hanging.id, 6 * MINUTE)
  await orderBecomes(
    t,
    'the bank approves, the notification is lost: the pass of stuck orders reads the payment back',
    () => orderByKey(t, ended.key),
    'paid',
  )
  const moved = await subscriptionOf(t, slow.workspaceId)
  t.equal(
    'the period moved once, and one request was all it took',
    [
      { start: iso(moved.current_period_start), end: iso(moved.current_period_end) },
      (await t.shop.charges()).length,
    ],
    [periodAfter(ended), 1],
  )
  await ledgerHolds(t, slow.workspaceId, { tariff: CREDITS.start, pack: 0 }, 'the slow bank: ')

  // The request never reached the shop, and nobody learns that: after twelve hours the key of
  // the charge is no longer safe to repeat.
  const lost = await subscribed(t)
  await t.shop.control('behaviour', {
    target: 'saved',
    behaviour: 'http-500-once',
    processed: false,
  })
  const lostEnded = await periodEnded(t, lost.subscription.id)
  const unanswered = await t.until(
    'another charge gets a 500 and no payment is made at all',
    async () => {
      const order = await orderByKey(t, lostEnded.key)
      const sent = (await t.shop.charges()).some(
        ({ idempotenceKey }) => idempotenceKey === lostEnded.key,
      )
      return order?.status === 'pending' && sent ? order : orderSeen(order)
    },
  )
  const requestsOfKey = async () =>
    (await t.shop.charges()).filter(({ idempotenceKey }) => idempotenceKey === lostEnded.key).length
  await orderIsOld(t, unanswered.id, 12 * HOUR + MINUTE)
  await t.passes(['stuck_orders', 'charges'])
  t.equal(
    'twelve hours later the charge is not repeated any more, and the order still waits',
    [await requestsOfKey(), (await orderByKey(t, lostEnded.key)).status],
    [1, 'pending'],
  )
  await orderIsOld(t, unanswered.id, 12 * HOUR + 6 * MINUTE)
  const givenUp = await orderBecomes(
    t,
    'five minutes after that the order is given up',
    () => orderByKey(t, lostEnded.key),
    'failed',
  )
  const overdue = await subscriptionOf(t, lost.workspaceId)
  t.equal(
    'nobody can tell what became of the charge: the tariff is past due, no request was repeated',
    [givenUp.failure_reason, givenUp.yookassa_payment_id, overdue.status, await requestsOfKey()],
    ['unknown_result', null, 'past_due', 1],
  )
  t.equal(
    'the audit asks an operator to look, and the customer is not told that the charge failed',
    [
      (await auditOf(t, lost.workspaceId, 'billing.renewal.unknown_result')).length,
      (await auditOf(t, lost.workspaceId, 'billing.subscription.past_due')).map(
        ({ meta }) => meta.notified,
      ),
      await outboxOf(t, 'billing.payment_failed', givenUp.id),
    ],
    [1, [false], []],
  )
  const history = await lost.customer.query('billing.payments', {})
  const shown = history.items.find(({ id }) => id === givenUp.id)
  t.equal(
    '«Оплата» tells the customer what to do if the money was taken',
    [shown?.status, shown?.failureText],
    [
      'failed',
      'Не удалось подтвердить списание. Если деньги списаны, напишите нам — мы разберёмся.',
    ],
  )

  // The operator's list names the charge; the cabinet of the shop holds no payment of it.
  const listed = await t.operator('billing-refunds-needed', [])
  t.check(
    'billing:refunds-needed lists the order under «Списания без ответа» with the key to look for',
    listed.code === 0 &&
      listed.stdout.includes('Списания без ответа: 1.') &&
      listed.stdout.includes(`заказ ${givenUp.id}`) &&
      listed.stdout.includes(`ключ запроса ${lostEnded.key}`),
    listed,
  )
  const who = ['--reason', 'Проверка стенда: платежа в кабинете нет', '--operator', 'stand']
  const closed = await t.operator('billing-settle-payment', [
    '--order',
    givenUp.id,
    '--not-found',
    ...who,
  ])
  t.check(
    'billing:settle-payment --not-found closes the entry',
    closed.code === 0 &&
      closed.stdout.includes(
        `Запись закрыта: заказ ${givenUp.id} больше не показывается в billing:refunds-needed.`,
      ),
    closed,
  )
  const again = await t.operator('billing-settle-payment', [
    '--order',
    givenUp.id,
    '--not-found',
    ...who,
  ])
  const after = await t.operator('billing-refunds-needed', [])
  t.check(
    'a second run changes nothing, and the list is empty again',
    again.code === 0 &&
      again.stdout.includes('уже была закрыта раньше: ничего не изменено.') &&
      !after.stdout.includes('Списания без ответа') &&
      (await auditOf(t, lost.workspaceId, 'billing.renewal.unknown_result_checked')).length === 1,
    { again, after },
  )
}

/**
 * «Письмо раньше списания» as a rule of the charge, not as the order of two passes within a
 * tick: while core runs no notices pass at all, a period that has ended is not charged.
 */
scenarios['renewal-waits-for-notice'] = async (t) => {
  const { customer, workspaceId, subscription } = await subscribed(t)
  // The period ends a month from now: no notice of it has been written yet.
  t.equal(
    'before the period ends nobody has been told of a charge',
    [(await noticesOf(t, workspaceId)).length, subscription.renewal_notice_period_end],
    [0, null],
  )
  const ended = await t.withoutPass('notices', async () => {
    const dates = await periodEnded(t, subscription.id)
    await t.passes(['charges', 'stuck_orders', 'period_ends'])
    const waiting = await subscriptionOf(t, workspaceId)
    t.equal(
      'while no notice can be written nothing is charged: no order, no request to the shop, the tariff waits',
      {
        order: await orderByKey(t, dates.key),
        charges: (await t.shop.charges()).length,
        notices: (await noticesOf(t, workspaceId)).length,
        tariff: [waiting.status, iso(waiting.current_period_end)],
      },
      { order: null, charges: 0, notices: 0, tariff: ['active', iso(dates.end)] },
    )
    return dates
  })
  const renewal = await orderBecomes(
    t,
    'once notices are written again the charge follows its notice: the renewal is paid',
    () => orderByKey(t, ended.key),
    'paid',
  )
  const notices = await noticesOf(t, workspaceId)
  t.equal(
    'one notice was written, before the order of the charge, and it names what was charged',
    [notices.map(({ meta }) => meta), madeAt(notices[0]?.id ?? renewal.id) <= madeAt(renewal.id)],
    [[{ planSlug: 'start', amount: renewal.amount, chargeAt: iso(ended.end) }], true],
  )
  t.equal(
    'the shop got one charge, under the key of the period',
    (await t.shop.charges()).map(({ idempotenceKey, status, body }) => [
      idempotenceKey,
      status,
      body.amount.value,
    ]),
    [[ended.key, 200, PRICE.start]],
  )
  await t.until('the customer gets the letter of the charge: one', async () =>
    customer.got('Списание 4 900 ₽ за тариф «Старт»'),
  )
  await ledgerHolds(t, workspaceId, { tariff: CREDITS.start, pack: 0 })
}

/**
 * The way a renewal goes outside the stand: the notice is written ahead of the end of the
 * period, the period ends by the clock, and the charge is made on that notice — no date is
 * edited in between, so nothing strands the notice and makes core write a second one. Next to
 * it, the same with the price of the tariff changed after the notice: the charge is compared
 * with what the last letter said, and the new amount is announced before it is taken.
 */
scenarios['renewal-in-real-time'] = async (t) => {
  /** How far ahead the periods end: time for core to write both notices, seconds over. */
  const LEAD = 8_000
  const RAISED = '13900.00'
  const kept = await subscribed(t)
  const raised = await subscribed(t, { plan: 'business' })
  const dates = await periodEndsAt(t, [kept.subscription.id, raised.subscription.id], fromNow(LEAD))
  const end = dates.end.getTime()
  const keyOf = ({ subscription }) => `renew.${subscription.id}.${end}`
  const first = await noticed(
    t,
    'on time: seconds before the end the notice of the charge is recorded',
    kept.workspaceId,
    dates.end,
    { planSlug: 'start', amount: PRICE.start },
  )
  const old = await noticed(
    t,
    'new price: the notice names 12900.00, the price of «Бизнес» today',
    raised.workspaceId,
    dates.end,
    { planSlug: 'business', amount: PRICE.business },
  )
  let renewal
  let dearer
  try {
    // The price is raised after the letter has gone out.
    await t.rows(`UPDATE plans SET price = $1 WHERE slug = 'business'`, [RAISED])
    // Read first, the clock afterwards: what was read was read while the periods ran.
    const charged = [(await t.shop.charges()).length, await orderByKey(t, keyOf(kept))]
    t.check(
      'both notices were written, and the price raised, while the periods were still running',
      madeAt(first.id) < end && madeAt(old.id) < end && Date.now() < end,
      { end: dates.end, now: new Date() },
    )
    t.equal('nothing was charged while the periods ran', charged, [0, null])
    // Nothing is edited from here on: the periods end by the clock.
    renewal = await orderBecomes(
      t,
      'on time: the period ends by itself and the renewal is paid',
      () => orderByKey(t, keyOf(kept)),
      'paid',
    )
    dearer = await orderBecomes(
      t,
      'new price: the period ends by itself and the renewal is paid',
      () => orderByKey(t, keyOf(raised)),
      'paid',
    )
  } finally {
    await t.rows(`UPDATE plans SET price = $1 WHERE slug = 'business'`, [PRICE.business])
  }

  const keptNotices = await noticesOf(t, kept.workspaceId)
  t.equal(
    'on time: the charge was made on the one notice written ahead: no second letter for the period',
    [keptNotices.map(({ id, meta }) => [id, meta]), renewal.amount, madeAt(renewal.id) >= end],
    [
      [[first.id, { planSlug: 'start', amount: PRICE.start, chargeAt: iso(dates.end) }]],
      PRICE.start,
      true,
    ],
  )
  // Written ahead; «Скоро спишем …» unless the mailer got to it only after the end.
  const about = (customer, amount, plan) =>
    customer.letters(`Скоро спишем ${amount} ₽ за тариф «${plan}»`).length +
    customer.letters(`Списание ${amount} ₽ за тариф «${plan}»`).length
  await t.until(
    'on time: the customer got one letter about the charge',
    async () => about(kept.customer, '4 900', 'Старт') === 1 || notYet(kept.customer.subjects()),
  )
  const moved = await subscriptionOf(t, kept.workspaceId)
  t.equal(
    'on time: the period moved once, a month by the anchor',
    [moved.status, { start: iso(moved.current_period_start), end: iso(moved.current_period_end) }],
    ['active', periodAfter(dates)],
  )
  await ledgerHolds(t, kept.workspaceId, { tariff: CREDITS.start, pack: 0 }, 'on time: ')

  const raisedNotices = await noticesOf(t, raised.workspaceId)
  t.equal(
    'new price: nobody is charged an amount no letter named — a second notice names 13900.00 before the charge',
    {
      notices: raisedNotices.map(({ meta }) => `${meta.planSlug} ${meta.amount}`),
      chargeAt: raisedNotices.map(({ meta }) => meta.chargeAt),
      order: [dearer.amount, dearer.plan],
      announcedFirst: madeAt(raisedNotices.at(-1).id) <= madeAt(dearer.id),
    },
    {
      notices: [`business ${PRICE.business}`, `business ${RAISED}`],
      chargeAt: [iso(dates.end), iso(dates.end)],
      order: [RAISED, 'business'],
      announcedFirst: true,
    },
  )
  t.equal(
    'new price: the shop was asked for 13900.00, once; the other charge is 4900.00',
    (await t.shop.charges())
      .map(({ idempotenceKey, status, body }) => [idempotenceKey, status, body.amount.value])
      .sort(),
    [
      [keyOf(kept), 200, PRICE.start],
      [keyOf(raised), 200, RAISED],
    ].sort(),
  )
  await t.until(
    'new price: the customer gets the letter «Списание 13 900 ₽ за тариф «Бизнес»»',
    () => raised.customer.got('Списание 13 900 ₽ за тариф «Бизнес»'),
  )
  t.equal(
    'new price: the letter about 12 900 ₽ was the only one before it',
    about(raised.customer, '12 900', 'Бизнес'),
    1,
  )
  await ledgerHolds(t, raised.workspaceId, { tariff: CREDITS.business, pack: 0 }, 'new price: ')
  t.equal(
    'the price list is as it was seeded again',
    (await t.one(`SELECT price::text AS price FROM plans WHERE slug = 'business'`)).price,
    PRICE.business,
  )
}

scenarios['two-ticks'] = async (t) => {
  const TARIFFS = 5
  const tariffs = []
  for (let n = 0; n < TARIFFS; n += 1) tariffs.push(await subscribed(t))
  const ids = tariffs.map(({ subscription }) => subscription.id)

  // A second core process: the same schedulers on the same database and Redis. A tick still
  // makes one job per pass, and a worker runs one pass at a time — so while one process is
  // busy with a pass, the next tick's pass of the same kind runs in the other.
  const second = await t.secondCore()
  try {
    const cores = [t.coreUrl, second.url]
    // A slow bank keeps a pass busy for seconds; with notifications held only the passes settle.
    await t.shop.hold()
    await t.shop.control('behaviour', {
      target: 'saved',
      behaviour: 'succeed',
      delayMs: 700,
      times: TARIFFS,
    })
    const before = await Promise.all(cores.map((origin) => t.passCounts(origin, 'charges')))
    // Every period ends in the same instant.
    const dates = await periodEndsAt(t, ids, fromNow(-MINUTE))
    const keys = ids.map((id) => `renew.${id}.${dates.end.getTime()}`)
    await t.until(
      `the renewal orders of all ${TARIFFS} tariffs are paid`,
      async () => {
        const orders = await t.rows(
          `SELECT idempotence_key AS key, status::text AS status, failure_reason FROM orders
           WHERE idempotence_key = ANY($1::text[]) ORDER BY idempotence_key`,
          [keys],
        )
        return (
          (orders.length === TARIFFS && orders.every(({ status }) => status === 'paid')) ||
          notYet(orders)
        )
      },
      { timeoutMs: 60_000 },
    )
    // A process counts the rows of a pass when the pass has returned, a moment after its last
    // order is paid: the counters are waited for, not read once.
    const after = await t.until(
      'both processes have counted the rows of their passes',
      async () => {
        const now = await Promise.all(cores.map((origin) => t.passCounts(origin, 'charges')))
        const renewed = now.map((counts, index) => counts.renewed - before[index].renewed)
        return renewed.reduce((sum, rows) => sum + rows, 0) === TARIFFS ? now : notYet({ renewed })
      },
      { silent: true },
    )
    const [first, other] = after.map((counts, index) =>
      Object.fromEntries(
        Object.entries(counts).map(([outcome, rows]) => [outcome, rows - before[index][outcome]]),
      ),
    )
    t.equal(
      'every tariff was renewed by exactly one pass of one process',
      first.renewed + other.renewed,
      TARIFFS,
    )
    t.check(
      'both processes charged tariffs: their passes ran at the same time',
      first.renewed >= 1 && other.renewed >= 1,
      { first, other },
    )
    t.check(
      'and they met: a pass found a tariff the other one was already charging and passed it by',
      first.skipped + other.skipped + first.blocked + other.blocked >= 1,
      { first, other },
    )
    const charges = await t.shop.charges()
    t.equal(
      'the shop got one charge per tariff, each under the key of its period, none repeated',
      [
        charges.map(({ idempotenceKey }) => idempotenceKey).sort(),
        charges.filter(({ replayed }) => replayed).length,
        charges.map(({ status }) => status).filter((status) => status !== 200),
      ],
      [[...keys].sort(), 0, []],
    )
    const { payments } = await t.shop.state()
    for (const [index, { workspaceId, subscription, order }] of tariffs.entries()) {
      const orders = await ordersOf(t, workspaceId)
      const moved = await subscriptionOf(t, workspaceId)
      const accounts = await accountsOf(t, workspaceId)
      t.equal(
        `tariff ${index + 1}: one renewal order, one payment at the shop, the period moved once, the quota granted once`,
        {
          orders: orders.map(({ idempotence_key: key, status }) => [key === keys[index], status]),
          payments: payments.filter(({ metadata }) => metadata?.order_id === orders[1]?.id).length,
          period: { start: iso(moved.current_period_start), end: iso(moved.current_period_end) },
          journal: journal(accounts.credit_tariff),
        },
        {
          orders: [
            [false, 'paid'],
            [true, 'paid'],
          ],
          payments: 1,
          period: periodAfter(dates),
          journal: [
            { kind: 'grant', amount: '300.00', key: `order:${order.id}:grant` },
            {
              kind: 'expire',
              amount: '-300.00',
              key: `sub:${subscription.id}:${dates.end.getTime()}:expire`,
            },
            { kind: 'grant', amount: '300.00', key: `order:${orders[1]?.id}:grant` },
          ],
        },
      )
    }
    await t.passes(['charges', 'stuck_orders'])
    t.equal(
      'later ticks of both processes charge nothing more',
      (await t.shop.charges()).length,
      TARIFFS,
    )
  } finally {
    await second.stop()
  }
}

scenarios['plan-change'] = async (t) => {
  // The change is applied at the renewal.
  const { customer, workspaceId, subscription, order: first } = await subscribed(t)
  // Purchased credits are on the account when the tariff changes: they are of neither tariff.
  const pack = await packBought(t, customer)
  const ahead = await periodEndsAt(t, subscription.id, fromNow(2 * DAY))
  await noticed(t, 'two days before the end the notice names «Старт»', workspaceId, ahead.end, {
    planSlug: 'start',
    amount: PRICE.start,
  })
  const paymentsBefore = (await t.shop.sent('POST', '/v3/payments')).length

  const changed = await customer.mutate('billing.schedulePlanChange', { planSlug: 'business' })
  t.equal(
    'the customer chooses «Бизнес»: today the tariff, its period and its price stay as they were',
    [changed.plan.slug, changed.period.end, changed.nextPlan?.slug, changed.nextPlan?.price],
    ['start', iso(ahead.end), 'business', PRICE.business],
  )
  t.equal(
    'nothing is charged or granted for the choice, and the notice of the old amount no longer stands',
    [
      (await t.shop.sent('POST', '/v3/payments')).length,
      (await customer.query('billing.overview')).credits.tariff.balance,
      (await ordersOf(t, workspaceId)).map(({ kind }) => kind),
    ],
    [paymentsBefore, 300, ['subscription', 'pack']],
  )
  t.equal(
    'the same choice twice, or the tariff the customer has, is refused',
    [
      await customer.refusal('billing.schedulePlanChange', { planSlug: 'business' }),
      await customer.refusal('billing.schedulePlanChange', { planSlug: 'start' }),
    ],
    [
      { status: 409, code: 'BILLING_ALREADY_ON_PLAN' },
      { status: 409, code: 'BILLING_ALREADY_ON_PLAN' },
    ],
  )
  await noticed(
    t,
    'a new notice is written for the same period, now for «Бизнес»',
    workspaceId,
    ahead.end,
    {
      planSlug: 'business',
      amount: PRICE.business,
    },
  )
  await t.until(
    'the customer gets the letter «Скоро спишем 12 900 ₽ за тариф «Бизнес»»',
    async () => customer.got('Скоро спишем 12 900 ₽ за тариф «Бизнес»'),
  )
  await t.passes(['charges'])
  t.equal('nothing is charged before the period ends', (await t.shop.charges()).length, 0)

  const ended = await periodEnded(t, subscription.id)
  const renewal = await orderBecomes(
    t,
    'when the period ends the renewal is paid',
    () => orderByKey(t, ended.key),
    'paid',
  )
  const [charge] = await t.shop.charges()
  const notices = await noticesOf(t, workspaceId)
  t.equal(
    'the charge is the price of «Бизнес», as the last notice before it said',
    [
      renewal.amount,
      renewal.plan,
      charge.body.amount.value,
      charge.body.description,
      notices.at(-1).meta,
      madeAt(notices.at(-1).id) <= madeAt(renewal.id),
    ],
    [
      PRICE.business,
      'business',
      PRICE.business,
      'Радити: продление тарифа «Бизнес»',
      { planSlug: 'business', amount: PRICE.business, chargeAt: iso(ended.end) },
      true,
    ],
  )
  t.equal(
    'no notice ever named an amount other than the price of the tariff it named',
    notices.map(({ meta }) => `${meta.planSlug} ${meta.amount}`),
    ['start 4900.00', 'business 12900.00', 'business 12900.00'],
  )
  const moved = await subscriptionOf(t, workspaceId)
  t.equal(
    'the new tariff starts with the new period, and no change is scheduled any more',
    [
      moved.plan,
      moved.next_plan,
      { start: iso(moved.current_period_start), end: iso(moved.current_period_end) },
    ],
    ['business', null, periodAfter(ended)],
  )
  const accounts = await packIntact(t, workspaceId, pack, CREDITS.business)
  t.equal(
    'the rest of «Старт» expired and the quota of «Бизнес» was granted',
    journal(accounts.credit_tariff),
    [
      { kind: 'grant', amount: '300.00', key: `order:${first.id}:grant` },
      {
        kind: 'expire',
        amount: '-300.00',
        key: `sub:${subscription.id}:${ended.end.getTime()}:expire`,
      },
      { kind: 'grant', amount: '800.00', key: `order:${renewal.id}:grant` },
    ],
  )
  const [renewed] = await auditOf(t, workspaceId, 'billing.subscription.renew')
  t.equal(
    'the audit holds the choice and the renewal that applied it',
    [
      (await actionsOf(t, workspaceId)).filter((action) =>
        action.startsWith('billing.plan_change'),
      ),
      [renewed.meta.planSlug, renewed.meta.planChanged, renewed.meta.amount, renewed.meta.credits],
    ],
    [['billing.plan_change.schedule'], ['business', true, PRICE.business, 800]],
  )
  const usage = await customer.query('billing.usage')
  t.equal(
    'the customer sees «Бизнес»: its price, quota, daily limit and sites, the gift and the hundred purchased credits',
    [
      usage.subscription.plan.slug,
      usage.subscription.plan.price,
      usage.subscription.nextPlan,
      usage.tariff.credits.left,
      usage.tariff.today?.limit,
      usage.tariff.sites.max,
      usage.gift,
      usage.pack,
      usage.totalLeft,
    ],
    [
      'business',
      PRICE.business,
      null,
      800,
      100,
      3,
      { left: 35, held: 0, granted: true },
      { left: 100, held: 0 },
      935,
    ],
  )
  await t.until('the letter of the charge names the amount that was charged', async () =>
    customer.got('Списание 12 900 ₽ за тариф «Бизнес»'),
  )
  await t.until(
    'and «Оплата прошла» came for it: the third after the tariff and the pack',
    async () => customer.got('Оплата прошла', 3),
  )

  // The change is taken back: the tariff the customer has renews at its own price.
  const other = await subscribed(t)
  await other.customer.mutate('billing.schedulePlanChange', { planSlug: 'business' })
  const back = await other.customer.mutate('billing.cancelPlanChange', {})
  t.equal(
    'a change that is taken back leaves no tariff scheduled; a second cancel is refused',
    [back.plan.slug, back.nextPlan, await other.customer.refusal('billing.cancelPlanChange', {})],
    ['start', null, { status: 409, code: 'BILLING_NOTHING_TO_CHANGE' }],
  )
  const otherEnded = await periodEnded(t, other.subscription.id)
  const otherRenewal = await orderBecomes(
    t,
    'after the change was taken back the renewal is paid',
    () => orderByKey(t, otherEnded.key),
    'paid',
  )
  t.equal(
    'it is «Старт» at 4900.00, as its notice said',
    [
      otherRenewal.amount,
      otherRenewal.plan,
      (await subscriptionOf(t, other.workspaceId)).plan,
      (await noticesOf(t, other.workspaceId)).at(-1).meta,
    ],
    [
      PRICE.start,
      'start',
      'start',
      { planSlug: 'start', amount: PRICE.start, chargeAt: iso(otherEnded.end) },
    ],
  )
  await ledgerHolds(t, other.workspaceId, { tariff: CREDITS.start, pack: 0 }, 'taken back: ')
  t.equal(
    'the audit holds both the choice and its cancel',
    (await actionsOf(t, other.workspaceId)).filter((action) =>
      action.startsWith('billing.plan_change'),
    ),
    ['billing.plan_change.cancel', 'billing.plan_change.schedule'],
  )
}
