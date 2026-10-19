// What the scenarios of the billing stand are written with: the context of a scenario — its
// checks, its waits and the three actors (a customer, ЮKassa, an operator) —, the readers of the
// stand's database, and the steps several scenarios share. Nothing here calls a function of the
// product: a customer signs up and calls the tRPC procedures over HTTP with a session cookie
// and pays on the page of the fake; ЮKassa is the fake and its control API; the operator runs
// the scripts of the orchestrator. Time moves by editing dates in the stand's own database, and
// the scheduler of core, which ticks every second, does the rest. Every wait polls with a
// deadline and says what it waited for. Money is compared as the strings the product stores.
// A letter is read the way its reader gets it: what it was made of comes from the mirror of
// the outbox the stand keeps in its own database, its text from the mailer of the private copy.
// The words the stand expects of a letter are written here on their own, from the texts the
// product promises, not taken from its templates.
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

import {
  LETTER_MIRROR,
  PAST_DUE_DAYS,
  cookieHeader,
  metricValue,
  moscowMonthLater,
  periodEndingAt,
  trpcOutcome,
  trpcQueryUrl,
} from './stand.mjs'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const PRICE = { start: '4900.00', business: '12900.00', pack: '1990.00' }
/**
 * The credits a month of the two tariffs the scenarios buy, the credits of the pack, and the
 * gift of the registration, which every workspace the product makes is granted once.
 */
export const CREDITS = { start: 300, business: 800, pack: 100, gift: 35 }
/**
 * What «Тарифы» sells, as the stand expects it of the seeds: the credits a month, the tasks a
 * day and the sites of each tariff, and the credits of the pack, with their prices.
 */
export const ON_SALE = Object.freeze({
  plans: [
    { slug: 'start', price: '4900.00', creditsPerMonth: 300, tasksPerDay: 5, maxSites: 1 },
    { slug: 'business', price: '12900.00', creditsPerMonth: 800, tasksPerDay: 10, maxSites: 3 },
    { slug: 'agency', price: '39900.00', creditsPerMonth: 2500, tasksPerDay: 30, maxSites: 15 },
  ],
  pack: { slug: 'pack', price: '1990.00', credits: 100 },
})
/** What the operator approves in the stand: the provisional credit rate of the credits model. */
export const CREDIT_RATE = '6.00'
/** The key the gift of a user stands under in the journal, on whichever workspace of theirs. */
export const giftKey = (userId) => `user:${userId}:signup-gift`
/** The texts of the product bind numbers to their words with a non-breaking space. */
export const NBSP = '\u00a0'
export const MIR = `Карта «Мир» ••${NBSP}4444`
export const VISA = `Карта Visa ••${NBSP}1234`
export const VISA_CARD = { last4: '1234', card_type: 'Visa', first6: '411111' }

export class CheckFailed extends Error {}

const NOT_YET = Symbol('not yet')
/**
 * What a probe of `until` answers while the thing it waits for has not happened, to say what
 * it saw instead: a wait that runs out prints the last of these, not a bare `null`.
 */
export const notYet = (seen) => ({ [NOT_YET]: true, seen })

export const plain = (text) => text.replaceAll(NBSP, ' ')

// ─── The words of a letter, as the stand expects them ─────────────────────────

/** The form of a Russian noun that goes with the number: 1 кредит, 2 кредита, 5 кредитов. */
const plural = (count, one, few, many) => {
  const lastTwo = count % 100
  if (lastTwo >= 11 && lastTwo <= 14) return many
  if (count % 10 === 1) return one
  return count % 10 >= 2 && count % 10 <= 4 ? few : many
}
/** «2 500»: a count with its digits in groups of three. */
export const counted = (count) => String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
/** «300 кредитов», «1 кредит»: a count of credits with its word. */
export const creditsCount = (count) =>
  `${counted(count)} ${plural(count, 'кредит', 'кредита', 'кредитов')}`
/** «4 900 ₽», «1 990,50 ₽»: an amount as the product stores it, for reading. */
export const rubles = (amount) => {
  const [whole, kopecks] = amount.split('.')
  return `${counted(Number(whole))}${kopecks === '00' ? '' : `,${kopecks}`} ₽`
}
const MOSCOW_DATE = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Moscow',
})
/** «18 октября 2026»: the Moscow calendar day of an instant. */
export const moscowDate = (instant) => {
  const parts = new Map(
    MOSCOW_DATE.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]),
  )
  return `${parts.get('day')} ${parts.get('month')} ${parts.get('year')}`
}
/** A value for a failure message; a non-breaking space is shown as what it is. */
export const show = (value) =>
  (JSON.stringify(value, null, 2) ?? String(value)).replaceAll(NBSP, '\\u00a0')
export const iso = (date) => (date instanceof Date ? date.toISOString() : date)
export const fromNow = (ms) => new Date(Date.now() + ms)
export const paymentIdOf = (confirmationUrl) =>
  confirmationUrl.slice(confirmationUrl.lastIndexOf('/') + 1)
/** The moment a UUID of version 7 was made: Prisma makes the ids of orders and audit entries. */
export const madeAt = (id) => Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)

// ─── A scenario and its actors ────────────────────────────────────────────────

/** What a scenario works with: the checks it prints, the waits, and the three actors. */
export function scenarioContext(stand, scenario, counter) {
  const { db, fake, signal } = stand
  const abortable = (ms) => AbortSignal.any([signal, AbortSignal.timeout(ms)])
  const t = {
    webUrl: stand.webUrl,
    coreUrl: stand.coreUrl,
    /** The files of the site customers add (`addSite`) and the logins its server has seen. */
    site: stand.site,
    /** The current version of a secret in the Vault web writes to; null for none. */
    vaultVersion: stand.vaultVersion,
    /** Every customer the scenario has signed up. */
    customers: [],
    /** One printed line per check; the first one that does not hold ends the stand. */
    check(text, holds, seen) {
      if (!holds)
        throw new CheckFailed(`${text}${seen === undefined ? '' : `\n  seen: ${show(seen)}`}`)
      counter.checks += 1
      console.log(`PASS ${scenario.id}: ${text}`)
    },
    equal(text, actual, expected) {
      if (!isDeepStrictEqual(actual, expected))
        throw new CheckFailed(`${text}\n  expected: ${show(expected)}\n  seen: ${show(actual)}`)
      t.check(text, true)
    },
    /**
     * Polls until `probe` answers something truthy and returns it. When the deadline passes
     * the failure names what was awaited and the last thing the probe saw: what it answered,
     * or what it handed to `notYet`.
     */
    async until(text, probe, { timeoutMs = 30_000, everyMs = 100, silent = false } = {}) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        stand.alive()
        const answer = await probe()
        const waiting = answer?.[NOT_YET] === true
        if (answer && !waiting) {
          if (!silent) t.check(text, true)
          return answer
        }
        if (Date.now() > deadline)
          throw new CheckFailed(
            `waited ${timeoutMs / 1000} s for: ${text}\n  last seen: ${show(waiting ? answer.seen : answer)}`,
          )
        await sleep(everyMs, undefined, { signal })
      }
    },
    /**
     * Waits until core has finished `count` passes of every named kind that started after this
     * call: whatever the passes do with the rows as they are now, they have done it.
     */
    async passes(names, count = 2) {
      const since = Date.now()
      await t.until(
        `core to finish ${count} passes of ${names.join(', ')}`,
        async () => {
          const finished = await stand.finishedPasses(since)
          return names.every((name) => (finished[name] ?? 0) >= count)
        },
        { silent: true },
      )
    },
    rows: async (sql, params = []) => (await db.query(sql, params)).rows,
    async one(sql, params = []) {
      const { rows } = await db.query(sql, params)
      if (rows.length > 1) throw new CheckFailed(`one row expected, ${rows.length} found: ${sql}`)
      return rows[0] ?? null
    },
    /** Rows of the renewal counter of a core process: `{ renewed, skipped, … }` of one pass. */
    async passCounts(origin, job) {
      const response = await fetch(`${origin}/metrics`, {
        headers: { authorization: `Bearer ${stand.metricsToken}` },
        signal: abortable(10_000),
      })
      const text = await response.text()
      return Object.fromEntries(
        ['renewed', 'skipped', 'blocked', 'declined', 'unanswered', 'pending', 'failed'].map(
          (outcome) => [
            outcome,
            metricValue(text, 'raditi_billing_renewal_rows_total', { job, outcome }),
          ],
        ),
      )
    },
    /**
     * Runs `body` while core does not run the named pass at all (the other passes go on), and
     * lets the pass run again afterwards, whatever became of `body`. The runner does the same
     * after a scenario that died before this could.
     */
    async withoutPass(job, body) {
      await stand.schedulers.pause(job)
      try {
        return await body()
      } finally {
        await stand.schedulers.resume(job)
      }
    },
    webLog: stand.webLog,
    secondCore: stand.secondCore,
    /** An operator's command: `{ code, stdout, stderr }`. */
    operator: (script, args) => stand.operator(script, args),
    /** A file an operator's command is given by its path; the path. */
    operatorFile: (name, value) => stand.operatorFile(name, value),
    /**
     * Letters as their readers get them: the rows of the mirror of the outbox that `where`
     * names, oldest first — `{ seq, type, key, data, to, subject, text }`, the text with plain
     * spaces. `data` is what the product made the letter of.
     */
    async mail(where, params = []) {
      const rows = await t.rows(
        `SELECT seq::int AS seq, type, dedupe_key AS key, payload AS data
         FROM ${LETTER_MIRROR} WHERE ${where} ORDER BY seq`,
        params,
      )
      const read = await stand.letterTexts(rows.map(({ type, data }) => ({ type, payload: data })))
      return rows.map((row, index) => ({
        ...row,
        to: read[index].to,
        subject: plain(read[index].subject),
        text: plain(read[index].text),
      }))
    },
    /**
     * The letters of the named kinds written since this was last asked, by any scenario of the
     * run: each one is handed out once.
     */
    async newMail(types) {
      const letters = await t.mail(`seq > $1 AND type = ANY($2::text[])`, [counter.letters, types])
      counter.letters = Math.max(counter.letters, ...letters.map(({ seq }) => seq))
      return letters
    },
  }

  // ── ЮKassa: the fake, its control API and its pay page ──

  async function control(name, body) {
    const get = body === undefined
    const response = await fetch(`${fake.controlUrl}/${name}`, {
      method: get ? 'GET' : 'POST',
      ...(get ? {} : { body: JSON.stringify(body) }),
      signal: abortable(60_000),
    })
    const answer = await response.json()
    if (!response.ok)
      throw new CheckFailed(`the fake refused «${name}» with ${response.status}: ${show(answer)}`)
    return answer
  }
  t.shop = {
    url: fake.url,
    control,
    state: () => control('state'),
    /** Waits until every notification sent so far has been answered by web. */
    settle: () => control('settle', {}),
    hold: () => control('webhooks', { enabled: false }),
    release: () => control('webhooks', { enabled: true }),
    /** The buyer presses a button of the page ЮKassa sent them to; they come back to the answer. */
    async press(confirmationUrl, action = 'pay') {
      const response = await fetch(confirmationUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action }).toString(),
        redirect: 'manual',
        signal: abortable(30_000),
      })
      if (response.status !== 303)
        throw new CheckFailed(`the pay page answered ${response.status} to «${action}»`)
      return response.headers.get('location')
    },
    /** Requests of one kind the shop has taken, in the order they came. */
    async sent(method, path) {
      const requests = await control('requests')
      return requests.filter((request) => request.method === method && request.path === path)
    },
    /** Charges of saved payment methods: what only the scheduler of core sends. */
    async charges() {
      const requests = await t.shop.sent('POST', '/v3/payments')
      return requests.filter((request) => request.body?.payment_method_id !== undefined)
    },
    /** A payment, a payment method or a refund as the shop holds it now. */
    async object(kind, id) {
      const state = await control('state')
      return state[kind].find((object) => object.id === id) ?? null
    },
    /** What became of the notifications about one object: `[{ event, status | withheld }]`. */
    async deliveries(objectId) {
      const state = await control('state')
      return state.webhooks.deliveries
        .filter((delivery) => delivery.objectId === objectId)
        .map(({ event, status, withheld }) =>
          withheld ? { event, withheld: true } : { event, status },
        )
    },
    /** A call of the API by someone else: the owner of the shop in the cabinet of ЮKassa. */
    async cabinet(path, body) {
      const { shopId, secretKey } = stand.shop
      const response = await fetch(`${fake.apiUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`,
          'content-type': 'application/json',
          'idempotence-key': randomUUID(),
        },
        body: JSON.stringify(body),
        signal: abortable(30_000),
      })
      return { status: response.status, body: await response.json() }
    },
  }

  // ── A customer: a browser with a session cookie ──

  /**
   * Signs a new user up as the form does, opens the link of the confirmation letter and keeps
   * the session cookie. Every customer comes from an address of their own, as the reverse
   * proxy in front of web would report it: the sign-up limit of better-auth is per address.
   */
  t.customer = async function customer() {
    counter.customers += 1
    const number = counter.customers
    const email = `billing-${counter.tag}-${number}@example.ru`
    const browser = { 'x-forwarded-for': `198.51.100.${number}`, origin: stand.webUrl }
    let cookie = ''
    const request = async (path, init = {}) => {
      const response = await fetch(path.startsWith('http') ? path : `${stand.webUrl}${path}`, {
        ...init,
        headers: { ...browser, ...(cookie ? { cookie } : {}), ...init.headers },
        redirect: 'manual',
        signal: abortable(60_000),
      })
      cookie = cookieHeader(response.headers.getSetCookie(), cookie)
      return response
    }
    const signUp = await request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Анна',
        lastName: 'Проверкина',
        email,
        password: randomBytes(18).toString('base64url'),
        // Both required boxes of the sign-up form (152-ФЗ).
        acceptTerms: true,
        acceptPersonalData: true,
        marketing: false,
      }),
    })
    if (signUp.status !== 200)
      throw new CheckFailed(`sign-up answered ${signUp.status}: ${await signUp.text()}`)
    const letters = (subject) =>
      stand.letters().filter((sent) => sent.to === email && plain(sent.subject) === subject)
    // The letter went through the outbox, the relay, BullMQ and the mailer of core.
    const [letter] = await t.until(
      `the confirmation letter to ${email}`,
      async () => {
        const sent = letters('Подтвердите адрес почты')
        return sent.length > 0 ? sent : null
      },
      { silent: true },
    )
    const confirmed = await request(letter.links[0])
    if (confirmed.status >= 400 || cookie === '')
      throw new CheckFailed(`the confirmation link opened no session (HTTP ${confirmed.status})`)
    const user = await t.one(`SELECT id, email_verified FROM users WHERE email = $1`, [email])
    if (!user?.email_verified) throw new CheckFailed(`the address ${email} is not confirmed`)

    const call = async (type, path, input) => {
      const response =
        type === 'query'
          ? await request(trpcQueryUrl(stand.webUrl, path, input))
          : await request(`/api/trpc/${path}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ json: input ?? {} }),
            })
      return trpcOutcome(response.status, await response.json().catch(() => null))
    }
    const data = async (type, path, input) => {
      const outcome = await call(type, path, input)
      if (!outcome.ok)
        throw new CheckFailed(`${path} was refused: ${show(outcome)}\n  input: ${show(input)}`)
      return outcome.data
    }
    const customer = {
      id: user.id,
      email,
      request,
      query: (path, input) => data('query', path, input),
      mutate: (path, input) => data('mutation', path, input),
      /**
       * The three settings pages as the customer would read them now; null while the cabinet
       * is closed to them until they accept a new edition of the documents.
       */
      async pages() {
        const overview = await call('query', 'billing.overview')
        if (!overview.ok && overview.domainCode === 'CONSENT_REQUIRED') return null
        return {
          overview: await data('query', 'billing.overview'),
          plans: await data('query', 'billing.plans'),
          payments: await data('query', 'billing.payments', { limit: 100 }),
          usage: await data('query', 'billing.usage'),
        }
      },
      /** The letters of one kind written to this customer, oldest first, with their text. */
      mail: (type) => t.mail(`payload->>'to' = $1 AND type = $2`, [email, type]),
      /** How a call is refused: `{ status, code }` with the code of the domain, or `{ ok: true }`. */
      async refusal(path, input, type = 'mutation') {
        const outcome = await call(type, path, input)
        return outcome.ok ? { ok: true } : { status: outcome.status, code: outcome.domainCode }
      },
      /** Letters to this customer with the subject, as the mailer of core logged them. */
      letters,
      /** The subject of every letter to this customer so far, in the order they were sent. */
      subjects: () =>
        stand
          .letters()
          .filter((sent) => sent.to === email)
          .map((sent) => plain(sent.subject)),
      /**
       * Whether the customer has exactly `count` letters with the subject; while not, what
       * `until` shows when it runs out: every subject the customer did get.
       */
      got: (subject, count = 1) =>
        letters(subject).length === count ||
        notYet({ expected: `${count} × «${subject}»`, got: customer.subjects() }),
      /** The personal workspace, once a payment or a site has made one. */
      async workspaceId() {
        const row = await t.one(`SELECT id FROM workspaces WHERE created_by_id = $1`, [user.id])
        if (row === null) throw new CheckFailed(`${email} has no workspace`)
        return row.id
      },
    }
    t.customers.push(customer)
    return customer
  }

  return t
}

// ─── What the database holds ──────────────────────────────────────────────────

/** The subscription of a workspace as the database holds it (the newest one). */
export const subscriptionOf = (t, workspaceId) =>
  t.one(
    `SELECT s.id, s.status::text AS status, p.slug AS plan, n.slug AS next_plan,
       s.current_period_start, s.current_period_end, s.period_anchor,
       s.cancel_at_period_end, s.cancelled_at, s.past_due_since, s.renewal_notice_period_end,
       s.payment_method_id, s.payment_method_title, s.payment_method_type,
       s.payment_method_card_type, s.payment_method_last4, s.pending_payment_method_id
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id LEFT JOIN plans n ON n.id = s.next_plan_id
     WHERE s.workspace_id = $1 ORDER BY s.created_at DESC, s.id DESC LIMIT 1`,
    [workspaceId],
  )

export const ORDER_COLUMNS = `o.id, o.workspace_id, o.user_id, o.kind::text AS kind, o.status::text AS status,
  o.amount::text AS amount, p.slug AS plan, o.subscription_id, o.yookassa_payment_id,
  o.idempotence_key, o.save_payment_method, o.period_start, o.period_end, o.failure_reason,
  o.paid_at, o.yookassa_refund_id, o.refunded_amount::text AS refunded_amount, o.refunded_at,
  o.created_at`
export const ordersWhere = (t, where, params) =>
  t.rows(
    `SELECT ${ORDER_COLUMNS} FROM orders o LEFT JOIN plans p ON p.id = o.plan_id
     WHERE ${where} ORDER BY o.created_at, o.id`,
    params,
  )
export const ordersOf = (t, workspaceId) => ordersWhere(t, 'o.workspace_id = $1', [workspaceId])
export const orderById = async (t, id) => (await ordersWhere(t, 'o.id = $1', [id]))[0] ?? null
export const orderByKey = async (t, key) =>
  (await ordersWhere(t, 'o.idempotence_key = $1', [key]))[0] ?? null

/**
 * The credit accounts of a workspace with their journal:
 * `{ credit_tariff: { balance, held, ledger }, credit_gift: …, credit_pack: … }`.
 */
export async function accountsOf(t, workspaceId) {
  const accounts = await t.rows(
    `SELECT id, unit::text AS unit, balance::text AS balance, held::text AS held
     FROM billing_accounts WHERE workspace_id = $1`,
    [workspaceId],
  )
  const result = {}
  for (const account of accounts) {
    const ledger = await t.rows(
      `SELECT kind::text AS kind, amount::text AS amount, balance_after::text AS balance_after,
         idempotency_key AS key
       FROM credit_ledger WHERE account_id = $1 ORDER BY created_at, id`,
      [account.id],
    )
    result[account.unit] = { balance: account.balance, held: account.held, ledger }
  }
  return result
}
export const journal = (account) =>
  (account?.ledger ?? []).map(({ kind, amount, key }) => ({ kind, amount, key }))

/** The three credit accounts of a workspace, in the order their credits are spent in. */
const CREDIT_UNITS = ['credit_tariff', 'credit_gift', 'credit_pack']

/**
 * The rule of spec §17 on the three credit accounts of a workspace: a balance is the sum of its
 * journal and its last `balance_after`, and nothing is held above it; the accounts are made
 * together, so a workspace has the three or none. Then the balances themselves, in credits:
 * `{ tariff, pack }`, and the gift of the registration — the whole of it, unless the scenario
 * names another number: the product grants the gift with every workspace it makes, and nothing
 * spends it before the task queue. A whole gift is also a journal of one row — the grant, under
 * the key of the user who made the workspace: a gift that expired with a period and was granted
 * anew holds the same number and is not the same gift. That it is granted once is asked of the
 * whole database after every scenario as well (`atRest`).
 */
export async function ledgerHolds(t, workspaceId, expected, who = '') {
  const accounts = await accountsOf(t, workspaceId)
  const made = CREDIT_UNITS.filter((unit) => accounts[unit] !== undefined)
  if (made.length !== 0 && made.length !== CREDIT_UNITS.length)
    throw new CheckFailed(`the workspace has only some of its credit accounts: ${show(made)}`)
  for (const [unit, account] of Object.entries(accounts)) {
    const sum = account.ledger.reduce((total, entry) => total + Number(entry.amount), 0)
    const last = account.ledger.at(-1)?.balance_after ?? '0.00'
    if (
      Number(account.balance) !== sum ||
      Number(last) !== Number(account.balance) ||
      Number(account.held) > Number(account.balance) ||
      Number(account.held) < 0
    )
      throw new CheckFailed(`the journal of the ${unit} account does not add up: ${show(account)}`)
  }
  const { gift = CREDITS.gift } = expected
  t.equal(
    `${who}the journals add up to the balances: ${expected.tariff} of the tariff, ${gift} of the gift, ${expected.pack} purchased`,
    {
      tariff: Number(accounts.credit_tariff?.balance ?? 0),
      gift: Number(accounts.credit_gift?.balance ?? 0),
      pack: Number(accounts.credit_pack?.balance ?? 0),
    },
    { gift, ...expected },
  )
  if (gift === CREDITS.gift) {
    const owner = await t.one(`SELECT created_by_id AS id FROM workspaces WHERE id = $1`, [
      workspaceId,
    ])
    const untouched = [giftGrant(owner.id)]
    if (!isDeepStrictEqual(journal(accounts.credit_gift), untouched))
      throw new CheckFailed(
        `${who}the journal of the gift account is not the one grant of the registration\n  expected: ${show(untouched)}\n  seen: ${show(journal(accounts.credit_gift))}`,
      )
  }
  return accounts
}

/** The one row a gift account holds while nothing of the gift is spent: its grant. */
export const giftGrant = (userId) => ({
  kind: 'grant',
  amount: `${CREDITS.gift}.00`,
  key: giftKey(userId),
})

/**
 * The journals of the three credit accounts of a workspace, whole, in the order their credits
 * are spent in: `{ tariff, gift, pack }`, each a list of `{ kind, amount, key }`. What a rule of
 * expiry is compared with: it says what becomes of each account, and a journal says it all.
 */
export async function journalsOf(t, workspaceId) {
  const accounts = await accountsOf(t, workspaceId)
  return {
    tariff: journal(accounts.credit_tariff),
    gift: journal(accounts.credit_gift),
    pack: journal(accounts.credit_pack),
  }
}

/** What stands in the journal of a tariff, a pack and a period: the rows the product writes. */
export const journalRow = {
  quota: (order, credits = CREDITS.start) => ({
    kind: 'grant',
    amount: `${credits}.00`,
    key: `order:${order.id}:grant`,
  }),
  expired: (subscription, end, credits = CREDITS.start) => ({
    kind: 'expire',
    amount: `-${credits}.00`,
    key: `sub:${subscription.id}:${end.getTime()}:expire`,
  }),
  pack: (order) => ({
    kind: 'grant',
    amount: `${CREDITS.pack}.00`,
    key: `order:${order.id}:pack`,
  }),
  packTaken: (order, credits = CREDITS.pack) => ({
    kind: 'adjust',
    amount: `-${credits}.00`,
    key: `order:${order.id}:refund:adjust`,
  }),
}

export const auditOf = (t, workspaceId, action) =>
  t.rows(
    `SELECT id, action, actor_type::text AS actor_type, target_type, target_id, meta, created_at
     FROM audit_log WHERE workspace_id = $1 AND ($2::text IS NULL OR action = $2)
     ORDER BY id`,
    [workspaceId, action ?? null],
  )
export const actionsOf = async (t, workspaceId) =>
  (await auditOf(t, workspaceId)).map(({ action }) => action).sort()

/** How the outbox rows of one kind of letter ended, by the end of their key. */
export const outboxOf = async (t, type, keyEnd) =>
  (
    await t.rows(
      `SELECT status::text AS status FROM outbox_events
       WHERE type = $1 AND dedupe_key LIKE '%' || $2 ORDER BY created_at, id`,
      [type, keyEnd],
    )
  ).map(({ status }) => status)

// ─── What scenarios share ─────────────────────────────────────────────────────

/**
 * The access to the files of the stand's site as «Доступ к файлам» sends it: SSH, a password,
 * the folder of the site; with `hostKey` once the customer has confirmed the key of the server.
 */
export const siteAccess = (t, hostKey) => ({
  kind: 'sftp',
  host: t.site.host,
  port: t.site.port,
  username: t.site.username,
  auth: { method: 'password', password: t.site.password },
  rootPath: t.site.rootPath,
  ...(hostKey === undefined ? {} : { hostKey }),
})

/**
 * Adds a site the way the wizard «Добавить проект» does, over HTTP and step by step — the one
 * way the product makes a site, and so a workspace with its gift. «Основные данные»: the name
 * and the address as they will be stored. «Доступ к файлам»: the first check names the key the
 * server presented and sends it no login; the customer confirms that key, and the check passes.
 * «База данных»: none; «Добавить проект» checks the files once more, writes the access to Vault
 * and creates the site. Resolves to the project and the input of the creation, which may be
 * sent again.
 */
export async function addSite(t, customer, { name, url }, who = '') {
  const stack = 'wordpress'
  const basics = await customer.mutate('siteConnection.checkBasics', { name, url, stack })
  t.equal(
    `${who}«Основные данные»: the name and the address are taken as they will be stored`,
    basics,
    { name, url: new URL(url).origin, host: new URL(url).host, stack },
  )
  const logins = t.site.logins()
  const first = await customer.mutate('siteConnection.checkSource', {
    stack,
    source: siteAccess(t),
  })
  t.equal(
    `${who}«Доступ к файлам»: the first check names the key the server presented and sends it no login`,
    [first, t.site.logins() - logins],
    [{ ok: false, reason: 'host_key_unknown', hostKey: t.site.hostKey }, 0],
  )
  const source = siteAccess(t, first.hostKey)
  const checked = await customer.mutate('siteConnection.checkSource', { stack, source })
  const request = {
    requestKey: randomUUID(),
    name: basics.name,
    url: basics.url,
    stack,
    source,
    database: null,
  }
  const created = await customer.mutate('project.create', request)
  t.check(
    `${who}the key confirmed, the files are found, and «Добавить проект» without a database creates the project`,
    checked.ok === true &&
      checked.hostKey === t.site.hostKey &&
      created.outcome === 'created' &&
      created.project.url === basics.url &&
      created.project.status === 'onboarding',
    { checked, created },
  )
  return { project: created.project, request }
}

/**
 * Time passes for subscriptions: their current period now ends at `end`, and with it the period
 * of the order that paid for it. Every payment writes the two together, and «Использование»
 * finds the quota of the period by that order (`orders.period_start` is the start of the
 * period): a subscription moved alone would stand in a period nothing was granted to. One
 * statement, so no pass of the scheduler ever sees half of it; the order is found by the period
 * the subscription had before the statement — both parts read one snapshot.
 */
export async function periodEndsAt(t, subscriptionIds, end) {
  const dates = periodEndingAt(end)
  await t.rows(
    `WITH moved AS (
       UPDATE subscriptions
       SET period_anchor = $2, current_period_start = $3, current_period_end = $4
       WHERE id = ANY($1::uuid[])
     )
     UPDATE orders o
     SET period_start = $3, period_end = $4
     FROM subscriptions s
     WHERE s.id = ANY($1::uuid[])
       AND o.subscription_id = s.id
       AND o.period_start = s.current_period_start`,
    [[subscriptionIds].flat(), dates.anchor, dates.start, dates.end],
  )
  return dates
}

/**
 * The period of the subscription ended an hour ago; the key of the charge that renews it. An
 * hour, not a moment: what is counted from the end of the period and what is counted from now
 * must differ by far more than the minute the «from now» checks allow.
 */
export async function periodEnded(t, subscriptionId) {
  const dates = await periodEndsAt(t, subscriptionId, fromNow(-HOUR))
  return { ...dates, key: `renew.${subscriptionId}.${dates.end.getTime()}` }
}

/**
 * An order created `ms` ago, as the pass of stuck orders counts its age. By the clock of this
 * host, which is the clock of core: a database in a container may be seconds off.
 */
export const orderIsOld = (t, orderId, ms) =>
  t.rows(`UPDATE orders SET created_at = $2 WHERE id = $1`, [orderId, fromNow(-ms)])

/** A tariff that has been past due for `ms`, by the same clock. */
export const overdueFor = (t, subscriptionId, ms) =>
  t.rows(`UPDATE subscriptions SET past_due_since = $2 WHERE id = $1`, [
    subscriptionId,
    fromNow(-ms),
  ])

/**
 * A customer with a tariff: signed up, the checkout started, the page of the shop paid, the
 * order settled — by the notification or by the return page, whichever comes first; with
 * notifications held, by the return page. What every later scenario starts from; the
 * scenarios `checkout`, `webhook-and-return` and `webhook-lost` check each step of it.
 */
export async function subscribed(t, { plan = 'start', autoRenew = true } = {}) {
  const customer = await t.customer()
  const checkout = await customer.mutate('billing.startCheckout', { planSlug: plan, autoRenew })
  await t.shop.press(checkout.confirmationUrl)
  const synced = await customer.mutate('billing.syncOrder', { orderId: checkout.orderId })
  if (synced.status !== 'paid')
    throw new CheckFailed(`the first payment of ${customer.email} was not applied: ${show(synced)}`)
  await t.shop.settle()
  const workspaceId = await customer.workspaceId()
  return {
    customer,
    order: await orderById(t, checkout.orderId),
    workspaceId,
    subscription: await subscriptionOf(t, workspaceId),
  }
}

/** What a wait for an order shows when it runs out: the row as it was last seen. */
export const orderSeen = (order) =>
  notYet(
    order && {
      id: order.id,
      status: order.status,
      failure_reason: order.failure_reason,
      yookassa_payment_id: order.yookassa_payment_id,
      idempotence_key: order.idempotence_key,
    },
  )

/** Waits for the order of a key (or an id) to reach a status and returns the row. */
export const orderBecomes = (t, text, find, status) =>
  t.until(text, async () => {
    const order = await find()
    return order?.status === status ? order : orderSeen(order)
  })

/** Waits for the subscription of a workspace to reach a status and returns the row. */
export const subscriptionBecomes = (t, text, workspaceId, status) =>
  t.until(text, async () => {
    const subscription = await subscriptionOf(t, workspaceId)
    if (subscription?.status === status) return subscription
    return notYet(
      subscription && {
        id: subscription.id,
        status: subscription.status,
        current_period_end: subscription.current_period_end,
        past_due_since: subscription.past_due_since,
        cancel_at_period_end: subscription.cancel_at_period_end,
        payment_method_id: subscription.payment_method_id,
      },
    )
  })

/** The customer buys a pack of a hundred credits on the page of the shop; the paid order. */
export async function packBought(
  t,
  customer,
  text = 'the customer buys a pack of a hundred credits',
) {
  const checkout = await customer.mutate('billing.startPackCheckout', {})
  await t.shop.press(checkout.confirmationUrl)
  return orderBecomes(t, text, () => orderById(t, checkout.orderId), 'paid')
}

/**
 * Purchased credits never expire (the owner's decision of 04.10.2026): whatever has just been
 * done to the tariff, the account of purchased credits holds the hundred of the pack, and its
 * journal is the one grant it was bought with. `tariff`: what the tariff account holds now.
 */
export async function packIntact(t, workspaceId, pack, tariff, who = '') {
  const accounts = await ledgerHolds(t, workspaceId, { tariff, pack: CREDITS.pack }, who)
  t.equal(
    `${who}the purchased credits are untouched: their journal is the one grant of the pack`,
    journal(accounts.credit_pack),
    [{ kind: 'grant', amount: '100.00', key: `order:${pack.id}:pack` }],
  )
  return accounts
}

/** The period a renewal moves a subscription to, by the rule of the plan. */
export const periodAfter = (dates) => ({
  start: iso(dates.end),
  end: iso(moscowMonthLater(dates.anchor, dates.end)),
})

/**
 * Nothing is left for the scheduler: no tariff waits for a notice, a charge or its end, and no
 * order waits for an outcome. A scenario that ended otherwise would take the next one's
 * answers of the shop.
 */
export async function atRest(t) {
  const due = await t.rows(
    `SELECT s.id, s.status::text AS status, s.current_period_end FROM subscriptions s
     WHERE (s.status = 'active' AND s.current_period_end <= now() + interval '4 days')
        OR (s.status = 'past_due'
            AND COALESCE(s.past_due_since, s.current_period_end)
              <= now() - make_interval(days => $1::int) + interval '1 day')`,
    [PAST_DUE_DAYS],
  )
  const pending = await t.rows(
    `SELECT id, kind::text AS kind, idempotence_key FROM orders WHERE status = 'pending'`,
  )
  t.equal(
    'nothing is left for the scheduler: no tariff is due and no order is unfinished',
    { due, pending },
    { due: [], pending: [] },
  )
  // Whatever web was notified of so far: a payment it called «unknown» is no order's payment.
  const unknown = [
    ...t.webLog().matchAll(/\] payment\.(?:succeeded|canceled) for (\S+): order unknown/g),
  ].map(([, id]) => id)
  t.equal(
    'web took every notification of an order’s payment for that order',
    await t.rows(
      `SELECT id, yookassa_payment_id FROM orders WHERE yookassa_payment_id = ANY($1::text[])`,
      [unknown],
    ),
    [],
  )
  // Spec §17 for every account the run has made so far, whoever it belongs to.
  t.equal(
    'every credit account in the database is the sum of its journal and holds nothing above it',
    await t.rows(
      `SELECT a.id, a.unit::text AS unit, a.balance::text AS balance, a.held::text AS held,
         COALESCE(sum(l.amount), 0)::text AS journal
       FROM billing_accounts a LEFT JOIN credit_ledger l ON l.account_id = a.id
       GROUP BY a.id
       HAVING a.balance <> COALESCE(sum(l.amount), 0) OR a.held > a.balance OR a.held < 0`,
    ),
    [],
  )
  // The accounts are made together: a workspace that has one of them has the three.
  t.equal(
    'every workspace with a credit account has the three of them: tariff, gift and pack',
    await t.rows(
      `SELECT workspace_id, array_agg(unit::text ORDER BY unit::text) AS units
       FROM billing_accounts WHERE unit::text = ANY($1::text[])
       GROUP BY workspace_id HAVING count(*) <> $2::int`,
      [CREDIT_UNITS, CREDIT_UNITS.length],
    ),
    [],
  )
  // The gift of the registration, for every workspace the run has made so far — the product
  // makes each of them with a first site or a first payment: one grant on the gift account,
  // of the whole gift, under the key of the user who made the workspace and paid for by no
  // order, and one entry of it in the audit. Whatever happened to the tariff since.
  t.equal(
    `every workspace was granted the gift of the registration once: ${CREDITS.gift} credits under the key of its user`,
    await t.rows(
      `SELECT w.id AS workspace_id, w.created_by_id AS user_id,
         (SELECT COALESCE(json_agg(json_build_object(
             'unit', a.unit::text, 'kind', l.kind::text, 'amount', l.amount::text,
             'order', l.order_id, 'key', l.idempotency_key) ORDER BY l.created_at, l.id), '[]'::json)
          FROM credit_ledger l JOIN billing_accounts a ON a.id = l.account_id
          WHERE a.workspace_id = w.id
            AND (a.unit = 'credit_gift' OR l.idempotency_key LIKE 'user:%:signup-gift')) AS gift_rows,
         (SELECT count(*)::int FROM audit_log g
          WHERE g.workspace_id = w.id AND g.action = 'billing.gift.grant') AS audit_entries
       FROM workspaces w
       WHERE NOT (
         (SELECT count(*) FROM credit_ledger l JOIN billing_accounts a ON a.id = l.account_id
          WHERE a.workspace_id = w.id AND a.unit = 'credit_gift' AND l.kind = 'grant'
            AND l.amount = $1::int AND l.order_id IS NULL
            AND l.idempotency_key = 'user:' || w.created_by_id::text || ':signup-gift') = 1
         AND (SELECT count(*) FROM credit_ledger l JOIN billing_accounts a ON a.id = l.account_id
              WHERE a.workspace_id = w.id
                AND (l.idempotency_key LIKE 'user:%:signup-gift'
                     OR (a.unit = 'credit_gift' AND l.kind = 'grant'))) = 1
         AND (SELECT count(*) FROM audit_log g
              WHERE g.workspace_id = w.id AND g.action = 'billing.gift.grant') = 1
       )`,
      [CREDITS.gift],
    ),
    [],
  )
  await renewalsWereAnnounced(t)
}

/**
 * The letter comes before the charge, for every renewal order the run has made so far,
 * whatever became of it: the last notice written for its subscription before the order was
 * made names the tariff of the order, its amount and the end of the period it renews. An
 * order without such a notice is a charge nobody was told of, or told wrongly: it is printed
 * with every notice of its subscription.
 */
export async function renewalsWereAnnounced(t) {
  const orders = await ordersWhere(t, `o.idempotence_key LIKE 'renew.%'`, [])
  const notices = await t.rows(
    `SELECT id, target_id, meta FROM audit_log
     WHERE action = 'billing.renewal.notice' AND target_type = 'subscription' ORDER BY id`,
  )
  const unannounced = []
  for (const order of orders) {
    const written = notices.filter((notice) => notice.target_id === order.subscription_id)
    const last = written.findLast((notice) => madeAt(notice.id) <= madeAt(order.id))
    const charge = {
      planSlug: order.plan,
      amount: order.amount,
      chargeAt: iso(new Date(Number(order.idempotence_key.split('.').at(-1)))),
    }
    if (last !== undefined && isDeepStrictEqual(last.meta, charge)) continue
    unannounced.push({
      order: { id: order.id, key: order.idempotence_key, status: order.status, ...charge },
      madeAt: iso(new Date(madeAt(order.id))),
      notices: written.map((notice) => ({
        ...notice.meta,
        madeAt: iso(new Date(madeAt(notice.id))),
      })),
    })
  }
  t.equal(
    `every renewal order was announced: the last notice before it names its tariff, amount and period end (orders: ${orders.length})`,
    unannounced,
    [],
  )
}

/**
 * The three accounts of `billing.overview().credits` and their total, without the answer about
 * a new task that stands beside them: what a scenario compares with the balances it expects.
 */
export const creditAccounts = ({ tariff, gift, pack, totalAvailable }) => ({
  tariff,
  gift,
  pack,
  totalAvailable,
})

/** How many tasks a day a workspace without a paid tariff may start, on its gift credits. */
const TASKS_PER_DAY_WITHOUT_TARIFF = 3
/** How many credits a new task needs to start. */
const MIN_START_CREDITS = 5

/**
 * What every customer of the scenario would read on «Тарифы», «Оплата» and «Использование»
 * when it is over, against what the database holds: the tariff and its period, the three
 * credit accounts, every order with its status and money. A customer who has no workspace yet
 * holds nothing — and reads the gift of the registration as promised, not granted, unless the
 * key of their gift already stands in the journal.
 *
 * Beside the accounts both pages tell whether a new task would be taken, and its numbers follow
 * from the balances: what could be spent (gift credits always, the others only while the tariff
 * is paid), nothing launched today against the limit of the day, and the meter of the period
 * that adds up to its quota. The answer itself follows from what is stored as well. Until an
 * operator has approved a credit rate (`creditRateUsable`) no task is taken, and that is said
 * before anything else. Once a rate is in force a task is taken whenever five credits can be
 * spent — and they always can: the stand queues no task, so nothing spends the gift, nothing
 * is launched and no work is unpaid.
 *
 * And «Тарифы» sells what the table of plans holds, in the credits the stand expects of it.
 */
/** The meter of a period as the stand checks it: its sum, and the parts no task has touched. */
const meterAddsUp = ({ granted, charged, held, expired, left, heldEarlier }) => ({
  addsUp: granted === charged + held + expired + left,
  left,
  held,
  heldEarlier,
})

/**
 * Whether credits could be reserved now, by what the database holds: a credit rate has started,
 * and no price in force of an enabled model started after it. Asked by the clock of this host,
 * which is the clock of web and of core: a database in a container may be seconds off.
 */
export async function creditRateUsable(t) {
  const now = new Date()
  const rate = await t.one(
    `SELECT effective_from FROM credit_rates WHERE effective_from <= $1
     ORDER BY effective_from DESC LIMIT 1`,
    [now],
  )
  if (rate === null) return false
  const newer = await t.rows(
    `SELECT p.id FROM llm_model_prices p JOIN llm_models m ON m.id = p.model_id
     WHERE m.enabled AND p.effective_from <= $1 AND p.effective_from > $2 LIMIT 1`,
    [now, rate.effective_from],
  )
  return newer.length === 0
}

/**
 * The answer about a new task the stand expects of a customer who can spend `spendable`
 * credits: the pause of the platform without a usable rate, a task that is taken with one.
 */
function newTaskOf(usable, spendable, who) {
  if (!usable) return { allowed: false, reason: 'rate_missing' }
  if (spendable >= MIN_START_CREDITS) return { allowed: true, reason: null }
  // No scenario can leave a customer here: no task is ever queued, so nothing spends a credit.
  throw new CheckFailed(
    `${who} can spend ${spendable} credits, fewer than a task needs: the stand queues no task and expects nobody without credits`,
  )
}

/** The tariffs and the pack on sale, as `billing.plans` and the table of plans both tell them. */
const onSale = ({ plans, pack }) => ({
  plans: plans.map(({ slug, price, creditsPerMonth, tasksPerDay, maxSites }) => ({
    slug,
    price,
    creditsPerMonth,
    tasksPerDay,
    maxSites,
  })),
  pack: pack && { slug: pack.slug, price: pack.price, credits: pack.credits },
})

export async function pagesShowWhatIsStored(t) {
  let seen = 0
  const usable = await creditRateUsable(t)
  const listed = await t.rows(
    `SELECT slug, kind::text AS kind, price::text AS price, credits_per_month AS "creditsPerMonth",
       tasks_per_day AS "tasksPerDay", max_sites AS "maxSites", pack_credits AS credits
     FROM plans WHERE is_active AND kind IN ('quota', 'pack') ORDER BY sort_order, slug`,
  )
  const sold = onSale({
    plans: listed.filter(({ kind }) => kind === 'quota'),
    pack: listed.find(({ kind }) => kind === 'pack') ?? null,
  })
  t.equal(
    'the table of plans holds the terms the stand expects: 300, 800 and 2 500 credits a month, a pack of 100',
    sold,
    ON_SALE,
  )
  for (const customer of t.customers) {
    const pages = await customer.pages()
    if (pages === null) continue
    seen += 1
    const workspace = await t.one(`SELECT id FROM workspaces WHERE created_by_id = $1`, [
      customer.id,
    ])
    const live = workspace
      ? await t.one(
          `SELECT s.id, s.status::text AS status, p.slug AS plan, n.slug AS next_plan,
             p.tasks_per_day, s.current_period_start, s.current_period_end,
             (s.payment_method_id IS NOT NULL AND NOT s.cancel_at_period_end) AS auto_renewal
           FROM subscriptions s JOIN plans p ON p.id = s.plan_id
             LEFT JOIN plans n ON n.id = s.next_plan_id
           WHERE s.workspace_id = $1 AND s.status IN ('trial', 'active', 'past_due')`,
          [workspace.id],
        )
      : null
    const accounts = workspace ? await accountsOf(t, workspace.id) : {}
    const account = (unit) => {
      const balance = Number(accounts[unit]?.balance ?? 0)
      const held = Number(accounts[unit]?.held ?? 0)
      return { balance, held, available: balance - held }
    }
    const orders = workspace ? await ordersOf(t, workspace.id) : []
    const byId = (left, right) => (left.id < right.id ? -1 : 1)
    const { overview, plans, payments, usage } = pages
    const shown = {
      sold: onSale(plans),
      // No enabled model has a price in the stand: there is no table of «Точный расчёт».
      conversion: plans.creditConversion,
      tariff: overview.subscription && {
        id: overview.subscription.id,
        status: overview.subscription.status,
        plan: overview.subscription.plan.slug,
        nextPlan: overview.subscription.nextPlan?.slug ?? null,
        period: overview.subscription.period,
        autoRenewal: overview.subscription.autoRenewal,
      },
      credits: overview.credits,
      usage: [usage.subscription?.id ?? null, usage.gift, usage.pack, usage.totalLeft],
      // «Использование» tells of a new task what «Тарифы» does.
      task: [usage.spendable, usage.setAside, usage.minToStart, usage.today, usage.newTask],
      meter: usage.tariff && meterAddsUp(usage.tariff.credits),
      payments: payments.items
        .map(({ id, kind, status, amount, refundedAmount }) => ({
          id,
          kind,
          status,
          amount,
          refundedAmount,
        }))
        .sort(byId),
    }
    const pack = account('credit_pack')
    // The gift of the registration is granted when its account holds a grant, however much of
    // it is left. Before the workspace there is no account: the gift is then promised whole,
    // while nothing stands under the key of the user.
    const granted = (accounts.credit_gift?.ledger ?? []).some(({ kind }) => kind === 'grant')
    const taken = await t.one(`SELECT id FROM credit_ledger WHERE idempotency_key = $1`, [
      giftKey(customer.id),
    ])
    const promised = workspace === null && taken === null ? CREDITS.gift : 0
    const gift = workspace
      ? { ...account('credit_gift'), granted }
      : { balance: promised, held: 0, available: promised, granted: false }
    // Tariff and pack credits are spent only while the tariff is paid; gift credits always.
    const paid = live?.status === 'active'
    const tariff = account('credit_tariff')
    const spent = (pick) => pick(gift) + (paid ? pick(tariff) + pick(pack) : 0)
    const task = {
      spendable: spent(({ available }) => available),
      setAside: spent(({ held }) => held),
      minToStart: MIN_START_CREDITS,
      // Nothing is launched in the stand: no task is ever queued.
      today: { used: 0, limit: paid ? live.tasks_per_day : TASKS_PER_DAY_WITHOUT_TARIFF },
    }
    // Without a usable credit rate no task is taken, which is said before anything else.
    task.newTask = newTaskOf(usable, task.spendable, customer.email)
    const stored = {
      sold,
      conversion: null,
      tariff: live && {
        id: live.id,
        status: live.status,
        plan: live.plan,
        nextPlan: live.next_plan,
        period: { start: iso(live.current_period_start), end: iso(live.current_period_end) },
        autoRenewal: live.auto_renewal,
      },
      credits: {
        tariff,
        gift,
        pack,
        totalAvailable: tariff.available + gift.available + pack.available,
        ...task,
      },
      usage: [
        live?.id ?? null,
        { left: gift.available, held: gift.held, granted: gift.granted },
        { left: pack.available, held: pack.held },
        (usage.tariff?.credits.left ?? 0) + gift.available + pack.available,
      ],
      task: [task.spendable, task.setAside, task.minToStart, task.today, task.newTask],
      // What the period was granted is what was charged, set aside, expired and left; what the
      // account has free is what is left, and nothing of an earlier period is set aside.
      meter: live && { addsUp: true, left: tariff.available, held: 0, heldEarlier: 0 },
      payments: orders
        .map(({ id, kind, status, amount, refunded_amount: refundedAmount }) => ({
          id,
          kind,
          status,
          amount,
          refundedAmount,
        }))
        .sort(byId),
    }
    if (JSON.stringify(shown) !== JSON.stringify(stored))
      throw new CheckFailed(
        `${customer.email} reads something else than the database holds\n  stored: ${show(stored)}\n  shown: ${show(shown)}`,
      )
  }
  const closed = t.customers.length - seen
  t.check(
    `«Тарифы», «Оплата» and «Использование» show what the database holds (customers: ${seen})` +
      (closed > 0 ? `; closed until the documents are accepted: ${closed}` : ''),
    true,
  )
}

// ─── Letters against what is stored ───────────────────────────────────────────

/** The sentences of a letter that are missing from its text; none when it says them all. */
const missingFrom = (text, sentences) => sentences.filter((sentence) => !text.includes(sentence))

/** What a letter about a tariff that is not paid for or has ended says of new tasks. */
const tasksOnGift = (gift, refused) =>
  gift >= MIN_START_CREDITS ? 'принимаются, только пока есть подарочные кредиты' : refused

/**
 * What the letter «Оплата прошла» must say of the order it is about: the tariff or the pack
 * and the money, as the order holds them, and the credits the order granted — by the row of
 * the journal, not by the plan: «Начислили 300 кредитов на этот период» is true only of credits
 * that are on the account. The day the tariff works until is the one the letter was written
 * with (`data.periodEnd`): the stand moves the period of a paid order afterwards.
 */
async function paidLetterSays(t, letter) {
  const orderId = letter.key.slice(letter.key.lastIndexOf(':') + 1)
  const order = await t.one(
    `SELECT o.kind::text AS kind, o.amount::text AS amount, p.name AS plan,
       (SELECT l.amount::int FROM credit_ledger l
        WHERE l.kind = 'grant' AND l.idempotency_key = 'order:' || o.id::text || ':grant') AS quota,
       (SELECT l.amount::int FROM credit_ledger l
        WHERE l.kind = 'grant' AND l.idempotency_key = 'order:' || o.id::text || ':pack') AS pack
     FROM orders o JOIN plans p ON p.id = o.plan_id WHERE o.id = $1`,
    [orderId],
  )
  if (order === null) return { about: letter.key, expected: ['an order of the letter'] }
  const expected =
    order.kind === 'pack'
      ? [
          `Оплата прошла: пакет из ${counted(order.pack ?? 0)} ${plural(order.pack ?? 0, 'кредита', 'кредитов', 'кредитов')} — ${rubles(order.amount)}.`,
          'Кредиты из пакета уже добавлены и не сгорают в конце периода.',
        ]
      : [
          `Оплата прошла: тариф «${order.plan}» — ${rubles(order.amount)}.`,
          `Тариф действует до ${moscowDate(letter.data.periodEnd)}. Начислили ${creditsCount(order.quota ?? 0)} на этот период.`,
        ]
  return { about: `order ${orderId}`, expected }
}

/**
 * What the letter «Тариф закончился» must say of the workspace it is about, by its accounts:
 * whether new tasks are still taken — on gift credits, while five of them are free —, and what
 * is kept, with the credits of the pack counted. Both are what is free on the account, not its
 * balance: the product counts them so. The accounts are read when the scenario is over: after
 * a tariff has ended with this letter — at the end of its period or of its grace — nothing the
 * stand does moves the gift or the pack before the scenario is over.
 */
async function endedLetterSays(t, letter) {
  const subscriptionId = letter.key.slice(letter.key.lastIndexOf(':') + 1)
  const row = await t.one(
    `SELECT p.name AS plan,
       COALESCE((SELECT (a.balance - a.held)::int FROM billing_accounts a
                 WHERE a.workspace_id = s.workspace_id AND a.unit = 'credit_gift'), 0) AS gift,
       COALESCE((SELECT (a.balance - a.held)::int FROM billing_accounts a
                 WHERE a.workspace_id = s.workspace_id AND a.unit = 'credit_pack'), 0) AS pack
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.id = $1`,
    [subscriptionId],
  )
  if (row === null) return { about: letter.key, expected: ['a tariff of the letter'] }
  const { plan, gift, pack } = row
  let kept = 'Сайты'
  if (pack > 0 && gift > 0) kept = 'Кредиты из пакета и подарочные, сайты'
  else if (pack > 0) kept = 'Кредиты из пакета, сайты'
  else if (gift > 0) kept = 'Подарочные кредиты, сайты'
  return {
    about: `subscription ${subscriptionId}`,
    expected: [
      `Тариф «${plan}» закончился ${moscowDate(letter.data.endedAt)}. Новые задачи ${tasksOnGift(gift, 'сейчас не принимаются')}.`,
      `${kept} и история правок сохраняются.${pack > 0 ? ` Кредитов из пакета осталось: ${counted(pack)}.` : ''}`,
    ],
  }
}

/**
 * What the letter «Оплата не прошла» must say of new tasks, by the gift account of the
 * workspace: they are still taken while five gift credits are free.
 */
async function failedLetterSays(t, letter) {
  const orderId = letter.key.slice(letter.key.lastIndexOf(':') + 1)
  const row = await t.one(
    `SELECT p.name AS plan, o.amount::text AS amount,
       COALESCE((SELECT (a.balance - a.held)::int FROM billing_accounts a
                 WHERE a.workspace_id = o.workspace_id AND a.unit = 'credit_gift'), 0) AS gift
     FROM orders o JOIN plans p ON p.id = o.plan_id WHERE o.id = $1`,
    [orderId],
  )
  if (row === null) return { about: letter.key, expected: ['an order of the letter'] }
  return {
    about: `order ${orderId}`,
    expected: [
      `Не получилось списать ${rubles(row.amount)} за тариф «${row.plan}».`,
      `Пока оплата не пройдёт, новые задачи ${tasksOnGift(row.gift, 'не принимаются')}.`,
    ],
  }
}

const LETTER_RULES = {
  'billing.payment_succeeded': paidLetterSays,
  'billing.payment_failed': failedLetterSays,
  'billing.subscription_ended': endedLetterSays,
}

/**
 * Every letter about a payment or about the end of a tariff that the scenario wrote — to
 * whomever — says what the database holds: the credits an order granted, the credits of the
 * pack that are left, whether the gift still takes tasks. The text is the letter as its reader
 * gets it; the numbers come from the journal and the accounts, never from the letter itself.
 * A letter that says something else is printed whole.
 */
export async function lettersSayWhatIsStored(t) {
  const letters = await t.newMail(Object.keys(LETTER_RULES))
  const wrong = []
  for (const letter of letters) {
    const { about, expected } = await LETTER_RULES[letter.type](t, letter)
    const missing = missingFrom(letter.text, expected)
    if (missing.length > 0)
      wrong.push({
        letter: `«${letter.subject}» to ${letter.to}`,
        about,
        missing,
        text: letter.text,
      })
  }
  t.equal(
    `the letters about payments and ended tariffs say what the database holds: the credits granted, the pack that is left, whether the gift takes tasks (letters: ${letters.length})`,
    wrong,
    [],
  )
}

/** The notices of coming charges the audit holds for a workspace, oldest first. */
export const noticesOf = (t, workspaceId) => auditOf(t, workspaceId, 'billing.renewal.notice')

/** Waits until the notice for the period that ends at `end` is recorded, and returns its entry. */
export async function noticed(t, text, workspaceId, end, expected) {
  await t.until(text, async () => {
    const mark = (await subscriptionOf(t, workspaceId)).renewal_notice_period_end
    return mark?.getTime() === end.getTime()
  })
  const notice = (await noticesOf(t, workspaceId)).at(-1)
  t.equal(`${text}: it names the tariff, the amount and the moment of the charge`, notice.meta, {
    ...expected,
    chargeAt: iso(end),
  })
  return notice
}

/** How the operator signs a command of the stand. */
export const signed = (reason) => ['--reason', `Проверка стенда: ${reason}`, '--operator', 'stand']
export const refundRequests = (t) => t.shop.sent('POST', '/v3/refunds')
export const refundEntries = async (t, workspaceId) =>
  (await auditOf(t, workspaceId)).filter(({ action }) => action.startsWith('billing.order.refund'))
