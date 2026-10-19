// Scenarios of the operator's commands: the credit rate, refunds through ЮKassa and refunds
// made in its cabinet, and the money of a payment that was made twice.
import {
  CREDIT_RATE,
  MINUTE,
  PRICE,
  CREDITS,
  accountsOf,
  addSite,
  auditOf,
  creditRateUsable,
  giftGrant,
  journal,
  journalRow,
  journalsOf,
  ledgerHolds,
  orderBecomes,
  orderById,
  packBought,
  paymentIdOf,
  refundEntries,
  refundRequests,
  signed,
  subscribed,
  subscriptionOf,
} from './scenario-kit.mjs'

export const scenarios = {}

scenarios['credit-rate'] = async (t) => {
  /** What the two pages tell a customer of a new task: the answer and what could be spent. */
  const told = async (customer) => {
    const { credits } = await customer.query('billing.overview')
    const usage = await customer.query('billing.usage')
    return {
      plans: [credits.newTask, credits.spendable],
      usage: [usage.newTask, usage.spendable],
    }
  }
  const both = (answer, spendable) => ({
    plans: [answer, spendable],
    usage: [answer, spendable],
  })
  const PAUSED = { allowed: false, reason: 'rate_missing' }
  const TAKEN = { allowed: true, reason: null }
  const rates = () =>
    t.rows(
      `SELECT id, rub_per_credit::text AS rate, basis, effective_from FROM credit_rates
       ORDER BY effective_from`,
    )
  const approvals = () =>
    t.rows(
      `SELECT actor_type::text AS actor, workspace_id, target_type, target_id, meta
       FROM audit_log WHERE action = 'billing.credit_rate.approve' ORDER BY id`,
    )

  // The scenario is about the first rate of a database. In a run where one is in force already
  // there is nothing to approve first.
  t.equal(
    'no credit rate is in force yet: nothing approves one but the operator',
    [await rates(), await creditRateUsable(t)],
    [[], false],
  )

  // Three customers: one who only registered, one with a tariff and a pack, one whose first
  // site made the workspace.
  const onlooker = await t.customer()
  const paying = await subscribed(t)
  await packBought(t, paying.customer)
  const withSite = await t.customer()
  await addSite(t, withSite, { name: 'Кофейня', url: `https://rate-${withSite.id}.example.ru` })
  t.equal(
    'without a rate nobody’s task is taken, whatever they could spend: the gift promised, the gift granted, 435 credits of three accounts',
    [await told(onlooker), await told(withSite), await told(paying.customer)],
    [both(PAUSED, 35), both(PAUSED, 35), both(PAUSED, 435)],
  )
  t.equal(
    '«Тарифы» has no table of «Точный расчёт» to show',
    (await onlooker.query('billing.plans')).creditConversion,
    null,
  )

  // What the rate would mean is printed before anything is written; a rate that puts more
  // than half of a tariff's price behind its credits is not written without a confirmation.
  const basis = 'Проверка стенда: предварительный курс проекта модели кредитов'
  const dear = await t.operatorFile('rates-dear.json', { rubPerCredit: '9.00', basis, prices: [] })
  const refused = await t.operator('billing-rates', ['--file', dear, ...signed('курс выше')])
  t.check(
    'billing:rates refuses 9.00 ₽ a credit without --confirm-exposure: «Старт» would cost more than half of its price',
    refused.code === 1 &&
      refused.stdout.includes('  start (тариф): 300 кредитов — 2700.00 ₽, 55.1 % цены 4900.00 ₽') &&
      refused.stdout.includes('Учётная стоимость выше половины цены у тарифов: start') &&
      refused.stderr.includes('Курс и ставки не записаны.') &&
      refused.stderr.includes('Нужно подтверждение --confirm-exposure'),
    refused,
  )
  const file = await t.operatorFile('rates.json', { rubPerCredit: CREDIT_RATE, basis, prices: [] })
  const past = await t.operator('billing-rates', [
    '--file',
    file,
    '--effective-from',
    '2026-01-01T00:00:00.000+03:00',
    ...signed('задним числом'),
  ])
  t.check(
    'and a rate that would start in the past',
    past.code === 1 &&
      past.stderr.includes('Курс и ставки не записаны.') &&
      past.stderr.includes('Задним числом курс и ставки не записываются.'),
    past,
  )
  t.equal(
    'neither refusal wrote anything: no rate, no entry in the audit, and still no task is taken',
    [await rates(), await approvals(), await told(paying.customer)],
    [[], [], both(PAUSED, 435)],
  )

  // The approval. The command counts what the rate stands behind by the accounts of every
  // workspace: the stand counts the same from the database.
  const [outstanding] = await t.rows(
    `SELECT COALESCE(sum(balance) FILTER (WHERE unit = 'credit_pack'), 0)::int AS pack,
       COALESCE(sum(balance) FILTER (WHERE unit = 'credit_gift'), 0)::int AS gift
     FROM billing_accounts`,
  )
  const cost = (credits) => (credits * Number(CREDIT_RATE)).toFixed(2)
  const approved = await t.operator('billing-rates', ['--file', file, ...signed('первый курс')])
  const [rate, ...otherRates] = await rates()
  t.check(
    'billing:rates approves 6.00 ₽ a credit and says what it means: the cost behind every tariff and the pack, and behind the credits not spent yet',
    approved.code === 0 &&
      approved.stdout.includes(
        'Действие: утвердить курс кредита 6.00 ₽ учётной стоимости за кредит; ставки моделей не меняются.',
      ) &&
      approved.stdout.includes(`Основание: ${basis}`) &&
      approved.stdout.includes(
        'На момент начала действующего курса нет. Новый курс — 6.000000 ₽ учётной стоимости за кредит.',
      ) &&
      approved.stdout.includes(
        '  start (тариф): 300 кредитов — 1800.00 ₽, 36.7 % цены 4900.00 ₽',
      ) &&
      approved.stdout.includes(
        '  business (тариф): 800 кредитов — 4800.00 ₽, 37.2 % цены 12900.00 ₽',
      ) &&
      approved.stdout.includes(
        '  agency (тариф): 2500 кредитов — 15000.00 ₽, 37.6 % цены 39900.00 ₽',
      ) &&
      approved.stdout.includes('  pack (пакет): 100 кредитов — 600.00 ₽, 30.2 % цены 1990.00 ₽') &&
      approved.stdout.includes(
        `Не потраченные кредиты всех рабочих пространств: из пакетов — ${outstanding.pack} (${cost(outstanding.pack)} ₽ учётной стоимости), подарочные — ${outstanding.gift} (${cost(outstanding.gift)} ₽).`,
      ) &&
      approved.stdout.includes(
        'light — 20 кредитов, 120.00 ₽; standard — 45 кредитов, 270.00 ₽; heavy — 120 кредитов, 720.00 ₽',
      ) &&
      approved.stdout.includes('Включённых моделей нет.') &&
      approved.stdout.includes(
        `Записано: курс кредита ${rate?.id} и ставки моделей (0) действуют с `,
      ),
    approved,
  )
  t.check(
    'the credits the command counted are on the accounts: at least the pack and the two gifts of this scenario',
    outstanding.pack >= CREDITS.pack && outstanding.gift >= 2 * CREDITS.gift,
    outstanding,
  )
  const [approval, ...otherApprovals] = await approvals()
  t.equal(
    'one row of the rate is written, with its basis, and the audit holds the operator’s approval — of no workspace',
    [
      [rate?.rate, rate?.basis, otherRates.length],
      [approval?.actor, approval?.workspace_id, approval?.target_type, approval?.target_id],
      [approval?.meta.rubPerCredit, approval?.meta.previousRubPerCredit, approval?.meta.prices],
      otherApprovals.length,
    ],
    [['6.000000', basis, 0], ['operator', null, 'credit_rate', rate?.id], ['6.000000', null, 0], 0],
  )

  // From its start on a task is taken wherever five credits can be spent — which the gift alone
  // is enough for; nothing else of the pages moved.
  await t.until(
    'with the rate in force a task of the customer with a tariff would be taken',
    async () => (await paying.customer.query('billing.overview')).credits.newTask.allowed,
  )
  t.equal(
    'the same three customers read that a task would be taken; what they could spend is what it was',
    [await told(onlooker), await told(withSite), await told(paying.customer)],
    [both(TAKEN, 35), both(TAKEN, 35), both(TAKEN, 435)],
  )
  t.equal(
    'the rate alone gives «Точный расчёт» no table: no enabled model has a price',
    (await onlooker.query('billing.plans')).creditConversion,
    null,
  )
  await ledgerHolds(
    t,
    paying.workspaceId,
    { tariff: CREDITS.start, pack: CREDITS.pack },
    'the approval moved no credit: ',
  )
}

scenarios.refund = async (t) => {
  const { customer, workspaceId, order, subscription } = await subscribed(t)
  const pack = await customer.mutate('billing.startPackCheckout', {})
  await t.shop.press(pack.confirmationUrl)
  await orderBecomes(
    t,
    'the customer has paid for a tariff and for a pack',
    () => orderById(t, pack.orderId),
    'paid',
  )
  // A second pack: the refund of the first one must leave it alone.
  const second = await packBought(t, customer, 'and for a second pack: 200 purchased credits')
  const before = {
    subscription: await subscriptionOf(t, workspaceId),
    accounts: await accountsOf(t, workspaceId),
  }

  // The money of the tariff goes back; nothing else is asked for.
  const refunded = await t.operator('billing-refund', [order.id, ...signed('возврат по обращению')])
  await t.shop.settle()
  const [refund, ...others] = (await t.shop.state()).refunds
  t.check(
    'billing:refund says what it is about to do and that the refund went through',
    refunded.code === 0 &&
      refunded.stdout.includes(`Заказ ${order.id}: тариф, 4900.00 ₽, оплачен.`) &&
      refunded.stdout.includes('Действие: вернуть 4900.00 ₽ через ЮKassa (весь платёж).') &&
      refunded.stdout.includes(
        'Тариф и кредиты клиента не меняются: возвращаются только деньги.',
      ) &&
      (refunded.stdout.includes(`Возврат ${refund?.id} проведён: заказ отмечен возвращённым.`) ||
        refunded.stdout.includes(
          `Возврат ${refund?.id} проведён; заказ уже отмечен возвращённым по уведомлению ЮKassa.`,
        )),
    refunded,
  )
  t.equal(
    'the shop got one request, under the key of the order and marked by its description, and made one refund',
    [
      (await refundRequests(t)).map(({ idempotenceKey, status, body }) => ({
        idempotenceKey,
        status,
        payment: body.payment_id,
        amount: body.amount,
        description: body.description,
        metadata: body.metadata,
      })),
      [refund?.payment_id, refund?.status, refund?.amount.value, others.length],
    ],
    [
      [
        {
          idempotenceKey: `refund.${order.id}`,
          status: 200,
          payment: order.yookassa_payment_id,
          amount: { value: PRICE.start, currency: 'RUB' },
          description: `Возврат по заказу ${order.id}`,
          metadata: undefined,
        },
      ],
      [order.yookassa_payment_id, 'succeeded', PRICE.start, 0],
    ],
  )
  t.equal('web took the notification of the refund', await t.shop.deliveries(refund.id), [
    { event: 'refund.succeeded', status: 200 },
  ])
  let row = await orderById(t, order.id)
  t.equal(
    'the order is refunded in full, by that refund',
    [row.status, row.yookassa_refund_id, row.refunded_amount, row.refunded_at !== null],
    ['refunded', refund.id, PRICE.start, true],
  )
  let entries = await refundEntries(t, workspaceId)
  t.equal(
    'the audit holds the operator’s refund once, and no refund made elsewhere',
    [
      entries
        .filter(({ action }) => action === 'billing.order.refund')
        .map(({ actor_type }) => actor_type),
      entries.filter(({ action }) => action === 'billing.order.refund_outside').length,
      entries.filter(({ action }) => action === 'billing.order.refund_settled').length <= 1,
    ],
    [['operator'], 0, true],
  )
  t.equal(
    'without an option the tariff and every credit account are exactly what they were',
    {
      subscription: await subscriptionOf(t, workspaceId),
      accounts: await accountsOf(t, workspaceId),
    },
    before,
  )
  const shown = (await customer.query('billing.payments', {})).items.find(
    ({ id }) => id === order.id,
  )
  t.equal(
    '«Оплата» shows the payment as returned',
    [shown.status, shown.refundedAmount, shown.refundedAt !== null],
    ['refunded', PRICE.start, true],
  )

  // The command again, and the notification again: no second refund.
  const again = await t.operator('billing-refund', [order.id, ...signed('повтор')])
  const repeated = await t.shop.control('notify', { refundId: refund.id })
  row = await orderById(t, order.id)
  entries = await refundEntries(t, workspaceId)
  t.check(
    'a second run and a repeated notification make no second refund and write nothing',
    again.code === 0 &&
      again.stdout.includes(
        `Заказ уже возвращён (возврат ${refund.id}): второй возврат не создан.`,
      ) &&
      repeated.status === 200 &&
      (await t.shop.state()).refunds.length === 1 &&
      (await refundRequests(t)).length === 1 &&
      entries.filter(({ action }) => action === 'billing.order.refund').length === 1 &&
      row.status === 'refunded' &&
      row.yookassa_refund_id === refund.id,
    { again, repeated, entries },
  )

  // The option after the money has gone back: the tariff ends now.
  const ending = await t.operator('billing-refund', [
    order.id,
    '--end-subscription',
    ...signed('клиент отказался от тарифа'),
  ])
  const ended = await subscriptionOf(t, workspaceId)
  t.check(
    'billing:refund --end-subscription ends the tariff at once without another refund',
    ending.code === 0 &&
      /Тариф завершён \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} МСК; сгорело кредитов тарифа: 300\./.test(
        ending.stdout,
      ) &&
      (await refundRequests(t)).length === 1,
    ending,
  )
  t.equal(
    'the tariff is over as of now, and its payment method is kept for nothing',
    [
      ended.status,
      ended.cancel_at_period_end,
      Math.abs(ended.current_period_end.getTime() - Date.now()) < MINUTE,
    ],
    ['cancelled', true, true],
  )
  let accounts = await ledgerHolds(t, workspaceId, { tariff: 0, pack: 2 * CREDITS.pack })
  const [end] = await auditOf(t, workspaceId, 'billing.subscription.end')
  t.equal(
    'the rest of the tariff expired, the packs stayed, and the audit names the refund as the reason',
    [
      journal(accounts.credit_tariff).at(-1).kind,
      end.actor_type,
      end.meta.reason,
      end.meta.orderId,
      end.meta.expiredCredits,
    ],
    ['expire', 'operator', 'refund', order.id, 300],
  )
  // The rule of a tariff the operator ends, on the three accounts (the expiry rules of the
  // credits design): what is available of the tariff expires — under the key of the period it
  // was paid for, though the tariff ends now —; the gift stays and can be spent; the packs stay
  // and wait for a tariff.
  t.equal(
    'a refund with --end-subscription: the rest of the quota expired, the gift is its one grant, both packs are whole',
    await journalsOf(t, workspaceId),
    {
      tariff: [
        journalRow.quota(order),
        journalRow.expired(subscription, subscription.current_period_end),
      ],
      gift: [giftGrant(customer.id)],
      pack: [journalRow.pack({ id: pack.orderId }), journalRow.pack(second)],
    },
  )
  const overview = await customer.query('billing.overview')
  t.equal(
    'of the 235 credits that are left a task could spend the 35 of the gift',
    [overview.credits.spendable, overview.credits.totalAvailable],
    [35, 235],
  )
  t.equal(
    '«Тарифы» shows no tariff and says the last one was returned; no «Тариф закончился» letter is sent',
    [
      overview.subscription,
      overview.ended.planName,
      overview.ended.reason,
      customer.letters('Тариф закончился').length,
    ],
    [null, 'Старт', 'refunded', 0],
  )

  // The first pack: the money back and its credits off the account — its own hundred, though
  // two hundred are available.
  const packRefund = await t.operator('billing-refund', [
    pack.orderId,
    '--take-credits',
    ...signed('возврат пакета'),
  ])
  await t.shop.settle()
  accounts = await ledgerHolds(t, workspaceId, { tariff: 0, pack: CREDITS.pack })
  t.check(
    'billing:refund --take-credits returns the pack and takes its hundred credits',
    packRefund.code === 0 &&
      packRefund.stdout.includes(`Заказ ${pack.orderId}: пакет кредитов, 1990.00 ₽, оплачен.`) &&
      packRefund.stdout.includes('Снято кредитов пакета: 100.'),
    packRefund,
  )
  t.equal(
    'the credits left the account once, under the key of the order; the order is refunded',
    [
      journal(accounts.credit_pack),
      (await orderById(t, pack.orderId)).status,
      (await orderById(t, second.id)).status,
      (await t.shop.state()).refunds.length,
    ],
    [
      [
        { kind: 'grant', amount: '100.00', key: `order:${pack.orderId}:pack` },
        { kind: 'grant', amount: '100.00', key: `order:${second.id}:pack` },
        { kind: 'adjust', amount: '-100.00', key: `order:${pack.orderId}:refund:adjust` },
      ],
      'refunded',
      'paid',
      2,
    ],
  )
  // The rule of a pack that is refunded, on the three accounts: what is available of the pack
  // account is taken, at most the size of that pack; the tariff and the gift are not touched.
  t.equal(
    'a refund with --take-credits: the hundred of that pack is taken, the other pack and the gift are whole',
    await journalsOf(t, workspaceId),
    {
      tariff: [
        journalRow.quota(order),
        journalRow.expired(subscription, subscription.current_period_end),
      ],
      gift: [giftGrant(customer.id)],
      pack: [
        journalRow.pack({ id: pack.orderId }),
        journalRow.pack(second),
        journalRow.packTaken({ id: pack.orderId }),
      ],
    },
  )
  t.equal(
    '«Тарифы» and «Использование» show the hundred credits of the pack that was not refunded',
    [
      (await customer.query('billing.overview')).credits.pack,
      (await customer.query('billing.usage')).pack,
    ],
    [
      { balance: 100, held: 0, available: 100 },
      { left: 100, held: 0 },
    ],
  )
  const packAgain = await t.operator('billing-refund', [
    pack.orderId,
    '--take-credits',
    ...signed('повтор'),
  ])
  t.check(
    'a second run takes nothing more',
    packAgain.code === 0 &&
      packAgain.stdout.includes('Кредиты пакета уже были сняты раньше (100).') &&
      (await t.shop.state()).refunds.length === 2,
    packAgain,
  )
  await ledgerHolds(t, workspaceId, { tariff: 0, pack: CREDITS.pack }, 'after the repeat ')
}

scenarios['refund-in-cabinet'] = async (t) => {
  // A part of the payment is returned in the cabinet of ЮKassa: a refund the platform did not ask for.
  const part = await subscribed(t)
  const partial = await t.shop.cabinet('/refunds', {
    payment_id: part.order.yookassa_payment_id,
    amount: { value: '1000.00', currency: 'RUB' },
  })
  await t.shop.settle()
  await t.shop.control('notify', { refundId: partial.body.id })
  const outside = (await refundEntries(t, part.workspaceId)).map(
    ({ action, target_id: target, meta }) => ({
      action,
      target,
      meta,
    }),
  )
  t.equal(
    'a part returned in the cabinet: one entry of a refund made elsewhere, however often it is notified of',
    [partial.status, outside],
    [
      200,
      [
        {
          action: 'billing.order.refund_outside',
          target: part.order.id,
          meta: {
            refundId: partial.body.id,
            paymentId: part.order.yookassa_payment_id,
            refundAmount: '1000.00',
            refundCurrency: 'RUB',
            orderAmount: PRICE.start,
            orderStatus: 'paid',
            ownRefundId: null,
          },
        },
      ],
    ],
  )
  let row = await orderById(t, part.order.id)
  t.equal(
    'the order stays paid and knows of no refund; the tariff works',
    [
      row.status,
      row.yookassa_refund_id,
      row.refunded_amount,
      (await subscriptionOf(t, part.workspaceId)).status,
    ],
    ['paid', null, null, 'active'],
  )
  const requestsBefore = (await refundRequests(t)).length
  const refused = await t.operator('billing-refund', [part.order.id, ...signed('возврат')])
  const notWhole = await t.operator('billing-refund', [
    part.order.id,
    '--refunded-in-cabinet',
    ...signed('отметить'),
  ])
  t.check(
    'billing:refund refuses to add a refund to one it does not know, and to mark a part as the whole',
    refused.code === 1 &&
      refused.stderr.startsWith('По платежу уже есть возврат, о котором заказ не знает') &&
      notWhole.code === 1 &&
      notWhole.stderr.includes(
        '--refunded-in-cabinet не подходит: по данным ЮKassa платёж не возвращён полностью.',
      ) &&
      (await refundRequests(t)).length === requestsBefore,
    { refused, notWhole },
  )

  // The whole payment is returned in the cabinet.
  const whole = await subscribed(t)
  const full = await t.shop.cabinet('/refunds', {
    payment_id: whole.order.yookassa_payment_id,
    amount: { value: PRICE.start, currency: 'RUB' },
  })
  await t.shop.settle()
  const blind = await t.operator('billing-refund', [whole.order.id, ...signed('возврат')])
  const ownRequests = (await refundRequests(t)).filter(
    ({ idempotenceKey }) => idempotenceKey === `refund.${whole.order.id}`,
  )
  t.check(
    'the whole payment returned in the cabinet: the command’s own request is refused by the shop and it says how to go on',
    full.status === 200 &&
      blind.code === 1 &&
      blind.stderr.includes('повторите команду с --refunded-in-cabinet') &&
      ownRequests.length === 1 &&
      ownRequests[0].status === 400 &&
      (await t.shop.state()).refunds.filter(
        ({ payment_id: payment }) => payment === whole.order.yookassa_payment_id,
      ).length === 1,
    { blind, ownRequests },
  )
  const marked = await t.operator('billing-refund', [
    whole.order.id,
    '--refunded-in-cabinet',
    '--end-subscription',
    ...signed('возвращено в кабинете'),
  ])
  row = await orderById(t, whole.order.id)
  t.check(
    'billing:refund --refunded-in-cabinet marks the order without asking for a refund',
    marked.code === 0 &&
      marked.stdout.includes(
        'Заказ отмечен возвращённым: по данным ЮKassa весь платёж возвращён в кабинете. Запрос на возврат не отправлялся.',
      ) &&
      (await refundRequests(t)).filter(({ idempotenceKey }) =>
        idempotenceKey?.startsWith(`refund.${whole.order.id}`),
      ).length === 1,
    marked,
  )
  const [entry] = await auditOf(t, whole.workspaceId, 'billing.order.refund')
  t.equal(
    'the order is refunded in full with no refund of its own; the audit says «in the cabinet»; the tariff ended',
    [
      row.status,
      row.yookassa_refund_id,
      row.refunded_amount,
      row.refunded_at !== null,
      entry.meta.cabinet,
      entry.meta.refundId,
      (await subscriptionOf(t, whole.workspaceId)).status,
    ],
    ['refunded', null, PRICE.start, true, true, null, 'cancelled'],
  )
  const once = await t.operator('billing-refund', [
    whole.order.id,
    '--refunded-in-cabinet',
    ...signed('повтор'),
  ])
  t.check(
    'a second run says the order is already returned',
    once.code === 0 &&
      once.stdout.includes(
        'Заказ уже возвращён (возврат из кабинета ЮKassa): второй возврат не создан.',
      ),
    once,
  )
  t.equal(
    'and writes no second refund entry: the audit holds the one of the run that marked the order',
    (await auditOf(t, whole.workspaceId, 'billing.order.refund')).map(({ meta }) => [
      meta.cabinet,
      meta.endSubscription,
    ]),
    [[true, true]],
  )
  await ledgerHolds(t, whole.workspaceId, { tariff: 0, pack: 0 })
  // The first customer's tariff is untouched by all of it.
  await ledgerHolds(t, part.workspaceId, { tariff: CREDITS.start, pack: 0 }, 'the part: ')
}

scenarios['double-payment'] = async (t) => {
  const customer = await t.customer()
  // Two tabs: the customer starts paying for «Старт», then chooses «Бизнес» in another.
  const first = await customer.mutate('billing.startCheckout', {
    planSlug: 'start',
    autoRenew: false,
  })
  const second = await customer.mutate('billing.startCheckout', {
    planSlug: 'business',
    autoRenew: false,
  })
  t.equal(
    'another choice cancels the unfinished order and makes a new one with a page of its own',
    [
      (await orderById(t, first.orderId)).status,
      (await orderById(t, second.orderId)).status,
      first.confirmationUrl !== second.confirmationUrl,
    ],
    ['cancelled', 'pending', true],
  )
  await t.shop.press(second.confirmationUrl)
  await orderBecomes(
    t,
    'the page of «Бизнес» is paid: the payment is applied',
    () => orderById(t, second.orderId),
    'paid',
  )
  const workspaceId = await customer.workspaceId()

  // The first tab is still open, and the customer pays there too.
  await t.shop.press(first.confirmationUrl)
  await t.shop.settle()
  const firstPayment = paymentIdOf(first.confirmationUrl)
  t.equal(
    'the page of «Старт» is paid as well: the shop holds two payments of one customer',
    [
      (await t.shop.object('payments', firstPayment)).status,
      (await t.shop.object('payments', paymentIdOf(second.confirmationUrl))).status,
    ],
    ['succeeded', 'succeeded'],
  )
  const late = await orderById(t, first.orderId)
  const [flagged] = await auditOf(t, workspaceId, 'billing.order.refund_needed')
  t.equal(
    'the second payment applies nothing: its order stays cancelled and an entry asks for the money back',
    [late.status, flagged?.target_id, flagged?.meta.reason],
    ['cancelled', first.orderId, 'order_closed'],
  )
  const accounts = await ledgerHolds(t, workspaceId, { tariff: CREDITS.business, pack: 0 })
  t.equal(
    'one tariff, one quota: «Бизнес», granted once',
    [
      (await t.rows(`SELECT id FROM subscriptions WHERE workspace_id = $1`, [workspaceId])).length,
      (await subscriptionOf(t, workspaceId)).plan,
      journal(accounts.credit_tariff),
    ],
    [1, 'business', [{ kind: 'grant', amount: '800.00', key: `order:${second.orderId}:grant` }]],
  )
  const page = await customer.mutate('billing.syncOrder', { orderId: first.orderId })
  t.equal(
    'the return page of the first tab says the money came and was not applied',
    [page.status, page.refundNeeded],
    ['cancelled', true],
  )

  const listed = await t.operator('billing-refunds-needed', [])
  t.check(
    'billing:refunds-needed lists the second payment: its order, its amount, why, and how to return it',
    listed.code === 0 &&
      listed.stdout.includes('Ожидают возврата: 1.') &&
      listed.stdout.includes(`заказ ${first.orderId} (отменён) · платёж ${firstPayment}`) &&
      listed.stdout.includes(
        'к возврату 4900.00 ₽ из 4900.00 ₽; причина: платёж прошёл после закрытия заказа',
      ) &&
      listed.stdout.includes('как вернуть: в кабинете ЮKassa'),
    listed,
  )
  const byCommand = await t.operator('billing-refund', [first.orderId, ...signed('второй платёж')])
  t.check(
    'billing:refund refuses an order that is not paid in the books: this money goes back in the cabinet',
    byCommand.code === 1 &&
      byCommand.stderr.includes('Заказ не оплачен: вернуть можно только оплаченный заказ.') &&
      (await refundRequests(t)).length === 0,
    byCommand,
  )
  const returned = await t.shop.cabinet('/refunds', {
    payment_id: firstPayment,
    amount: { value: PRICE.start, currency: 'RUB' },
  })
  await t.shop.settle()
  const done = await t.operator('billing-refunds-needed', [])
  t.check(
    'once the owner of the shop has returned it in the cabinet, the list is empty',
    returned.status === 200 && done.stdout.includes('Заказов, ожидающих возврата, нет.'),
    { returned, done },
  )
  t.equal(
    'the tariff the customer paid for is untouched by the refund',
    [(await subscriptionOf(t, workspaceId)).status, (await orderById(t, second.orderId)).status],
    ['active', 'paid'],
  )
  await ledgerHolds(t, workspaceId, { tariff: CREDITS.business, pack: 0 }, 'after the refund ')
}
