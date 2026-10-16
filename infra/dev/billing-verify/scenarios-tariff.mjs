// Scenarios of what a customer does with a tariff that renews: auto-renewal off and on, the
// saved payment method replaced and unlinked — also while a charge is under way —, and the
// grace of an overdue tariff.
import {
  DAY,
  HOUR,
  MINUTE,
  MIR,
  PRICE,
  CREDITS,
  VISA,
  VISA_CARD,
  actionsOf,
  auditOf,
  fromNow,
  giftGrant,
  iso,
  journal,
  journalRow,
  journalsOf,
  ledgerHolds,
  noticesOf,
  orderBecomes,
  orderById,
  orderByKey,
  orderIsOld,
  orderSeen,
  outboxOf,
  overdueFor,
  paymentIdOf,
  periodAfter,
  periodEnded,
  periodEndsAt,
  subscribed,
  subscriptionBecomes,
  subscriptionOf,
} from './scenario-kit.mjs'
import { PAST_DUE_DAYS } from './stand.mjs'

export const scenarios = {}

scenarios['auto-renewal'] = async (t) => {
  // Off: the tariff ends in time.
  const off = await subscribed(t)
  const cancelled = await off.customer.mutate('billing.cancelAutoRenew', {})
  t.equal(
    'off: the answer says until when the tariff works and that no charge is on its way',
    cancelled,
    { renewalCharge: 'none', periodEnd: iso(off.subscription.current_period_end) },
  )
  let overview = await off.customer.query('billing.overview')
  t.equal(
    'off: «Тарифы» shows auto-renewal off and the card still saved',
    [overview.subscription.autoRenewal, overview.subscription.paymentMethod],
    [false, { label: MIR }],
  )
  t.equal(
    'off: switching it off twice is refused',
    await off.customer.refusal('billing.cancelAutoRenew', {}),
    { status: 409, code: 'BILLING_NOTHING_TO_CHANGE' },
  )
  await periodEndsAt(t, off.subscription.id, fromNow(2 * DAY))
  await t.passes(['notices', 'charges'])
  t.equal(
    'off: no notice of a charge is written before the end of the period',
    (await noticesOf(t, off.workspaceId)).length,
    0,
  )
  const offEnded = await periodEnded(t, off.subscription.id)
  await subscriptionBecomes(
    t,
    'off: the tariff ends when its period does',
    off.workspaceId,
    'cancelled',
  )
  overview = await off.customer.query('billing.overview')
  t.equal(
    'off: nothing was charged; «Тарифы» says the tariff was not renewed and when it ended',
    [(await t.shop.charges()).length, overview.subscription, overview.ended],
    [0, null, { planName: 'Старт', endedAt: iso(offEnded.end), reason: 'not_renewed' }],
  )
  await ledgerHolds(t, off.workspaceId, { tariff: 0, pack: 0 }, 'off: ')
  await t.until('off: the customer gets the letter «Тариф закончился»', async () =>
    off.customer.got('Тариф закончился'),
  )

  // Off and on again with the saved card: the tariff renews.
  const on = await subscribed(t)
  await on.customer.mutate('billing.cancelAutoRenew', {})
  t.equal(
    'on again: with a saved card auto-renewal is on at once',
    [
      await on.customer.mutate('billing.resumeAutoRenew', {}),
      (await on.customer.query('billing.overview')).subscription.autoRenewal,
      await on.customer.refusal('billing.resumeAutoRenew', {}),
    ],
    [
      { needsPaymentMethod: false, renewalCharge: 'none' },
      true,
      { status: 409, code: 'BILLING_NOTHING_TO_CHANGE' },
    ],
  )
  const onEnded = await periodEnded(t, on.subscription.id)
  await orderBecomes(
    t,
    'on again: the tariff is renewed at the end of the period',
    () => orderByKey(t, onEnded.key),
    'paid',
  )
  t.equal(
    'on again: the audit holds the switch off and the switch on',
    (await actionsOf(t, on.workspaceId)).filter((action) =>
      action.startsWith('billing.auto_renewal'),
    ),
    ['billing.auto_renewal.cancel', 'billing.auto_renewal.consent', 'billing.auto_renewal.resume'],
  )
  await ledgerHolds(t, on.workspaceId, { tariff: CREDITS.start, pack: 0 }, 'on again: ')

  // Paid without the consent, then switched on: a card is bound first, on the page of the shop.
  const bound = await subscribed(t, { autoRenew: false })
  await t.shop.control('card', VISA_CARD)
  const paymentsBefore = (await t.shop.sent('POST', '/v3/payments')).length
  const resume = await bound.customer.mutate('billing.resumeAutoRenew', {})
  const methodId = paymentIdOf(resume.confirmationUrl ?? '')
  t.equal(
    'binding: without a saved card the customer is sent to the page that binds one',
    [resume.needsPaymentMethod, resume.confirmationUrl],
    [true, `${t.shop.url}/pay/${methodId}`],
  )
  overview = await bound.customer.query('billing.overview')
  t.equal(
    'binding: nothing is switched on before the card is saved',
    [overview.subscription.autoRenewal, overview.bindingPending],
    [false, true],
  )
  t.equal(
    'binding: the shop sends the customer back to the return page of the binding',
    await t.shop.press(resume.confirmationUrl),
    `${t.webUrl}/settings/billing/return?method=1`,
  )
  await t.shop.settle()
  const synced = await bound.customer.mutate('billing.syncPaymentMethod', {})
  const withCard = await subscriptionOf(t, bound.workspaceId)
  t.equal(
    'binding: the card is saved, nothing was charged for it, and auto-renewal is on',
    [
      await t.shop.deliveries(methodId),
      synced.state,
      synced.subscription.autoRenewal,
      synced.subscription.paymentMethod,
      [
        withCard.payment_method_id,
        withCard.pending_payment_method_id,
        withCard.cancel_at_period_end,
      ],
      (await t.shop.sent('POST', '/v3/payments')).length - paymentsBefore,
    ],
    [
      [{ event: 'payment_method.active', status: 200 }],
      'active',
      true,
      { label: VISA },
      [methodId, null, false],
      0,
    ],
  )
  t.equal(
    'binding: the audit holds the binding and the switch it was made for, beside the gift of the registration',
    (await actionsOf(t, bound.workspaceId)).filter(
      (action) => !action.startsWith('billing.subscription'),
    ),
    [
      'billing.auto_renewal.resume',
      'billing.gift.grant',
      'billing.payment_method.bind_start',
      'billing.payment_method.bound',
    ],
  )
  const boundEnded = await periodEnded(t, bound.subscription.id)
  await orderBecomes(
    t,
    'binding: at the end of the period the bound card is charged',
    () => orderByKey(t, boundEnded.key),
    'paid',
  )
  t.equal(
    'binding: the charge named the bound card',
    (await t.shop.charges())
      .filter(({ idempotenceKey }) => idempotenceKey === boundEnded.key)
      .map(({ body }) => body.payment_method_id),
    [methodId],
  )

  // The customer asks support to switch it off: the operator's command.
  const asked = await subscribed(t)
  const who = ['--reason', 'Проверка стенда: клиент попросил отключить', '--operator', 'stand']
  // The address as the customer typed it in the letter: the case of its letters differs.
  const stopped = await t.operator('billing-stop-renewal', [
    asked.customer.email.toUpperCase(),
    ...who,
  ])
  t.check(
    'operator: billing:stop-renewal switches auto-renewal off and says until when the tariff works',
    stopped.code === 0 &&
      stopped.stdout.includes(
        `Автопродление отключено: клиент ${asked.customer.email}, подписка ${asked.subscription.id}, рабочее пространство ${asked.workspaceId}.`,
      ) &&
      /Тариф действует до \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} МСК и больше не списывается\./.test(
        stopped.stdout,
      ) &&
      // The command reads no shop setting: the sentence is the same at either value of the switch.
      stopped.stdout.includes(
        'Способ оплаты сохранён: клиент может включить автопродление снова, если магазину разрешены автоплатежи (YOOKASSA_AUTOPAYMENTS=on).',
      ),
    stopped,
  )
  const [entry] = await auditOf(t, asked.workspaceId, 'billing.auto_renewal.operator_stop')
  t.equal(
    'operator: the audit names the operator’s act, and the customer sees auto-renewal off',
    [
      entry.actor_type,
      entry.meta.renewalCharge,
      (await asked.customer.query('billing.overview')).subscription.autoRenewal,
    ],
    ['operator', 'none', false],
  )
  const repeated = await t.operator('billing-stop-renewal', [asked.customer.email, ...who])
  t.equal(
    'operator: a second run is refused in one line',
    [repeated.code, repeated.stderr.trim()],
    [1, 'Автопродление уже отключено.'],
  )
  await periodEnded(t, asked.subscription.id)
  await subscriptionBecomes(
    t,
    'operator: the tariff ends with its period',
    asked.workspaceId,
    'cancelled',
  )
  t.equal(
    'operator: after the stop no notice was written and nothing was charged',
    [
      (await noticesOf(t, asked.workspaceId)).length,
      (await t.shop.charges()).filter(
        ({ body }) => body.payment_method_id === asked.subscription.payment_method_id,
      ).length,
    ],
    [0, 0],
  )
}

/**
 * Default «н» of the plan: a customer who has not accepted a new edition of the documents is
 * charged all the same, and can stop the charges without accepting it.
 */
scenarios['auto-renewal-without-consent'] = async (t) => {
  const { customer, workspaceId, subscription } = await subscribed(t)
  // A new edition is published: the consents the customer gave are to the one before.
  await t.rows(`DELETE FROM user_consents WHERE user_id = $1`, [customer.id])
  t.equal(
    'the cabinet is closed until the documents are accepted: «Тарифы» and «Оплата» are refused',
    [
      await customer.refusal('billing.overview', undefined, 'query'),
      await customer.refusal('billing.payments', {}, 'query'),
      await customer.refusal('billing.resumeAutoRenew', {}),
    ],
    [
      { status: 428, code: 'CONSENT_REQUIRED' },
      { status: 428, code: 'CONSENT_REQUIRED' },
      { status: 428, code: 'CONSENT_REQUIRED' },
    ],
  )
  t.equal(
    'the page that asks for the consent still shows the coming charge',
    await customer.query('billing.autoRenewal'),
    {
      renewal: {
        planName: 'Старт',
        nextPlanName: null,
        amount: PRICE.start,
        chargeAt: iso(subscription.current_period_end),
        renewalCharge: 'none',
        // The shop of the stand saves payment methods: the step can be taken back.
        oneTimeOnly: false,
      },
    },
  )

  const ended = await periodEnded(t, subscription.id)
  await orderBecomes(
    t,
    'the period ends: the tariff is renewed and charged without the new consent',
    () => orderByKey(t, ended.key),
    'paid',
  )
  await ledgerHolds(t, workspaceId, { tariff: CREDITS.start, pack: 0 })

  const stopped = await customer.mutate('billing.cancelAutoRenew', {})
  t.equal(
    'auto-renewal is switched off without accepting anything',
    [stopped.renewalCharge, stopped.periodEnd, await customer.query('billing.autoRenewal')],
    ['none', periodAfter(ended).end, { renewal: null }],
  )
  t.equal(
    'and the card is unlinked the same way',
    [
      await customer.mutate('billing.unlinkPaymentMethod', {}),
      (await subscriptionOf(t, workspaceId)).payment_method_id,
    ],
    [{ unlinked: true, renewalCharge: 'none' }, null],
  )
  await periodEnded(t, subscription.id)
  await subscriptionBecomes(
    t,
    'the next period ends and the tariff with it',
    workspaceId,
    'cancelled',
  )
  t.equal('nothing more was charged', (await t.shop.charges()).length, 1)
}

scenarios['payment-method'] = async (t) => {
  const { customer, workspaceId, subscription } = await subscribed(t)

  // A binding the customer refuses keeps the card that is saved.
  const refused = await customer.mutate('billing.startPaymentMethodChange', {})
  await t.shop.press(refused.confirmationUrl, 'refuse')
  const kept = await customer.mutate('billing.syncPaymentMethod', {})
  t.equal(
    'a refused binding leaves the saved card as it was',
    [
      kept.state,
      kept.subscription.paymentMethod,
      (await subscriptionOf(t, workspaceId)).payment_method_id,
    ],
    ['inactive', { label: MIR }, subscription.payment_method_id],
  )

  // The replacement: the notification and the polls of the return page arrive together.
  await t.shop.hold()
  await t.shop.control('card', VISA_CARD)
  const change = await customer.mutate('billing.startPaymentMethodChange', {})
  const methodId = paymentIdOf(change.confirmationUrl)
  t.equal(
    'while the new card is being bound the saved one stays, and the page knows a binding is open',
    [
      (await subscriptionOf(t, workspaceId)).payment_method_id,
      (await subscriptionOf(t, workspaceId)).pending_payment_method_id,
      (await customer.query('billing.overview')).bindingPending,
    ],
    [subscription.payment_method_id, methodId, true],
  )
  await t.shop.press(change.confirmationUrl)
  const [notification, ...polls] = await Promise.all([
    t.shop.control('notify', { paymentMethodId: methodId }),
    ...Array.from({ length: 5 }, () => customer.mutate('billing.syncPaymentMethod', {})),
  ])
  await t.shop.release()
  const replaced = await subscriptionOf(t, workspaceId)
  t.equal(
    'the new card is the saved method, and every poll saw it',
    [
      notification.status,
      polls.map(({ state }) => state),
      [
        replaced.payment_method_id,
        replaced.payment_method_card_type,
        replaced.payment_method_last4,
        replaced.pending_payment_method_id,
        replaced.cancel_at_period_end,
      ],
    ],
    [200, polls.map(() => 'active'), [methodId, 'Visa', '1234', null, false]],
  )
  t.equal(
    'it was stored once: one entry of the binding in the audit',
    (await actionsOf(t, workspaceId)).filter((action) =>
      action.startsWith('billing.payment_method'),
    ),
    [
      'billing.payment_method.bind_failed',
      'billing.payment_method.bind_start',
      'billing.payment_method.bind_start',
      'billing.payment_method.bound',
    ],
  )
  t.equal(
    '«Тарифы» shows the new card, auto-renewal still on',
    [
      (await customer.query('billing.overview')).subscription.paymentMethod,
      (await customer.query('billing.overview')).subscription.autoRenewal,
    ],
    [{ label: VISA }, true],
  )

  // The renewal charges the new card.
  const ended = await periodEnded(t, subscription.id)
  await orderBecomes(t, 'the renewal is paid', () => orderByKey(t, ended.key), 'paid')
  await ledgerHolds(t, workspaceId, { tariff: CREDITS.start, pack: 0 }, 'after the renewal: ')
  t.equal(
    'the one charge named the new card, never the replaced one',
    (await t.shop.charges()).map(({ body }) => body.payment_method_id),
    [methodId],
  )

  // The unlink: the card is forgotten, nothing is charged any more.
  const unlinked = await customer.mutate('billing.unlinkPaymentMethod', {})
  const without = await subscriptionOf(t, workspaceId)
  t.equal(
    'the unlink forgets everything of the card and switches auto-renewal off',
    [
      unlinked,
      [
        without.payment_method_id,
        without.payment_method_title,
        without.payment_method_type,
        without.payment_method_card_type,
        without.payment_method_last4,
        without.pending_payment_method_id,
      ],
      without.cancel_at_period_end,
      (await customer.query('billing.overview')).subscription.paymentMethod,
    ],
    [{ unlinked: true, renewalCharge: 'none' }, [null, null, null, null, null, null], true, null],
  )
  t.equal(
    'a second unlink is refused: there is nothing to unlink',
    await customer.refusal('billing.unlinkPaymentMethod', {}),
    { status: 409, code: 'BILLING_NOTHING_TO_CHANGE' },
  )
  await periodEnded(t, subscription.id)
  await subscriptionBecomes(
    t,
    'the next period ends and the tariff with it',
    workspaceId,
    'cancelled',
  )
  t.equal('after the unlink nothing was charged', (await t.shop.charges()).length, 1)
  await ledgerHolds(t, workspaceId, { tariff: 0, pack: 0 })
}

scenarios['past-due-expires'] = async (t) => {
  const { customer, workspaceId, subscription, order: first } = await subscribed(t)
  const pack = await customer.mutate('billing.startPackCheckout', {})
  await t.shop.press(pack.confirmationUrl)
  await orderBecomes(
    t,
    'the customer has a tariff and a pack of a hundred credits',
    () => orderById(t, pack.orderId),
    'paid',
  )

  await t.shop.control('behaviour', {
    target: 'saved',
    behaviour: 'cancel',
    reason: 'card_expired',
  })
  const ended = await periodEnded(t, subscription.id)
  await subscriptionBecomes(
    t,
    'the renewal charge is declined: the tariff is past due',
    workspaceId,
    'past_due',
  )
  await ledgerHolds(
    t,
    workspaceId,
    { tariff: CREDITS.start, pack: CREDITS.pack },
    'while overdue nothing expires: ',
  )

  // Almost the whole grace passes.
  await overdueFor(t, subscription.id, PAST_DUE_DAYS * DAY - HOUR)
  await t.passes(['period_ends', 'charges', 'notices'])
  const waiting = await subscriptionOf(t, workspaceId)
  t.equal(
    'an hour before the grace runs out the tariff still waits, and the page names the moment it ends',
    [waiting.status, (await customer.query('billing.overview')).pastDueEndsAt],
    ['past_due', iso(new Date(waiting.past_due_since.getTime() + PAST_DUE_DAYS * DAY))],
  )
  t.check(
    'that moment is an hour from now',
    Math.abs(waiting.past_due_since.getTime() + PAST_DUE_DAYS * DAY - Date.now() - HOUR) < MINUTE,
    waiting,
  )

  // The grace is over.
  await overdueFor(t, subscription.id, PAST_DUE_DAYS * DAY + MINUTE)
  const expired = await subscriptionBecomes(
    t,
    'seven days without a payment: the tariff expires',
    workspaceId,
    'expired',
  )
  const accounts = await ledgerHolds(t, workspaceId, { tariff: 0, pack: CREDITS.pack })
  t.equal(
    'the rest of the tariff expired; the purchased credits are where they were',
    [journal(accounts.credit_tariff).at(-1), journal(accounts.credit_pack)],
    [
      {
        kind: 'expire',
        amount: '-300.00',
        key: `sub:${subscription.id}:${ended.end.getTime()}:expire`,
      },
      [{ kind: 'grant', amount: '100.00', key: `order:${pack.orderId}:pack` }],
    ],
  )
  // The rule of a tariff that ends unpaid, on the three accounts: what is available of the
  // tariff expires; the gift stays and can be spent; the pack stays and waits for a tariff.
  t.equal(
    'a tariff unpaid for seven days: the rest of its quota expired, the gift and the pack are the one grant each',
    await journalsOf(t, workspaceId),
    {
      tariff: [journalRow.quota(first), journalRow.expired(subscription, ended.end)],
      gift: [giftGrant(customer.id)],
      pack: [journalRow.pack({ id: pack.orderId })],
    },
  )
  const [end] = await auditOf(t, workspaceId, 'billing.subscription.end')
  t.equal('the audit says the grace ran out', end.meta, {
    status: 'expired',
    reason: 'past_due_grace',
    periodEnd: iso(ended.end),
    expiredCredits: 300,
    packCreditsLeft: 100,
    notified: true,
  })
  await t.until('the customer gets the letter «Тариф закончился»', async () =>
    customer.got('Тариф закончился'),
  )
  const overview = await customer.query('billing.overview')
  t.equal(
    '«Тарифы» shows no tariff, that the last one was not paid for, the gift and the hundred purchased credits',
    [
      overview.subscription,
      overview.ended.planName,
      overview.ended.reason,
      overview.pastDueEndsAt,
      overview.credits.tariff.available,
      overview.credits.gift,
      overview.credits.pack,
    ],
    [
      null,
      'Старт',
      'not_paid',
      null,
      0,
      { balance: 35, held: 0, available: 35, granted: true },
      { balance: 100, held: 0, available: 100 },
    ],
  )
  t.equal(
    'it ended when the grace ran out — the moment of the audit entry — not at the end of the paid period',
    [
      overview.ended.endedAt,
      overview.ended.endedAt === iso(ended.end),
      iso(expired.current_period_end),
    ],
    [iso(end.created_at), false, iso(ended.end)],
  )
  const usage = await customer.query('billing.usage')
  t.equal(
    '«Использование» keeps the gift and the hundred purchased credits',
    [usage.subscription, usage.gift, usage.pack, usage.totalLeft],
    [null, { left: 35, held: 0, granted: true }, { left: 100, held: 0 }, 135],
  )
  t.equal(
    'of those 135 a task could spend the 35 of the gift: the pack waits for a tariff',
    [usage.spendable, overview.credits.spendable],
    [35, 35],
  )
  t.equal(
    'an expired tariff cannot be paid for by hand any more; the declined charge was the only one',
    [await customer.refusal('billing.startPastDuePayment', {}), (await t.shop.charges()).length],
    [{ status: 409, code: 'BILLING_NO_LIVE_SUBSCRIPTION' }, 1],
  )
}

scenarios['unlink-at-bank'] = async (t) => {
  const { customer, workspaceId, subscription } = await subscribed(t)
  // The bank takes its time over the renewal charge.
  await t.shop.control('behaviour', { target: 'saved', behaviour: 'stay-pending' })
  const ended = await periodEnded(t, subscription.id)
  const hanging = await t.until('the renewal charge is at the bank', async () => {
    const order = await orderByKey(t, ended.key)
    return order?.yookassa_payment_id ? order : orderSeen(order)
  })
  t.equal(
    'the page already tells the customer that a charge is at the bank',
    (await customer.query('billing.overview')).renewalCharge,
    'at_bank',
  )

  const unlinked = await customer.mutate('billing.unlinkPaymentMethod', {})
  const without = await subscriptionOf(t, workspaceId)
  t.equal(
    'the customer unlinks the card and is told that this charge is not stopped by it',
    [unlinked, without.payment_method_id, without.cancel_at_period_end, without.status],
    [{ unlinked: true, renewalCharge: 'at_bank' }, null, true, 'active'],
  )
  const [entry] = await auditOf(t, workspaceId, 'billing.payment_method.unlink')
  t.equal('the audit keeps what the customer was told', entry.meta.renewalCharge, 'at_bank')
  await t.passes(['notices', 'charges', 'stuck_orders', 'period_ends'])
  t.equal(
    'while the bank decides the tariff is not ended, though it has no card and its period is over',
    [
      (await subscriptionOf(t, workspaceId)).status,
      (await orderByKey(t, ended.key)).status,
      (await t.shop.charges()).length,
    ],
    ['active', 'pending', 1],
  )

  // The bank approves the payment.
  await t.shop.control('complete', { paymentId: hanging.yookassa_payment_id })
  const renewal = await orderBecomes(
    t,
    'the bank approves: the renewal order is paid',
    () => orderByKey(t, ended.key),
    'paid',
  )
  const renewed = await subscriptionOf(t, workspaceId)
  t.equal(
    'the payment renews the tariff for one more month; the card stays unlinked, auto-renewal off',
    [
      renewed.status,
      { start: iso(renewed.current_period_start), end: iso(renewed.current_period_end) },
      renewed.payment_method_id,
      renewed.cancel_at_period_end,
    ],
    ['active', periodAfter(ended), null, true],
  )
  const accounts = await ledgerHolds(t, workspaceId, { tariff: CREDITS.start, pack: 0 })
  t.equal(
    'the quota of the renewed month is granted once',
    journal(accounts.credit_tariff).at(-1),
    {
      kind: 'grant',
      amount: '300.00',
      key: `order:${renewal.id}:grant`,
    },
  )
  const overview = await customer.query('billing.overview')
  t.equal(
    '«Тарифы» shows the renewed month, no card, no auto-renewal, no charge on its way',
    [
      overview.subscription.period,
      overview.subscription.paymentMethod,
      overview.subscription.autoRenewal,
      overview.renewalCharge,
    ],
    [periodAfter(ended), null, false, 'none'],
  )

  // No further charge: the renewed month ends, and the tariff with it.
  await periodEnded(t, subscription.id)
  await subscriptionBecomes(
    t,
    'when the renewed month ends the tariff ends with it',
    workspaceId,
    'cancelled',
  )
  t.equal('the charge that was at the bank stayed the only one', (await t.shop.charges()).length, 1)
}

scenarios['unanswered-then-unlink'] = async (t) => {
  // In both stories the shop takes the money and its answer is lost; the notification is held.
  const lose = async () => {
    const tariff = await subscribed(t)
    await t.shop.hold()
    await t.shop.control('behaviour', { target: 'saved', behaviour: 'http-500-once' })
    const ended = await periodEnded(t, tariff.subscription.id)
    const order = await t.until('a renewal charge is made and its answer is lost', async () => {
      const row = await orderByKey(t, ended.key)
      const sent = (await t.shop.charges()).some(
        ({ idempotenceKey }) => idempotenceKey === ended.key,
      )
      return row?.status === 'pending' && sent ? row : orderSeen(row)
    })
    const payment = (await t.shop.state()).payments.find(
      ({ metadata }) => metadata?.order_id === order.id,
    )
    const unlinked = await tariff.customer.mutate('billing.unlinkPaymentMethod', {})
    t.equal(
      'the customer unlinks the card and is told that a charge was sent and nobody knows its outcome',
      [unlinked, payment?.status, order.yookassa_payment_id],
      [{ unlinked: true, renewalCharge: 'unanswered' }, 'succeeded', null],
    )
    // Old enough for the pass of stuck orders to look at it.
    await orderIsOld(t, order.id, 6 * MINUTE)
    await t.passes(['stuck_orders', 'charges', 'period_ends'])
    t.equal(
      'after the unlink the charge is not repeated, and the tariff is not ended while its outcome is open',
      [
        (await t.shop.charges()).filter(({ idempotenceKey }) => idempotenceKey === ended.key)
          .length,
        (await orderByKey(t, ended.key)).status,
        (await subscriptionOf(t, tariff.workspaceId)).status,
      ],
      [1, 'pending', 'active'],
    )
    return { ...tariff, ended, order, payment }
  }

  // The notification arrives after all.
  const told = await lose()
  await t.shop.release()
  const late = await t.shop.control('notify', { paymentId: told.payment.id })
  const renewal = await orderByKey(t, told.ended.key)
  const renewed = await subscriptionOf(t, told.workspaceId)
  t.equal(
    'the notification comes: the payment is attached to its order and renews the tariff for a month',
    [
      late.status,
      renewal.status,
      renewal.yookassa_payment_id,
      (await auditOf(t, told.workspaceId, 'billing.order.payment_attached')).length,
      { start: iso(renewed.current_period_start), end: iso(renewed.current_period_end) },
    ],
    [200, 'paid', told.payment.id, 1, periodAfter(told.ended)],
  )
  t.equal(
    'the card stays unlinked and auto-renewal off: nothing more will be charged',
    [renewed.payment_method_id, renewed.cancel_at_period_end],
    [null, true],
  )
  await ledgerHolds(t, told.workspaceId, { tariff: CREDITS.start, pack: 0 }, 'notified: ')
  await periodEnded(t, told.subscription.id)
  await subscriptionBecomes(
    t,
    'that month ends and the tariff with it',
    told.workspaceId,
    'cancelled',
  )

  // The notification never arrives: the operator finds the payment.
  const silent = await lose()
  await orderIsOld(t, silent.order.id, 12 * HOUR + 6 * MINUTE)
  const givenUp = await orderBecomes(
    t,
    'twelve hours without an answer: the order is given up',
    () => orderByKey(t, silent.ended.key),
    'failed',
  )
  t.equal(
    'nobody knows what became of the charge, and the customer is not told that it failed',
    [
      givenUp.failure_reason,
      (await auditOf(t, silent.workspaceId, 'billing.renewal.unknown_result')).length,
      await outboxOf(t, 'billing.payment_failed', givenUp.id),
    ],
    ['unknown_result', 1, []],
  )
  // Auto-renewal went off with the card: the tariff is not overdue, it ends with its period.
  await subscriptionBecomes(
    t,
    'the tariff, which is not renewed any more, ends with the period it was paid for',
    silent.workspaceId,
    'cancelled',
  )
  const listed = await t.operator('billing-refunds-needed', [])
  t.check(
    'billing:refunds-needed lists the charge under «Списания без ответа» with what to look its payment up by',
    listed.code === 0 &&
      listed.stdout.includes('Списания без ответа: 1.') &&
      listed.stdout.includes(`в его данных order_id = ${givenUp.id}`),
    listed,
  )
  // The operator finds the payment in the cabinet by that order id.
  const found = await t.operator('billing-settle-payment', [silent.payment.id])
  t.check(
    'billing:settle-payment attaches the payment the operator found and says the money has to go back',
    found.code === 0 &&
      found.stdout.includes(`Платёж привязан к заказу ${givenUp.id}.`) &&
      found.stdout.includes(
        `Платёж ${silent.payment.id} прошёл, а заказ ${givenUp.id} закрыт (оплата не прошла). Деньги нужно вернуть: заказ есть в billing:refunds-needed.`,
      ),
    found,
  )
  const waiting = await t.operator('billing-refunds-needed', [])
  t.check(
    'the order moved from «Списания без ответа» to «Ожидают возврата», to be returned in the cabinet',
    waiting.stdout.includes('Ожидают возврата: 1.') &&
      waiting.stdout.includes(
        `заказ ${givenUp.id} (оплата не прошла) · платёж ${silent.payment.id}`,
      ) &&
      waiting.stdout.includes('к возврату 4900.00 ₽ из 4900.00 ₽') &&
      waiting.stdout.includes('как вернуть: в кабинете ЮKassa') &&
      !waiting.stdout.includes('Списания без ответа'),
    waiting,
  )
  const after = await subscriptionOf(t, silent.workspaceId)
  const accounts = await ledgerHolds(t, silent.workspaceId, { tariff: 0, pack: 0 }, 'silent: ')
  t.equal(
    'money that came for a closed order renews nothing: the tariff stays ended, no quota is granted',
    [
      after.status,
      iso(after.current_period_end),
      journal(accounts.credit_tariff).map(({ kind }) => kind),
    ],
    ['cancelled', iso(silent.ended.end), ['grant', 'expire']],
  )
  // The owner of the shop returns the money in the cabinet; this notification arrives.
  await t.shop.release()
  const returned = await t.shop.cabinet('/refunds', {
    payment_id: silent.payment.id,
    amount: { value: PRICE.start, currency: 'RUB' },
  })
  await t.shop.settle()
  const done = await t.operator('billing-refunds-needed', [])
  t.check(
    'once the money is returned in the cabinet nothing waits for the operator',
    returned.status === 200 && done.stdout.includes('Заказов, ожидающих возврата, нет.'),
    { returned, done },
  )
}
