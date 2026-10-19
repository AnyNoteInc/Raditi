// Scenarios of a first payment and of a pack: the gift of the registration a customer starts
// with, the checkout, what the shop saves, notifications that race, get lost or are forged, and
// the end of a period that is not renewed.
import { randomUUID } from 'node:crypto'

import {
  DAY,
  MINUTE,
  MIR,
  ON_SALE,
  PRICE,
  CREDITS,
  actionsOf,
  addSite,
  auditOf,
  creditAccounts,
  creditsCount,
  fromNow,
  giftGrant,
  giftKey,
  iso,
  journal,
  journalRow,
  journalsOf,
  ledgerHolds,
  moscowDate,
  notYet,
  orderBecomes,
  orderById,
  orderIsOld,
  ordersOf,
  outboxOf,
  paymentIdOf,
  periodEnded,
  periodEndsAt,
  subscribed,
  subscriptionBecomes,
  subscriptionOf,
} from './scenario-kit.mjs'
import { moscowMonthLater } from './stand.mjs'

export const scenarios = {}

scenarios['signup-gift'] = async (t) => {
  const NOTHING = { balance: 0, held: 0, available: 0 }
  const PROMISED = { balance: CREDITS.gift, held: 0, available: CREDITS.gift, granted: false }
  const GRANTED = { ...PROMISED, granted: true }
  const customer = await t.customer()
  /** What the customer reads of their credits on «Тарифы» and on «Использование». */
  const shown = async () => {
    const overview = await customer.query('billing.overview')
    const usage = await customer.query('billing.usage')
    return {
      tariff: overview.subscription?.plan.slug ?? null,
      credits: creditAccounts(overview.credits),
      usage: [usage.gift, usage.pack, usage.totalLeft],
    }
  }
  /** Every journal row under the key of the customer's gift, on whichever account it stands. */
  const giftRows = () =>
    t.rows(
      `SELECT l.kind::text AS kind, l.amount::text AS amount, l.balance_after::text AS balance_after,
         l.order_id, a.workspace_id, a.unit::text AS unit
       FROM credit_ledger l JOIN billing_accounts a ON a.id = l.account_id
       WHERE l.idempotency_key = $1 ORDER BY l.created_at, l.id`,
      [giftKey(customer.id)],
    )

  // Registered, no site yet: there is no workspace and so no account to hold the gift.
  t.equal(
    'a new customer reads the gift of the registration as promised: 35 credits, not granted yet',
    await shown(),
    {
      tariff: null,
      credits: { tariff: NOTHING, gift: PROMISED, pack: NOTHING, totalAvailable: 35 },
      usage: [{ left: 35, held: 0, granted: false }, { left: 0, held: 0 }, 35],
    },
  )
  t.equal(
    'nothing is stored for the promise: no workspace and no journal row',
    [
      await t.rows(`SELECT id FROM workspaces WHERE created_by_id = $1`, [customer.id]),
      await giftRows(),
    ],
    [[], []],
  )

  // The first site makes the workspace, and the gift is granted with it. A site is added the one
  // way the product has: the wizard checks its files, and the access goes to Vault.
  const address = `https://gift-${randomUUID()}.example.ru`
  const { project: site, request } = await addSite(t, customer, {
    name: 'Кофейня',
    url: address,
  })
  const workspaceId = await customer.workspaceId()
  const granted = [
    {
      kind: 'grant',
      amount: '35.00',
      balance_after: '35.00',
      order_id: null,
      workspace_id: workspaceId,
      unit: 'credit_gift',
    },
  ]
  let accounts = await ledgerHolds(t, workspaceId, { tariff: 0, pack: 0 }, 'the first site: ')
  t.equal(
    'the first site: the gift is granted once, to the gift account of the workspace, under the key of the user and paid for by no order',
    await giftRows(),
    granted,
  )
  t.equal(
    'the first site: the accounts of the tariff and of the pack are made empty beside it',
    [journal(accounts.credit_tariff), journal(accounts.credit_pack)],
    [[], []],
  )
  const entries = await auditOf(t, workspaceId, 'billing.gift.grant')
  t.equal(
    'the first site: the audit holds the grant — by the platform, for the gift account, with the user and the credits',
    entries.map(({ actor_type: actor, target_type: target, meta }) => ({ actor, target, meta })),
    [{ actor: 'system', target: 'billing_account', meta: { userId: customer.id, credits: 35 } }],
  )
  // The letter that greeted the customer named the same number, in words the stand writes itself.
  const [welcome, ...otherWelcomes] = await t.until(
    'the welcome letter of the customer',
    async () => {
      const letters = await customer.mail('auth.welcome')
      return letters.length > 0 ? letters : null
    },
    { silent: true },
  )
  t.check(
    'the first site: the welcome letter promised what was granted — «Мы дарим вам 35 кредитов, чтобы попробовать…»',
    otherWelcomes.length === 0 &&
      welcome?.text.includes(
        `Мы дарим вам ${creditsCount(Number(granted[0].amount))}, чтобы попробовать: их хватит на семь небольших правок или на две-три задачи побольше.`,
      ),
    welcome,
  )
  t.equal(
    'the first site: the promise is kept to the credit — the same 35, now granted',
    await shown(),
    {
      tariff: null,
      credits: { tariff: NOTHING, gift: GRANTED, pack: NOTHING, totalAvailable: 35 },
      usage: [{ left: 35, held: 0, granted: true }, { left: 0, held: 0 }, 35],
    },
  )
  // What the site was made with: the access is in Vault, the database names where it is, and
  // the first import of the files is queued with it — a stage of the site, not a task.
  t.equal(
    'the first site: the access to its files is in Vault, and the database holds only where — kv/sites/<site>/ssh, version 1',
    [
      await t.rows(
        `SELECT kind::text AS kind, vault_path, key_version, workspace_id FROM credential_refs
         WHERE site_id = $1`,
        [site.id],
      ),
      await t.vaultVersion(`kv/sites/${site.id}/ssh`),
      await t.rows(
        `SELECT kind::text AS kind, host, port, root_path, host_key FROM site_code_sources
         WHERE site_id = $1`,
        [site.id],
      ),
    ],
    [
      [
        {
          kind: 'ssh',
          vault_path: `kv/sites/${site.id}/ssh`,
          key_version: 1,
          workspace_id: workspaceId,
        },
      ],
      1,
      [
        {
          kind: 'sftp',
          host: t.site.host,
          port: t.site.port,
          root_path: t.site.rootPath,
          host_key: t.site.hostKey,
        },
      ],
    ],
  )
  // Core takes the import and ends it at once: the stand gives it no git to keep a repository
  // in. Whatever becomes of the import, it is no task and spends nothing.
  await t.until(
    'the first import of the files ends without a repository: core has no git in the stand',
    async () => {
      const stage = await t.one(
        `SELECT stage::text AS stage, status::text AS status, error_code
         FROM site_provisioning_stages WHERE site_id = $1`,
        [site.id],
      )
      return stage?.status === 'failed' &&
        stage.stage === 'code_import' &&
        stage.error_code === 'repository_not_configured'
        ? stage
        : notYet(stage)
    },
  )
  t.equal(
    'the import of the site is no task and takes nothing: no task, nothing set aside, the gift whole',
    [
      await t.rows(`SELECT id FROM tasks WHERE workspace_id = $1`, [workspaceId]),
      await t.rows(
        `SELECT h.id FROM credit_holds h JOIN billing_accounts a ON a.id = h.account_id
         WHERE a.workspace_id = $1`,
        [workspaceId],
      ),
      await giftRows(),
    ],
    [[], [], granted],
  )
  const sites = async () =>
    (await t.rows(`SELECT id FROM sites WHERE workspace_id = $1`, [workspaceId])).map(
      ({ id }) => id,
    )
  // The answer of «Добавить проект» was lost, and the wizard sends the same request again.
  t.equal(
    'the same request again — its answer lost — finds the same site and grants nothing more',
    [await customer.mutate('project.create', request), await giftRows(), await sites()],
    [{ outcome: 'created', project: site }, granted, [site.id]],
  )
  const logins = t.site.logins()
  t.equal(
    'a site that is refused — the same address again — grants nothing more: «Далее» and «Добавить проект» say it is there, and nobody logs in to its server',
    [
      await customer.refusal('siteConnection.checkBasics', {
        name: 'Кофейня',
        url: address,
        stack: 'wordpress',
      }),
      await customer.refusal('project.create', { ...request, requestKey: randomUUID() }),
      t.site.logins() - logins,
      await giftRows(),
      await sites(),
    ],
    [
      { status: 409, code: 'PROJECT_ALREADY_EXISTS' },
      { status: 409, code: 'PROJECT_ALREADY_EXISTS' },
      0,
      granted,
      [site.id],
    ],
  )

  // A tariff is paid for: the checkout finds the workspace and its gift, and adds nothing to it.
  const checkout = await customer.mutate('billing.startCheckout', {
    planSlug: 'start',
    autoRenew: false,
  })
  // Under the key of the user, and under any other: the journal of the gift account is one row.
  t.equal(
    'the checkout of a tariff grants no second gift',
    [await giftRows(), (await journalsOf(t, workspaceId)).gift],
    [granted, [giftGrant(customer.id)]],
  )
  await t.shop.press(checkout.confirmationUrl)
  const order = await orderBecomes(
    t,
    'the tariff is paid for',
    () => orderById(t, checkout.orderId),
    'paid',
  )
  await t.shop.settle()
  const subscription = await subscriptionOf(t, workspaceId)
  accounts = await ledgerHolds(
    t,
    workspaceId,
    { tariff: CREDITS.start, pack: 0 },
    'with a tariff: ',
  )
  t.equal(
    'with a tariff: the quota is granted beside the gift, and the gift is the one row it was',
    [journal(accounts.credit_tariff), await giftRows()],
    [[{ kind: 'grant', amount: '300.00', key: `order:${order.id}:grant` }], granted],
  )
  t.equal(
    'with a tariff: the audit holds one grant of the gift beside the site and the start of the tariff',
    await actionsOf(t, workspaceId),
    ['billing.gift.grant', 'billing.subscription.start', 'site.create'],
  )
  t.equal(
    'with a tariff: «Тарифы» and «Использование» count the gift beside the quota — 335 credits',
    await shown(),
    {
      tariff: 'start',
      credits: {
        tariff: { balance: 300, held: 0, available: 300 },
        gift: GRANTED,
        pack: NOTHING,
        totalAvailable: 335,
      },
      usage: [{ left: 35, held: 0, granted: true }, { left: 0, held: 0 }, 335],
    },
  )

  // The period ends and the tariff with it: what is left of the quota expires, the gift does not.
  const dates = await periodEnded(t, subscription.id)
  await subscriptionBecomes(t, 'the tariff ends with its period', workspaceId, 'cancelled')
  accounts = await ledgerHolds(t, workspaceId, { tariff: 0, pack: 0 }, 'after the tariff: ')
  t.equal(
    'after the tariff: the rest of the quota expired under the key of the period, and the gift is on its account, untouched',
    [journal(accounts.credit_tariff).map(({ kind, key }) => [kind, key]), await giftRows()],
    [
      [
        ['grant', `order:${order.id}:grant`],
        ['expire', `sub:${subscription.id}:${dates.end.getTime()}:expire`],
      ],
      granted,
    ],
  )
  t.equal(
    'after the tariff: of the three accounts only the tariff lost anything — the gift is its one grant, the pack is empty',
    await journalsOf(t, workspaceId),
    {
      tariff: [journalRow.quota(order), journalRow.expired(subscription, dates.end)],
      gift: [giftGrant(customer.id)],
      pack: [],
    },
  )
  t.equal(
    'after the tariff: the customer still has the 35 gift credits, and nothing of the tariff',
    await shown(),
    {
      tariff: null,
      credits: { tariff: NOTHING, gift: GRANTED, pack: NOTHING, totalAvailable: 35 },
      usage: [{ left: 35, held: 0, granted: true }, { left: 0, held: 0 }, 35],
    },
  )

  // Another customer, who pays first and adds no site: the checkout makes the workspace, and
  // the gift is granted with it whatever becomes of the payment.
  const payer = await t.customer()
  const refused = await payer.mutate('billing.startCheckout', {
    planSlug: 'start',
    autoRenew: false,
  })
  await t.shop.press(refused.confirmationUrl, 'refuse')
  await orderBecomes(
    t,
    'a customer who pays first refuses on the page of the shop: the order fails',
    () => orderById(t, refused.orderId),
    'failed',
  )
  await t.shop.settle()
  await ledgerHolds(t, await payer.workspaceId(), { tariff: 0, pack: 0 }, 'pays first: ')
  const payerOverview = await payer.query('billing.overview')
  t.equal(
    'pays first: the gift was granted with the workspace the checkout made, and the failed payment took nothing of it',
    [payerOverview.subscription, payerOverview.credits.gift, payerOverview.credits.totalAvailable],
    [null, GRANTED, 35],
  )

  // And one who only registered: nothing is stored, the gift stays promised. The pages of this
  // customer are compared with the database when the scenario is over.
  const onlooker = await t.customer()
  t.equal(
    'a customer who only registered still reads the gift as promised',
    (await onlooker.query('billing.overview')).credits.gift,
    PROMISED,
  )
}

scenarios.checkout = async (t) => {
  for (const autoRenew of [true, false]) {
    const who = autoRenew ? 'with the consent' : 'without the consent'
    const customer = await t.customer()
    const before = await customer.query('billing.overview')
    t.equal(
      `${who}: a new customer has no tariff and no credits but the promised gift, and payments are on`,
      {
        paymentsEnabled: before.paymentsEnabled,
        subscription: before.subscription,
        total: before.credits.totalAvailable,
        ended: before.ended,
      },
      { paymentsEnabled: true, subscription: null, total: CREDITS.gift, ended: null },
    )
    const { plans, pack } = await customer.query('billing.plans')
    t.equal(
      `${who}: «Тарифы» sells the seeded tariffs and the pack at their prices`,
      {
        start: plans.find(({ slug }) => slug === 'start')?.price,
        business: plans.find(({ slug }) => slug === 'business')?.price,
        pack: pack?.price,
      },
      PRICE,
    )
    t.equal(
      `${who}: and in credits — 300, 800 and 2 500 a month with 50, 100 and 300 a day, a pack of 100`,
      {
        plans: plans.map(({ slug, price, creditsPerMonth, creditsPerDay, maxSites }) => ({
          slug,
          price,
          creditsPerMonth,
          creditsPerDay,
          maxSites,
        })),
        pack: pack && { slug: pack.slug, price: pack.price, credits: pack.credits },
      },
      ON_SALE,
    )

    const checkout = await customer.mutate('billing.startCheckout', {
      planSlug: 'start',
      autoRenew,
    })
    const paymentId = paymentIdOf(checkout.confirmationUrl)
    t.equal(
      `${who}: the checkout sends the customer to the page of the shop`,
      checkout.confirmationUrl,
      `${t.shop.url}/pay/${paymentId}`,
    )
    const created = (await t.shop.sent('POST', '/v3/payments')).at(-1)
    const returnUrl = `${t.webUrl}/settings/billing/return?order=${checkout.orderId}`
    t.equal(
      `${who}: the payment asks to save the method exactly as the customer agreed, and carries no receipt`,
      {
        amount: created.body.amount,
        capture: created.body.capture,
        save: created.body.save_payment_method,
        receipt: created.body.receipt,
        confirmation: created.body.confirmation,
        order: created.body.metadata?.order_id,
      },
      {
        amount: { value: PRICE.start, currency: 'RUB' },
        capture: true,
        save: autoRenew,
        receipt: undefined,
        confirmation: { type: 'redirect', return_url: returnUrl },
        order: checkout.orderId,
      },
    )
    const pending = await orderById(t, checkout.orderId)
    t.equal(
      `${who}: the order waits for its payment`,
      { status: pending.status, amount: pending.amount, save: pending.save_payment_method },
      { status: 'pending', amount: PRICE.start, save: autoRenew },
    )

    t.equal(
      `${who}: the shop sends the buyer back to the return page of the order`,
      await t.shop.press(checkout.confirmationUrl),
      returnUrl,
    )
    await t.shop.settle()
    t.equal(
      `${who}: web took the notification of the payment`,
      await t.shop.deliveries(paymentId),
      [{ event: 'payment.succeeded', status: 200 }],
    )

    const order = await orderById(t, checkout.orderId)
    const workspaceId = await customer.workspaceId()
    const subscription = await subscriptionOf(t, workspaceId)
    t.equal(
      `${who}: the order is paid for the period the tariff now has`,
      {
        status: order.status,
        paid: order.paid_at !== null,
        payment: order.yookassa_payment_id,
        period: [iso(order.period_start), iso(order.period_end)],
      },
      {
        status: 'paid',
        paid: true,
        payment: paymentId,
        period: [iso(subscription.current_period_start), iso(subscription.current_period_end)],
      },
    )
    t.equal(
      `${who}: the tariff is active for a month by the Moscow calendar from the payment`,
      {
        status: subscription.status,
        plan: subscription.plan,
        anchor: iso(subscription.period_anchor),
        end: iso(subscription.current_period_end),
        pastDue: subscription.past_due_since,
      },
      {
        status: 'active',
        plan: 'start',
        anchor: iso(subscription.current_period_start),
        end: iso(moscowMonthLater(subscription.period_anchor, subscription.current_period_start)),
        pastDue: null,
      },
    )
    t.check(
      `${who}: the period started when the payment was made`,
      Math.abs(subscription.current_period_start.getTime() - Date.now()) < MINUTE,
      subscription,
    )
    const accounts = await ledgerHolds(
      t,
      workspaceId,
      { tariff: CREDITS.start, pack: 0 },
      `${who}: `,
    )
    t.equal(
      `${who}: the quota is granted once, under the key of the order`,
      journal(accounts.credit_tariff),
      [{ kind: 'grant', amount: '300.00', key: `order:${order.id}:grant` }],
    )
    t.equal(
      `${who}: the payment method is stored ${autoRenew ? 'with the consent' : 'for nobody: auto-renewal is off'}`,
      {
        id: subscription.payment_method_id,
        title: subscription.payment_method_title,
        type: subscription.payment_method_type,
        card: subscription.payment_method_card_type,
        last4: subscription.payment_method_last4,
        off: subscription.cancel_at_period_end,
      },
      autoRenew
        ? {
            id: paymentId,
            title: 'Bank card *4444',
            type: 'bank_card',
            card: 'Mir',
            last4: '4444',
            off: false,
          }
        : { id: null, title: null, type: null, card: null, last4: null, off: true },
    )
    t.equal(
      `${who}: the audit holds the gift the checkout granted with the workspace, the start of the tariff${autoRenew ? ' and the consent to auto-renewal' : ' and no consent'}`,
      await actionsOf(t, workspaceId),
      [
        ...(autoRenew ? ['billing.auto_renewal.consent'] : []),
        'billing.gift.grant',
        'billing.subscription.start',
      ],
    )
    await t.until(`${who}: the customer gets one letter «Оплата прошла»`, async () =>
      customer.got('Оплата прошла'),
    )
    t.equal(
      `${who}: the letter left the outbox once, under the key of the order`,
      await outboxOf(t, 'billing.payment_succeeded', order.id),
      ['published'],
    )
    const [letter, ...otherLetters] = await customer.mail('billing.payment_succeeded')
    t.equal(
      `${who}: the letter is made of what was paid for: the tariff, the money, the end of the period and the 300 credits granted`,
      [letter?.data, otherLetters.length],
      [
        {
          to: customer.email,
          item: 'plan',
          planName: 'Старт',
          amount: PRICE.start,
          periodEnd: iso(subscription.current_period_end),
          credits: Number(journal(accounts.credit_tariff)[0].amount),
          appUrl: t.webUrl,
        },
        0,
      ],
    )
    const until = moscowDate(subscription.current_period_end)
    t.check(
      `${who}: and says so to the customer: «Тариф действует до ${until}. Начислили 300 кредитов на этот период.»`,
      letter.text.includes('Оплата прошла: тариф «Старт» — 4 900 ₽.') &&
        letter.text.includes(
          `Тариф действует до ${until}. Начислили 300 кредитов на этот период.`,
        ) &&
        letter.text.includes(`${t.webUrl}/settings/plans`),
      letter.text,
    )

    const synced = await customer.mutate('billing.syncOrder', { orderId: order.id })
    t.equal(
      `${who}: the return page shows the paid order and the tariff`,
      {
        status: synced.status,
        kind: synced.kind,
        plan: synced.planName,
        amount: synced.amount,
        refundNeeded: synced.refundNeeded,
        tariff: synced.subscription?.status,
      },
      {
        status: 'paid',
        kind: 'subscription',
        plan: 'Старт',
        amount: PRICE.start,
        refundNeeded: false,
        tariff: 'active',
      },
    )
    const overview = await customer.query('billing.overview')
    t.equal(
      `${who}: «Тарифы» shows the tariff, ${autoRenew ? 'auto-renewal and the card' : 'no auto-renewal and no card'}`,
      {
        status: overview.subscription.status,
        plan: overview.subscription.plan.slug,
        end: overview.subscription.period.end,
        autoRenewal: overview.subscription.autoRenewal,
        method: overview.subscription.paymentMethod,
        credits: creditAccounts(overview.credits),
        waits: [overview.bindingPending, overview.renewalCharge],
      },
      {
        status: 'active',
        plan: 'start',
        end: iso(subscription.current_period_end),
        autoRenewal: autoRenew,
        method: autoRenew ? { label: MIR } : null,
        credits: {
          tariff: { balance: 300, held: 0, available: 300 },
          // The gift of the registration: the checkout granted it with the workspace.
          gift: { balance: 35, held: 0, available: 35, granted: true },
          pack: { balance: 0, held: 0, available: 0 },
          totalAvailable: 335,
        },
        waits: [false, 'none'],
      },
    )
    const history = await customer.query('billing.payments', {})
    t.equal(
      `${who}: «Оплата» lists one paid order of 4900.00`,
      history.items.map(({ id, kind, planName, amount, status, failureText, refundedAmount }) => ({
        id,
        kind,
        planName,
        amount,
        status,
        failureText,
        refundedAmount,
      })),
      [
        {
          id: order.id,
          kind: 'subscription',
          planName: 'Старт',
          amount: PRICE.start,
          status: 'paid',
          failureText: null,
          refundedAmount: null,
        },
      ],
    )
    const usage = await customer.query('billing.usage')
    t.equal(
      `${who}: «Использование» shows the whole quota as left, and the gift beside it`,
      {
        credits: usage.tariff.credits,
        today: usage.tariff.today,
        sites: usage.tariff.sites,
        gift: usage.gift,
        pack: usage.pack,
        total: usage.totalLeft,
      },
      {
        // Read from the ledger: the order of the payment carries the start of its period.
        credits: { granted: 300, charged: 0, held: 0, expired: 0, left: 300, heldEarlier: 0 },
        // «Старт» gives 50 of its tariff credits a day; none is spent yet.
        today: { limit: 50, charged: 0, held: 0, used: 0, room: 50, left: 50 },
        sites: { count: 0, max: 1 },
        gift: { left: 35, held: 0, granted: true },
        pack: { left: 0, held: 0 },
        total: 335,
      },
    )

    // The notification again, as ЮKassa repeats one: nothing is granted twice.
    const again = await t.shop.control('notify', { paymentId })
    t.equal(`${who}: a repeated notification is answered 200`, again.status, 200)
    await ledgerHolds(
      t,
      workspaceId,
      { tariff: CREDITS.start, pack: 0 },
      `${who}: after the repeat `,
    )
    t.equal(
      `${who}: a second tariff cannot be bought on top of a live one`,
      await customer.refusal('billing.startCheckout', { planSlug: 'business', autoRenew }),
      { status: 409, code: 'BILLING_SUBSCRIPTION_EXISTS' },
    )
  }
}

scenarios['saved-without-consent'] = async (t) => {
  // The buyer ticked «сохранить карту» on the form of ЮKassa: the shop never asked for it.
  await t.shop.control('save-anyway', { enabled: true })
  const customer = await t.customer()
  const checkout = await customer.mutate('billing.startCheckout', {
    planSlug: 'start',
    autoRenew: false,
  })
  const paymentId = paymentIdOf(checkout.confirmationUrl)
  t.equal(
    'the payment says save_payment_method: false in so many words',
    (await t.shop.sent('POST', '/v3/payments')).at(-1).body.save_payment_method,
    false,
  )
  await t.shop.press(checkout.confirmationUrl)
  await orderBecomes(t, 'the order is paid', () => orderById(t, checkout.orderId), 'paid')
  const payment = await t.shop.object('payments', paymentId)
  t.equal(
    'the shop answers with a saved method all the same',
    { status: payment.status, saved: payment.payment_method.saved, id: payment.payment_method.id },
    { status: 'succeeded', saved: true, id: paymentId },
  )
  const workspaceId = await customer.workspaceId()
  const subscription = await subscriptionOf(t, workspaceId)
  t.equal(
    'the tariff is on, no payment method is stored and auto-renewal is off',
    {
      status: subscription.status,
      method: [
        subscription.payment_method_id,
        subscription.payment_method_title,
        subscription.payment_method_type,
        subscription.payment_method_card_type,
        subscription.payment_method_last4,
      ],
      off: subscription.cancel_at_period_end,
    },
    { status: 'active', method: [null, null, null, null, null], off: true },
  )
  t.equal('the audit holds no consent to auto-renewal', await actionsOf(t, workspaceId), [
    'billing.gift.grant',
    'billing.subscription.start',
  ])
  const overview = await customer.query('billing.overview')
  t.equal(
    '«Тарифы» shows no card and no auto-renewal',
    [overview.subscription.autoRenewal, overview.subscription.paymentMethod],
    [false, null],
  )

  // The period ends: a method nobody agreed to is never charged.
  await periodEndsAt(t, subscription.id, fromNow(2 * DAY))
  await t.passes(['notices'])
  t.equal(
    'no notice of a charge goes out before the end of the period',
    [
      (await subscriptionOf(t, workspaceId)).renewal_notice_period_end,
      customer.letters('Скоро спишем 4 900 ₽ за тариф «Старт»').length,
    ],
    [null, 0],
  )
  await periodEnded(t, subscription.id)
  await subscriptionBecomes(t, 'the tariff ends with its period', workspaceId, 'cancelled')
  t.equal('the method the shop saved was never charged', (await t.shop.charges()).length, 0)
}

scenarios['autopayments-not-approved'] = async (t) => {
  // ЮKassa has not approved autopayments for the shop, while web and core run with
  // YOOKASSA_AUTOPAYMENTS on (unset outside production): what a real shop did on its first day
  // (AnyNote, 13.05.2026). The same shop with the switch off is the business of the package,
  // router and component tests: the stand runs one web.
  t.equal(
    'the shop loses the right to autopayments',
    await t.shop.control('autopayments', { enabled: false }),
    { autopayments: false },
  )
  const customer = await t.customer()
  const before = await customer.query('billing.overview')
  t.equal(
    'web still offers auto-renewal: its switch is on',
    [before.paymentsEnabled, before.autoRenewalAvailable],
    [true, true],
  )
  const lettersBefore = customer.subjects()

  t.equal(
    'the customer who ticked auto-renewal is refused: payments are unavailable, not an error of ours',
    await customer.refusal('billing.startCheckout', { planSlug: 'start', autoRenew: true }),
    { status: 503, code: 'BILLING_PAYMENTS_NOT_CONFIGURED' },
  )
  const refused = await t.shop.sent('POST', '/v3/payments')
  t.equal(
    'the shop answered 403 to the one request that asked to save the method, and was not asked again',
    refused.map(({ status, body }) => [status, body.save_payment_method]),
    [[403, true]],
  )
  const workspaceId = await customer.workspaceId()
  const [failed, ...others] = await ordersOf(t, workspaceId)
  t.equal(
    'no order stays pending: the one that was made is closed as refused by the shop',
    {
      others,
      status: failed.status,
      reason: failed.failure_reason,
      payment: failed.yookassa_payment_id,
      paid: failed.paid_at,
      save: failed.save_payment_method,
    },
    {
      others: [],
      status: 'failed',
      reason: 'checkout_rejected',
      payment: null,
      paid: null,
      save: true,
    },
  )
  const state = await t.shop.state()
  t.equal(
    'nothing is charged: the shop holds no payment, no saved method and sent no notification',
    [state.payments, state.savedMethodIds, state.webhooks.deliveries],
    [[], [], []],
  )
  // The checkout made the workspace, so the gift the customer was promised is on its account
  // now: the same credits as before, granted, and not one more.
  t.equal(
    'no tariff, no credit more than before and no letter about a payment',
    [
      await subscriptionOf(t, workspaceId),
      (await customer.query('billing.overview')).credits,
      await outboxOf(t, 'billing.payment_succeeded', failed.id),
      customer.subjects(),
    ],
    [
      null,
      { ...before.credits, gift: { ...before.credits.gift, granted: true } },
      [],
      lettersBefore,
    ],
  )

  // The same customer pays without the tick: an explicit `false` is what such a shop takes
  // (an assumption of the fake; a real shop is only known to take a payment without the field).
  const checkout = await customer.mutate('billing.startCheckout', {
    planSlug: 'start',
    autoRenew: false,
  })
  t.check('the checkout without the tick is a new order', checkout.orderId !== failed.id, checkout)
  const paymentId = paymentIdOf(checkout.confirmationUrl)
  t.equal(
    'the second request says save_payment_method: false and is taken',
    (await t.shop.sent('POST', '/v3/payments')).map(({ status, body }) => [
      status,
      body.save_payment_method,
    ]),
    [
      [403, true],
      [200, false],
    ],
  )
  await t.shop.press(checkout.confirmationUrl)
  const paid = await orderBecomes(
    t,
    'the order without the tick is paid',
    () => orderById(t, checkout.orderId),
    'paid',
  )
  await t.shop.settle()
  t.equal('web took the notification of the payment', await t.shop.deliveries(paymentId), [
    { event: 'payment.succeeded', status: 200 },
  ])
  const subscription = await subscriptionOf(t, workspaceId)
  t.equal(
    'the tariff is on for a month, with no payment method and no auto-renewal',
    {
      status: subscription.status,
      plan: subscription.plan,
      end: iso(subscription.current_period_end),
      method: subscription.payment_method_id,
      off: subscription.cancel_at_period_end,
    },
    {
      status: 'active',
      plan: 'start',
      end: iso(moscowMonthLater(subscription.period_anchor, subscription.current_period_start)),
      method: null,
      off: true,
    },
  )
  const accounts = await ledgerHolds(t, workspaceId, { tariff: CREDITS.start, pack: 0 })
  t.equal(
    'the quota is granted once, under the key of the paid order',
    journal(accounts.credit_tariff),
    [{ kind: 'grant', amount: '300.00', key: `order:${paid.id}:grant` }],
  )
  await t.until('the customer gets one letter «Оплата прошла»', async () =>
    customer.got('Оплата прошла'),
  )
  const history = await customer.query('billing.payments', {})
  t.equal(
    '«Оплата» lists both orders: the refused one and the paid one',
    history.items.map(({ id, status }) => [id, status]).sort(),
    [
      [failed.id, 'failed'],
      [paid.id, 'paid'],
    ].sort(),
  )

  // The page still offers «Включить автопродление»: the shop refuses to bind a card as well.
  t.equal(
    'switching auto-renewal on and binding a card are refused the same way',
    [
      await customer.refusal('billing.resumeAutoRenew', {}),
      await customer.refusal('billing.startPaymentMethodChange', {}),
    ],
    [
      { status: 503, code: 'BILLING_PAYMENTS_NOT_CONFIGURED' },
      { status: 503, code: 'BILLING_PAYMENTS_NOT_CONFIGURED' },
    ],
  )
  t.equal(
    'the shop answered 403 to both bindings and holds none',
    [
      (await t.shop.sent('POST', '/v3/payment_methods')).map(({ status }) => status),
      (await t.shop.state()).paymentMethods,
    ],
    [[403, 403], []],
  )
  const after = await subscriptionOf(t, workspaceId)
  t.equal(
    'the tariff waits for no binding and renews nothing; the audit holds its start alone',
    [
      after.pending_payment_method_id,
      after.payment_method_id,
      after.cancel_at_period_end,
      await actionsOf(t, workspaceId),
    ],
    [null, null, true, ['billing.gift.grant', 'billing.subscription.start']],
  )
  t.equal('nothing was charged by itself', (await t.shop.charges()).length, 0)
}

scenarios['webhook-and-return'] = async (t) => {
  await t.shop.hold()
  const customer = await t.customer()
  const checkout = await customer.mutate('billing.startCheckout', {
    planSlug: 'start',
    autoRenew: true,
  })
  const paymentId = paymentIdOf(checkout.confirmationUrl)
  await t.shop.press(checkout.confirmationUrl)
  t.equal(
    'the payment went through at the shop and nobody has told web yet',
    [
      (await t.shop.object('payments', paymentId)).status,
      (await orderById(t, checkout.orderId)).status,
    ],
    ['succeeded', 'pending'],
  )

  // The notification and the polls of the return page arrive in the same instant.
  const [notification, ...polls] = await Promise.all([
    t.shop.control('notify', { paymentId }),
    ...Array.from({ length: 6 }, () =>
      customer.mutate('billing.syncOrder', { orderId: checkout.orderId }),
    ),
  ])
  t.equal('the notification is answered 200', notification.status, 200)
  t.equal(
    'every poll of the return page shows the order paid',
    polls.map(({ status, refundNeeded }) => [status, refundNeeded]),
    polls.map(() => ['paid', false]),
  )
  const workspaceId = await customer.workspaceId()
  const accounts = await ledgerHolds(t, workspaceId, { tariff: CREDITS.start, pack: 0 })
  t.equal('the quota was granted once', journal(accounts.credit_tariff), [
    { kind: 'grant', amount: '300.00', key: `order:${checkout.orderId}:grant` },
  ])
  t.equal(
    'one subscription was started, with one entry of its start and one consent',
    [
      (await t.rows(`SELECT id FROM subscriptions WHERE workspace_id = $1`, [workspaceId])).length,
      await actionsOf(t, workspaceId),
    ],
    [1, ['billing.auto_renewal.consent', 'billing.gift.grant', 'billing.subscription.start']],
  )
  await t.until('one letter «Оплата прошла» is sent', async () => customer.got('Оплата прошла'))
  await t.passes(['stuck_orders'], 1)
  t.equal(
    'and it stays one: one row in the outbox, one letter',
    [
      await outboxOf(t, 'billing.payment_succeeded', checkout.orderId),
      customer.letters('Оплата прошла').length,
    ],
    [['published'], 1],
  )
}

scenarios['webhook-lost'] = async (t) => {
  // No notification reaches web in this scenario.
  await t.shop.hold()

  // The customer comes back to the return page, which asks the shop itself.
  const returning = await t.customer()
  const first = await returning.mutate('billing.startCheckout', {
    planSlug: 'start',
    autoRenew: true,
  })
  await t.shop.press(first.confirmationUrl)
  t.equal(
    'the return page: before it asks, the order is unpaid and there is no tariff',
    [
      (await orderById(t, first.orderId)).status,
      (await returning.query('billing.overview')).subscription,
    ],
    ['pending', null],
  )
  const synced = await returning.mutate('billing.syncOrder', { orderId: first.orderId })
  t.equal(
    'the return page: its poll reads the payment back and applies it to the order',
    [synced.status, synced.subscription?.status, synced.refundNeeded],
    ['paid', 'active', false],
  )
  await ledgerHolds(
    t,
    await returning.workspaceId(),
    { tariff: CREDITS.start, pack: 0 },
    'the return page: ',
  )

  // The customer closes the browser on the page of the shop: only the scheduler is left.
  const gone = await t.customer()
  const second = await gone.mutate('billing.startCheckout', { planSlug: 'start', autoRenew: false })
  const paymentId = paymentIdOf(second.confirmationUrl)
  await t.shop.press(second.confirmationUrl)
  await t.passes(['stuck_orders'])
  t.equal(
    'the pass of stuck orders leaves a payment that is younger than five minutes alone',
    (await orderById(t, second.orderId)).status,
    'pending',
  )
  await orderIsOld(t, second.orderId, 6 * MINUTE)
  await orderBecomes(
    t,
    'six minutes later the pass of stuck orders reads the payment back and applies it to the order',
    () => orderById(t, second.orderId),
    'paid',
  )
  const workspaceId = await gone.workspaceId()
  await ledgerHolds(t, workspaceId, { tariff: CREDITS.start, pack: 0 }, 'the pass: ')
  t.equal('the pass: the tariff is active', (await subscriptionOf(t, workspaceId)).status, 'active')
  await t.until('the pass: the customer gets the letter «Оплата прошла»', async () =>
    gone.got('Оплата прошла'),
  )
  t.equal(
    'neither notification was ever delivered',
    [
      await t.shop.deliveries(paymentIdOf(first.confirmationUrl)),
      await t.shop.deliveries(paymentId),
      t.webLog().includes(paymentId),
    ],
    [
      [{ event: 'payment.succeeded', withheld: true }],
      [{ event: 'payment.succeeded', withheld: true }],
      false,
    ],
  )
}

scenarios['webhook-forged'] = async (t) => {
  await t.shop.hold()
  const webhook = `${t.webUrl}/api/webhooks/yookassa`
  const post = async (headers, body) => {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    })
    return response.status
  }

  // A real payment, made and not yet notified of.
  const paid = await t.customer()
  const real = await paid.mutate('billing.startCheckout', { planSlug: 'start', autoRenew: true })
  const realPayment = paymentIdOf(real.confirmationUrl)
  await t.shop.press(real.confirmationUrl)
  const body = JSON.stringify({
    type: 'notification',
    event: 'payment.succeeded',
    object: await t.shop.object('payments', realPayment),
  })

  const foreign = await t.shop.control('notify', {
    paymentId: realPayment,
    forwardedFor: '203.0.113.9',
  })
  t.equal(
    'a true notification from an address outside the list is refused with 403',
    foreign.status,
    403,
  )
  t.equal(
    'so is one whose X-Forwarded-For is a list: its first entry is what the sender wrote',
    await post({ 'x-forwarded-for': '127.0.0.1, 203.0.113.9' }, body),
    403,
  )
  t.equal(
    'a body that is not a notification is refused with 400, from the allowed address too',
    [
      await post({ 'x-forwarded-for': '127.0.0.1' }, '{not json'),
      await post(
        { 'x-forwarded-for': '127.0.0.1' },
        JSON.stringify({ type: 'notification', event: 'payment.succeeded', object: {} }),
      ),
    ],
    [400, 400],
  )
  t.equal(
    'after all of them the paid order is still unapplied',
    [
      (await orderById(t, real.orderId)).status,
      (await paid.query('billing.overview')).subscription,
    ],
    ['pending', null],
  )

  // A payment nobody has made: the page of the shop is still open.
  const unpaid = await t.customer()
  const open = await unpaid.mutate('billing.startCheckout', {
    planSlug: 'business',
    autoRenew: false,
  })
  const openPayment = paymentIdOf(open.confirmationUrl)
  const forged = await t.shop.control('notify', {
    paymentId: openPayment,
    event: 'payment.succeeded',
    object: { status: 'succeeded', paid: true },
  })
  t.equal('a forged «succeeded» from the allowed address is taken with 200', forged.status, 200)
  t.equal(
    'and changes nothing: web read the payment back, the shop says pending',
    [
      (await orderById(t, open.orderId)).status,
      (await unpaid.query('billing.overview')).subscription,
      t.webLog().includes(`[yookassa] payment.succeeded for ${openPayment}: order pending`),
    ],
    ['pending', null, true],
  )
  const invented = randomUUID()
  const unknown = await t.shop.control('notify', {
    paymentId: openPayment,
    event: 'payment.succeeded',
    object: { id: invented, status: 'succeeded', paid: true },
  })
  t.equal(
    'a notification of a payment the shop never made is taken, asked about once and dropped',
    [
      unknown.status,
      (await t.shop.sent('GET', `/v3/payments/${invented}`)).map(({ status }) => status),
      t.webLog().includes(`[yookassa] payment.succeeded for ${invented}: order unknown`),
    ],
    [200, [404], true],
  )

  // The true notification applies the payment to its order; a forged «canceled» then takes
  // nothing back.
  await t.shop.control('notify', { paymentId: realPayment })
  const workspaceId = await paid.workspaceId()
  t.equal(
    'the true notification applies the payment',
    (await orderById(t, real.orderId)).status,
    'paid',
  )
  const cancelled = await t.shop.control('notify', {
    paymentId: realPayment,
    event: 'payment.canceled',
    object: { status: 'canceled', paid: false },
  })
  t.equal(
    'a forged «canceled» of a paid order is taken with 200 and changes nothing',
    [
      cancelled.status,
      (await orderById(t, real.orderId)).status,
      (await subscriptionOf(t, workspaceId)).status,
    ],
    [200, 'paid', 'active'],
  )
  await ledgerHolds(t, workspaceId, { tariff: CREDITS.start, pack: 0 })

  // The open page is paid after all, and its true notification applies it.
  await t.shop.press(open.confirmationUrl)
  await t.shop.control('notify', { paymentId: openPayment })
  t.equal(
    'the payment that was forged before is applied once it is really made',
    [
      (await orderById(t, open.orderId)).status,
      (await subscriptionOf(t, await unpaid.workspaceId())).plan,
    ],
    ['paid', 'business'],
  )
}

scenarios['pack-and-period-end'] = async (t) => {
  const stranger = await t.customer()
  t.equal(
    'a pack is not sold to a customer without a tariff',
    await stranger.refusal('billing.startPackCheckout', {}),
    { status: 409, code: 'BILLING_PACK_NEEDS_SUBSCRIPTION' },
  )

  const {
    customer,
    workspaceId,
    subscription,
    order: tariffOrder,
  } = await subscribed(t, {
    autoRenew: false,
  })
  const checkout = await customer.mutate('billing.startPackCheckout', {})
  const created = (await t.shop.sent('POST', '/v3/payments')).at(-1)
  t.equal(
    'the payment of the pack: its price, never a saved method, no receipt',
    [created.body.amount.value, created.body.save_payment_method, created.body.receipt],
    [PRICE.pack, false, undefined],
  )
  await t.shop.press(checkout.confirmationUrl)
  const packOrder = await orderBecomes(
    t,
    'the order of the pack is paid',
    () => orderById(t, checkout.orderId),
    'paid',
  )
  t.equal(
    'it is an order of a pack: it pays for no period and belongs to no subscription',
    [
      packOrder.kind,
      packOrder.plan,
      packOrder.amount,
      packOrder.period_start,
      packOrder.subscription_id,
    ],
    ['pack', 'pack', PRICE.pack, null, null],
  )
  let accounts = await ledgerHolds(t, workspaceId, { tariff: CREDITS.start, pack: CREDITS.pack })
  t.equal(
    'the pack is granted once to the account of purchased credits',
    journal(accounts.credit_pack),
    [{ kind: 'grant', amount: '100.00', key: `order:${packOrder.id}:pack` }],
  )
  t.equal('the audit holds the purchase', await actionsOf(t, workspaceId), [
    'billing.gift.grant',
    'billing.pack.purchase',
    'billing.subscription.start',
  ])
  const synced = await customer.mutate('billing.syncOrder', { orderId: packOrder.id })
  t.equal(
    'the return page shows the pack and its hundred credits',
    [synced.status, synced.kind, synced.planName, synced.packCredits, synced.amount],
    ['paid', 'pack', 'Пакет из 100 кредитов', 100, PRICE.pack],
  )
  const withPack = await customer.query('billing.usage')
  t.equal(
    '«Использование» counts the three accounts: 300 of the tariff, the gift of 35 and 100 purchased',
    [withPack.tariff.credits.left, withPack.gift, withPack.pack, withPack.totalLeft],
    [300, { left: 35, held: 0, granted: true }, { left: 100, held: 0 }, 435],
  )
  await t.until('the customer has two letters «Оплата прошла»: the tariff and the pack', async () =>
    customer.got('Оплата прошла', 2),
  )
  const packLetter = (await customer.mail('billing.payment_succeeded')).at(-1)
  t.check(
    'the letter of the pack names the hundred credits that are on the account now, and that they do not expire',
    packLetter.data.item === 'pack' &&
      packLetter.data.packCredits === Number(journal(accounts.credit_pack)[0].amount) &&
      packLetter.text.includes('Оплата прошла: пакет из 100 кредитов — 1 990 ₽.') &&
      packLetter.text.includes('Кредиты из пакета уже добавлены и не сгорают в конце периода.'),
    packLetter,
  )
  t.equal(
    'a task could spend all three accounts while the tariff is paid: 435 credits',
    [withPack.spendable, (await customer.query('billing.overview')).credits.spendable],
    [435, 435],
  )

  // The period ends; auto-renewal is off.
  const dates = await periodEnded(t, subscription.id)
  await subscriptionBecomes(t, 'the tariff ends with its period', workspaceId, 'cancelled')
  accounts = await ledgerHolds(t, workspaceId, { tariff: 0, pack: CREDITS.pack })
  t.equal(
    'the available rest of the tariff expired under the key of the period; the pack was not touched',
    [journal(accounts.credit_tariff), journal(accounts.credit_pack).length],
    [
      [
        { kind: 'grant', amount: '300.00', key: `order:${tariffOrder.id}:grant` },
        {
          kind: 'expire',
          amount: '-300.00',
          key: `sub:${subscription.id}:${dates.end.getTime()}:expire`,
        },
      ],
      1,
    ],
  )
  const [ended] = await auditOf(t, workspaceId, 'billing.subscription.end')
  t.equal(
    'the audit says why the tariff ended and what was left',
    [ended.actor_type, ended.meta],
    [
      'system',
      {
        status: 'cancelled',
        reason: 'auto_renewal_off',
        periodEnd: iso(dates.end),
        expiredCredits: 300,
        packCreditsLeft: 100,
        notified: true,
      },
    ],
  )
  // The rule of a tariff that ends, on the three accounts (the expiry rules of the credits
  // design): what is available of the tariff expires; the gift stays and can be spent; the
  // pack stays and waits for a tariff.
  t.equal(
    'a tariff that is not renewed: the rest of its quota expired, the gift and the pack are the one grant each',
    await journalsOf(t, workspaceId),
    {
      tariff: [journalRow.quota(tariffOrder), journalRow.expired(subscription, dates.end)],
      gift: [giftGrant(customer.id)],
      pack: [journalRow.pack(packOrder)],
    },
  )
  await t.until('the customer gets the letter «Тариф закончился»', async () =>
    customer.got('Тариф закончился'),
  )
  const [endedLetter] = await customer.mail('billing.subscription_ended')
  t.check(
    'the letter says what is kept, with the pack counted, and that tasks are still taken on gift credits',
    endedLetter.data.packCreditsLeft === 100 &&
      endedLetter.data.giftCreditsLeft === 35 &&
      endedLetter.text.includes(
        `Тариф «Старт» закончился ${moscowDate(dates.end)}. Новые задачи принимаются, только пока есть подарочные кредиты.`,
      ) &&
      endedLetter.text.includes(
        'Кредиты из пакета и подарочные, сайты и история правок сохраняются. Кредитов из пакета осталось: 100.',
      ),
    endedLetter,
  )
  const overview = await customer.query('billing.overview')
  t.equal(
    'without a tariff a task could spend the gift alone: 35 of the 135 credits, the pack waits for a tariff',
    [overview.credits.spendable, overview.credits.totalAvailable],
    [35, 135],
  )
  t.equal(
    '«Тарифы» shows no tariff, when the last one ended, the gift and the purchased credits',
    [
      overview.subscription,
      overview.ended,
      overview.credits.tariff.available,
      overview.credits.gift,
      overview.credits.pack,
    ],
    [
      null,
      { planName: 'Старт', endedAt: iso(dates.end), reason: 'not_renewed' },
      0,
      { balance: 35, held: 0, available: 35, granted: true },
      { balance: 100, held: 0, available: 100 },
    ],
  )
  const usage = await customer.query('billing.usage')
  t.equal(
    '«Использование» keeps the gift and the hundred purchased credits',
    [usage.subscription, usage.tariff, usage.gift, usage.pack, usage.totalLeft],
    [null, null, { left: 35, held: 0, granted: true }, { left: 100, held: 0 }, 135],
  )
  t.equal(
    'another pack is not sold once the tariff is over',
    await customer.refusal('billing.startPackCheckout', {}),
    { status: 409, code: 'BILLING_PACK_NEEDS_SUBSCRIPTION' },
  )
  t.equal('nothing was charged by itself', (await t.shop.charges()).length, 0)
}
