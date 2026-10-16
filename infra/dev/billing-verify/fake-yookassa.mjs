import { Buffer } from 'node:buffer'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// A synthetic ЮKassa for local stands and tests: no money, no real shop. It listens on
// 127.0.0.1 only, keeps everything in memory and calls nothing but the notification URL it was
// given, which must be on loopback too. Credentials are never written anywhere: requests are
// recorded without their Authorization header, and nothing but the readiness line is printed.

const HOST = '127.0.0.1'
const AMOUNT = /^(0|[1-9]\d{0,9})\.\d{2}$/
const MAX_BODY_BYTES = 1024 * 1024
const WEBHOOK_TIMEOUT_MS = 10_000
// ЮKassa keeps commission 3.5% of a card payment made to a self-employed seller.
const FEE_PER_MILLE = 35
/** The longest a behaviour may hold a request back: a stand waits for it. */
const MAX_DELAY_MS = 60_000

/** What the next payment does; see README.md for the two targets. */
export const BEHAVIOURS = Object.freeze([
  'succeed',
  'cancel',
  'stay-pending',
  'http-500-once',
  'timeout',
])
/** `payment` — paid on the page of the fake; `saved` — charged with a saved payment method. */
export const TARGETS = Object.freeze(['payment', 'saved'])
export const DEFAULT_CARD = Object.freeze({
  first6: '220000',
  last4: '4444',
  expiry_year: '2030',
  expiry_month: '12',
  card_type: 'Mir',
  issuer_country: 'RU',
})

const now = () => new Date().toISOString()
const kopecks = (value) => Number(value.replace('.', ''))
const rubles = (amount) => `${Math.trunc(amount / 100)}.${String(amount % 100).padStart(2, '0')}`
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  )

/** An answer of the API that is not an object: `{type: "error", code, description}`. */
class Refusal extends Error {
  constructor(status, code, description, parameter) {
    super(description)
    this.status = status
    this.body = { type: 'error', id: randomUUID(), code, description }
    if (parameter) this.body.parameter = parameter
  }
}
const invalid = (parameter, description) =>
  new Refusal(400, 'invalid_request', description, parameter)
const notFound = (what) => new Refusal(404, 'not_found', `${what} was not found`)
/**
 * What a real shop answered, with valid credentials, to a payment that asked to save its method
 * while ЮKassa had not approved autopayments for it (AnyNote, 13.05.2026): 403 with this code.
 * The description is the one AnyNote's client test quotes.
 */
const forbidden = () =>
  new Refusal(403, 'forbidden', 'Магазин не имеет права на проведение операции')
/**
 * What a shop needs approved autopayments for. Seen on a real shop: a payment with
 * `save_payment_method: true`. Assumed, tried nowhere: binding a method without a payment and
 * charging a saved one need the same right. A payment that leaves the field out was accepted by
 * that shop; that an explicit `false` is accepted as well is an assumption too.
 */
const needsAutopayments = (collection, body) =>
  collection === 'payment_methods' ||
  (collection === 'payments' &&
    (body.save_payment_method === true || body.payment_method_id != null))
/** A mistake in a control command: answered with 400 and never recorded as an API request. */
class ControlError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

function amountOf(body) {
  const amount = body.amount
  if (
    !isRecord(amount) ||
    typeof amount.value !== 'string' ||
    !AMOUNT.test(amount.value) ||
    kopecks(amount.value) === 0 ||
    amount.currency !== 'RUB'
  )
    throw invalid('amount', 'Amount must be a positive decimal string with two decimals, in RUB')
  return { value: amount.value, currency: 'RUB' }
}

function metadataOf(body) {
  if (body.metadata === undefined) return undefined
  const entries = isRecord(body.metadata) ? Object.entries(body.metadata) : null
  if (
    entries === null ||
    entries.length > 16 ||
    !entries.every(
      ([key, value]) =>
        key.length >= 1 && key.length <= 32 && typeof value === 'string' && value.length <= 512,
    )
  )
    throw invalid('metadata', 'Metadata holds up to 16 string values of up to 512 characters')
  return Object.fromEntries(entries)
}

function returnUrlOf(body) {
  const confirmation = body.confirmation
  if (
    !isRecord(confirmation) ||
    confirmation.type !== 'redirect' ||
    typeof confirmation.return_url !== 'string' ||
    confirmation.return_url.length > 2048 ||
    !URL.canParse(confirmation.return_url) ||
    !/^https?:$/.test(new URL(confirmation.return_url).protocol)
  )
    throw invalid('confirmation', 'The fake confirms by redirect only: {type, return_url}')
  return confirmation.return_url
}

function descriptionOf(body, limit) {
  if (body.description === undefined) return undefined
  if (typeof body.description !== 'string' || body.description.length > limit)
    throw invalid('description', `Description is a string of up to ${limit} characters`)
  return body.description
}

function loopbackUrl(value, name) {
  if (value === undefined || value === null) return null
  const url = typeof value === 'string' && URL.canParse(value) ? new URL(value) : null
  const host = url?.hostname.replace(/^\[|\]$/g, '')
  if (
    url === null ||
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    !(host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.')))
  )
    throw new Error(`${name} must be an http(s) URL on loopback`)
  return url.href
}

function behaviourOf(input) {
  if (!isRecord(input)) throw new ControlError('Expected {target, behaviour}')
  const {
    target = 'saved',
    behaviour,
    reason,
    party,
    processed = true,
    times = 1,
    delayMs = 0,
  } = input
  if (!TARGETS.includes(target)) throw new ControlError(`target is one of ${TARGETS.join(', ')}`)
  if (!BEHAVIOURS.includes(behaviour))
    throw new ControlError(`behaviour is one of ${BEHAVIOURS.join(', ')}`)
  if (!Number.isInteger(times) || times < 1 || times > 1000)
    throw new ControlError('times is an integer from 1 to 1000')
  if (typeof processed !== 'boolean') throw new ControlError('processed is a boolean')
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS)
    throw new ControlError(`delayMs is an integer from 0 to ${MAX_DELAY_MS}`)
  const cancel = behaviour === 'cancel'
  for (const [name, value] of Object.entries({ reason, party }))
    if (value !== undefined && (!cancel || typeof value !== 'string' || !/^\w{1,64}$/.test(value)))
      throw new ControlError(`${name} is a word, and only with behaviour "cancel"`)
  return {
    target,
    times,
    entry: {
      behaviour,
      ...(cancel ? { party: party ?? 'payment_network', reason: reason ?? 'general_decline' } : {}),
      ...(behaviour === 'http-500-once' || behaviour === 'timeout' ? { processed } : {}),
      ...(delayMs > 0 ? { delayMs } : {}),
    },
  }
}

function cardOf(input) {
  if (!isRecord(input)) throw new ControlError('Expected card fields')
  const card = { ...DEFAULT_CARD, ...input }
  const shape = {
    first6: /^\d{6}$/,
    last4: /^\d{4}$/,
    expiry_year: /^\d{4}$/,
    expiry_month: /^(0[1-9]|1[0-2])$/,
    card_type: /^[A-Za-z]{1,32}$/,
    issuer_country: /^[A-Z]{2}$/,
  }
  if (
    Object.keys(card).length !== Object.keys(shape).length ||
    !Object.entries(shape).every(
      ([name, pattern]) => typeof card[name] === 'string' && pattern.test(card[name]),
    )
  )
    throw new ControlError(`card takes ${Object.keys(shape).join(', ')}`)
  return card
}

function payPage({ heading, description, accept, pending }) {
  const body = pending
    ? `<form method="post">
        <button name="action" value="pay">${accept}</button>
        <button name="action" value="refuse">Отказаться</button>
      </form>`
    : `<form method="post"><button name="action" value="return">Вернуться в магазин</button></form>`
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Поддельная ЮKassa</title>
    <style>
      body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; }
      main { max-width: 480px; margin: 0 auto; }
      .note { padding: 8px 12px; border: 1px solid; }
      button { font: inherit; padding: 8px 16px; margin: 0 8px 8px 0; }
    </style>
  </head>
  <body>
    <main>
      <p class="note">Поддельная ЮKassa для локальных стендов. Деньги не списываются.</p>
      <h1>${escapeHtml(heading)}</h1>
      ${description ? `<p>${escapeHtml(description)}</p>` : ''}
      ${pending ? '' : '<p>Здесь больше нечего подтверждать.</p>'}
      ${body}
    </main>
  </body>
</html>
`
}

async function bodyOf(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })

/**
 * Starts the fake on 127.0.0.1. `shopId` and `secretKey` are what Basic auth must carry;
 * `webhookUrl` (loopback only) receives notifications with `X-Forwarded-For: <forwardedFor>`.
 */
export async function startFakeYookassa({
  shopId,
  secretKey,
  port = 0,
  webhookUrl,
  forwardedFor = '127.0.0.1',
} = {}) {
  if (typeof shopId !== 'string' || !/^\d+$/.test(shopId))
    throw new Error('shopId must be digits only')
  if (typeof secretKey !== 'string' || secretKey.length < 8)
    throw new Error('secretKey must be at least 8 characters')
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Invalid port')
  if (isIP(forwardedFor) === 0) throw new Error('forwardedFor must be an IP address')
  const notificationUrl = loopbackUrl(webhookUrl, 'webhookUrl')
  const expectedAuth = Buffer.from(
    `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`,
  )

  const closing = new AbortController()
  /** Answers held back by `timeout`: closed only when the client gives up or the fake stops. */
  const hanging = new Set()
  const inFlight = new Set()
  let origin = ''
  let state

  function reset() {
    state = {
      payments: new Map(),
      paymentMethods: new Map(),
      refunds: new Map(),
      /** Payment methods a charge may name: saved by a payment or bound without one. */
      saved: new Map(),
      idempotence: new Map(),
      queue: { payment: [], saved: [] },
      requests: [],
      deliveries: [],
      webhooksEnabled: true,
      saveAnyway: false,
      /** false: ЮKassa has not approved autopayments for the shop (`autopayments` command). */
      autopayments: true,
      card: { ...DEFAULT_CARD },
    }
  }
  reset()

  // ── notifications ────────────────────────────────────────────────────────────────────────

  function deliver(event, object, from = forwardedFor) {
    const delivery = { at: now(), event, objectId: object.id, forwardedFor: from }
    state.deliveries.push(delivery)
    if (notificationUrl === null) {
      delivery.skipped = 'no webhook URL'
      return Promise.resolve(delivery)
    }
    const sending = fetch(notificationUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': from },
      body: JSON.stringify({ type: 'notification', event, object }),
      redirect: 'manual',
      signal: AbortSignal.any([closing.signal, AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)]),
    })
      .then(async (response) => {
        delivery.status = response.status
        await response.arrayBuffer()
      })
      .catch((error) => {
        delivery.error = error?.name === 'TimeoutError' ? 'timed out' : 'failed'
      })
      .then(() => {
        inFlight.delete(sending)
        return delivery
      })
    inFlight.add(sending)
    return sending
  }

  /** After a status change: the object as it is at this moment, unless webhooks are withheld. */
  function notify(event, object) {
    const snapshot = structuredClone(object)
    if (state.webhooksEnabled) void deliver(event, snapshot)
    else
      state.deliveries.push({
        at: now(),
        event,
        objectId: object.id,
        forwardedFor,
        withheld: true,
      })
  }

  // ── objects ──────────────────────────────────────────────────────────────────────────────

  const cardMethod = (id, saved) => ({
    type: 'bank_card',
    id,
    saved,
    status: saved ? 'active' : 'inactive',
    title: `Bank card *${state.card.last4}`,
    card: { ...state.card },
  })

  function succeedPayment(record) {
    const payment = record.object
    const amount = kopecks(payment.amount.value)
    payment.status = 'succeeded'
    payment.paid = true
    payment.refundable = true
    payment.captured_at = now()
    payment.income_amount = {
      value: rubles(amount - Math.round((amount * FEE_PER_MILLE) / 1000)),
      currency: 'RUB',
    }
    delete payment.confirmation
    if (!record.savedMethodId) {
      // Real ЮKassa may save a method the shop did not ask to save: the buyer ticks the box.
      const saved = record.saveRequested || state.saveAnyway
      payment.payment_method = cardMethod(payment.id, saved)
      if (saved) state.saved.set(payment.id, structuredClone(payment.payment_method))
    }
    notify('payment.succeeded', payment)
  }

  function cancelPayment(record, party, reason) {
    const payment = record.object
    payment.status = 'canceled'
    payment.paid = false
    payment.refundable = false
    payment.cancellation_details = { party, reason }
    delete payment.confirmation
    notify('payment.canceled', payment)
  }

  /** The attempt to pay: at creation with a saved method, on «Оплатить» otherwise. */
  function attempt(record) {
    const { behaviour, party, reason } = record.plan
    if (behaviour === 'succeed') succeedPayment(record)
    else if (behaviour === 'cancel') cancelPayment(record, party, reason)
  }

  function createPayment(body, plan) {
    if (body.receipt !== undefined)
      throw invalid('receipt', 'The shop is self-employed: no receipt object is expected')
    const amount = amountOf(body)
    if (body.capture !== true)
      throw invalid('capture', 'The fake takes one-stage payments only: capture must be true')
    const description = descriptionOf(body, 128)
    const metadata = metadataOf(body)
    if (body.save_payment_method !== undefined && typeof body.save_payment_method !== 'boolean')
      throw invalid('save_payment_method', 'save_payment_method is a boolean')
    const id = randomUUID()
    const payment = {
      id,
      status: 'pending',
      paid: false,
      amount,
      ...(description === undefined ? {} : { description }),
      recipient: { account_id: shopId, gateway_id: '1' },
      created_at: now(),
      ...(metadata === undefined ? {} : { metadata }),
      refundable: false,
      test: true,
    }
    const record = { object: payment, plan, saveRequested: body.save_payment_method === true }
    if (body.payment_method_id !== undefined) {
      const method = state.saved.get(body.payment_method_id)
      if (typeof body.payment_method_id !== 'string' || method === undefined)
        throw invalid('payment_method_id', 'No saved payment method with this id')
      record.savedMethodId = method.id
      payment.payment_method = structuredClone(method)
      state.payments.set(id, record)
      attempt(record)
    } else {
      record.returnUrl = returnUrlOf(body)
      payment.confirmation = { type: 'redirect', confirmation_url: `${origin}/pay/${id}` }
      state.payments.set(id, record)
    }
    return payment
  }

  function createPaymentMethod(body) {
    if (body.type !== 'bank_card' && body.type !== 'sbp')
      throw invalid('type', 'A payment method is saved for bank_card or sbp')
    const returnUrl = returnUrlOf(body)
    const metadata = metadataOf(body)
    const id = randomUUID()
    const method = {
      id,
      type: body.type,
      saved: false,
      status: 'pending',
      holder: { account_id: shopId, gateway_id: '1' },
      confirmation: { type: 'redirect', confirmation_url: `${origin}/pay/${id}` },
      ...(metadata === undefined ? {} : { metadata }),
    }
    state.paymentMethods.set(id, { object: method, returnUrl })
    return method
  }

  function confirmPaymentMethod(record, accepted) {
    const method = record.object
    delete method.confirmation
    if (!accepted) {
      method.status = 'inactive'
      return
    }
    method.status = 'active'
    method.saved = true
    if (method.type === 'bank_card') {
      method.title = `Bank card *${state.card.last4}`
      method.card = { ...state.card }
    } else method.title = 'СБП'
    // As a payment shows the method it was charged with.
    state.saved.set(method.id, {
      type: method.type,
      id: method.id,
      saved: true,
      status: 'active',
      title: method.title,
      ...(method.card ? { card: { ...method.card } } : {}),
    })
    notify('payment_method.active', method)
  }

  function createRefund(body) {
    const record =
      typeof body.payment_id === 'string' ? state.payments.get(body.payment_id) : undefined
    if (record === undefined) throw invalid('payment_id', 'No payment with this id')
    const payment = record.object
    if (payment.status !== 'succeeded')
      throw invalid('payment_id', 'Only a succeeded payment can be refunded')
    const amount = amountOf(body)
    const refunded = kopecks(payment.refunded_amount?.value ?? '0.00') + kopecks(amount.value)
    if (refunded > kopecks(payment.amount.value))
      throw invalid('amount', 'The refund exceeds what is left of the payment')
    const description = descriptionOf(body, 250)
    const metadata = metadataOf(body)
    payment.refunded_amount = { value: rubles(refunded), currency: 'RUB' }
    payment.refundable = refunded < kopecks(payment.amount.value)
    const refund = {
      id: randomUUID(),
      payment_id: payment.id,
      status: 'succeeded',
      amount,
      created_at: now(),
      ...(description === undefined ? {} : { description }),
      ...(metadata === undefined ? {} : { metadata }),
    }
    state.refunds.set(refund.id, { object: refund })
    notify('refund.succeeded', refund)
    return refund
  }

  // ── the API ──────────────────────────────────────────────────────────────────────────────

  const send = (res, status, body, entry) => {
    if (entry) entry.status = status
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  function authorized(req) {
    const given = Buffer.from(req.headers.authorization ?? '')
    return given.length === expectedAuth.length && timingSafeEqual(given, expectedAuth)
  }

  async function handleApi(req, res, path) {
    const key = req.headers['idempotence-key']
    const entry = {
      at: now(),
      method: req.method,
      path,
      ...(typeof key === 'string' ? { idempotenceKey: key } : {}),
      authorized: authorized(req),
    }
    state.requests.push(entry)
    const text = await bodyOf(req)
    if (!entry.authorized)
      return send(
        res,
        401,
        new Refusal(401, 'invalid_credentials', 'Basic auth with the shop id and key').body,
        entry,
      )

    const [, collection, id, ...rest] = path.split('/').slice(1)
    const stores = {
      payments: state.payments,
      payment_methods: state.paymentMethods,
      refunds: state.refunds,
    }
    const store = Object.hasOwn(stores, collection ?? '') ? stores[collection] : undefined
    try {
      if (store === undefined || rest.length > 0) throw notFound('The resource')
      if (req.method === 'GET' && id !== undefined) {
        const record = store.get(decodeURIComponent(id))
        if (record === undefined) throw notFound('The object')
        return send(res, 200, record.object, entry)
      }
      if (req.method !== 'POST' || id !== undefined) throw notFound('The resource')
    } catch (error) {
      if (error instanceof Refusal) return send(res, error.status, error.body, entry)
      throw error
    }

    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(key))
      return send(
        res,
        400,
        invalid('Idempotence-Key', 'Idempotence-Key header of 1–64 characters is required').body,
        entry,
      )
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    entry.body = body
    // A shop without approved autopayments is refused at the door, as with a wrong key: before
    // the Idempotence-Key is looked up, with nothing stored under it and no behaviour spent.
    // Once the approval is given, the same key makes the payment.
    if (!state.autopayments && isRecord(body) && needsAutopayments(collection, body))
      return send(res, 403, forbidden().body, entry)
    const fingerprint = `${path}\n${JSON.stringify(body)}`
    const known = state.idempotence.get(key)
    if (known !== undefined) {
      // ЮKassa answers a repeated key with the result of the first request; a repeat that
      // comes while a slow first one is still being made waits for it.
      entry.replayed = true
      const first = await known
      entry.sameRequest = first.fingerprint === fingerprint
      return send(res, first.status, first.body, entry)
    }

    // The behaviour is taken before validation: a refused request spends it too.
    const saved = collection === 'payments' && isRecord(body) && body.payment_method_id != null
    const queued =
      collection === 'payments' ? state.queue[saved ? 'saved' : 'payment'].shift() : undefined
    const transport =
      queued?.behaviour === 'http-500-once' || queued?.behaviour === 'timeout' ? queued : null
    // Unless a behaviour says otherwise the attempt to pay succeeds: at once with a saved
    // method, on «Оплатить» of the page otherwise.
    const plan = queued && !transport ? queued : { behaviour: 'succeed' }
    if (queued) entry.behaviour = queued.behaviour
    // A slow bank: nothing is made and nothing is answered until the delay has passed. The key
    // is taken at once, so a repeat during the delay gets this request's answer, not a second
    // payment.
    let made
    if (queued?.delayMs) {
      state.idempotence.set(key, new Promise((resolve) => (made = resolve)))
      await sleep(queued.delayMs, undefined, { signal: closing.signal })
    }
    if (transport && !transport.processed) {
      // No payment and no stored answer: the key is free again for whoever repeats.
      if (made) state.idempotence.delete(key)
      made?.({
        fingerprint,
        ...new Refusal(500, 'internal_server_error', 'The outcome of the request is unknown'),
      })
      return fail(res, entry, transport.behaviour)
    }

    let answer
    try {
      if (!isRecord(body)) throw invalid(undefined, 'The body must be a JSON object')
      const created =
        collection === 'payments'
          ? createPayment(body, plan)
          : collection === 'payment_methods'
            ? createPaymentMethod(body)
            : createRefund(body)
      answer = { status: 200, body: structuredClone(created) }
    } catch (error) {
      if (!(error instanceof Refusal)) throw error
      answer = { status: error.status, body: error.body }
    }
    state.idempotence.set(key, { fingerprint, ...answer })
    made?.({ fingerprint, ...answer })
    if (transport) return fail(res, entry, transport.behaviour)
    return send(res, answer.status, answer.body, entry)
  }

  /** `http-500-once` answers 500; `timeout` never answers. */
  function fail(res, entry, behaviour) {
    if (behaviour === 'timeout') {
      entry.status = null
      hanging.add(res)
      res.on('close', () => hanging.delete(res))
      return
    }
    send(
      res,
      500,
      new Refusal(500, 'internal_server_error', 'The outcome of the request is unknown').body,
      entry,
    )
  }

  // ── the page the buyer is redirected to ──────────────────────────────────────────────────

  async function handlePage(req, res, id) {
    const payment = state.payments.get(id)
    const method = state.paymentMethods.get(id)
    const record = payment ?? method
    if (record === undefined || record.returnUrl === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Нет такого платежа.\n')
    }
    const pending = record.object.status === 'pending'
    if (req.method === 'POST') {
      const action = new URLSearchParams(await bodyOf(req)).get('action')
      if (pending && action === 'pay') {
        if (payment) attempt(payment)
        else confirmPaymentMethod(method, true)
      } else if (pending && action === 'refuse') {
        // A buyer who leaves the page: the payment expires unconfirmed.
        if (payment) cancelPayment(payment, 'yoo_money', 'expired_on_confirmation')
        else confirmPaymentMethod(method, false)
      } else if (action !== 'return' && pending) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('Неизвестное действие.\n')
      }
      // ЮKassa sends the buyer back whatever the outcome; the shop asks the API for it.
      res.writeHead(303, { location: record.returnUrl, 'cache-control': 'no-store' })
      return res.end()
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET, POST' })
      return res.end()
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    })
    res.end(
      payPage(
        payment
          ? {
              heading: `Оплата ${payment.object.amount.value} ₽`,
              description: payment.object.description,
              accept: 'Оплатить',
              pending,
            }
          : {
              heading: 'Привязка способа оплаты',
              description: 'Списаний не будет: способ оплаты только сохраняется.',
              accept: 'Привязать',
              pending,
            },
      ),
    )
  }

  // ── the control API of stands and tests ──────────────────────────────────────────────────

  const objects = (store) => [...store.values()].map((record) => record.object)
  const snapshot = () => ({
    payments: objects(state.payments),
    paymentMethods: objects(state.paymentMethods),
    refunds: objects(state.refunds),
    savedMethodIds: [...state.saved.keys()],
    behaviours: state.queue,
    idempotenceKeys: [...state.idempotence.keys()],
    saveAnyway: state.saveAnyway,
    autopayments: state.autopayments,
    card: state.card,
    webhooks: {
      enabled: state.webhooksEnabled,
      url: notificationUrl,
      forwardedFor,
      deliveries: state.deliveries,
    },
  })

  function target(input) {
    if (!isRecord(input)) throw new ControlError('Expected an object')
    const names = { paymentId: state.payments, paymentMethodId: state.paymentMethods }
    const given = [...Object.keys(names), 'refundId'].filter((name) => input[name] !== undefined)
    if (given.length !== 1)
      throw new ControlError('Name exactly one of paymentId, paymentMethodId, refundId')
    const [name] = given
    const store = name === 'refundId' ? state.refunds : names[name]
    const record = store.get(input[name])
    if (record === undefined) throw new ControlError('No such object', 404)
    return { kind: name.replace(/Id$/, ''), record }
  }

  function complete(input) {
    const { kind, record } = target(input)
    if (kind === 'refund') throw new ControlError('A refund is never pending')
    if (record.object.status !== 'pending') throw new ControlError('The object is not pending', 409)
    const outcome = input.outcome ?? (record.plan?.behaviour === 'cancel' ? 'cancel' : 'succeed')
    if (outcome !== 'succeed' && outcome !== 'cancel')
      throw new ControlError('outcome is succeed or cancel')
    if (kind === 'paymentMethod') confirmPaymentMethod(record, outcome === 'succeed')
    else if (outcome === 'succeed') succeedPayment(record)
    else {
      const planned = record.plan.behaviour === 'cancel' ? record.plan : {}
      const { entry } = behaviourOf({
        behaviour: 'cancel',
        party: input.party ?? planned.party,
        reason: input.reason ?? planned.reason,
      })
      cancelPayment(record, entry.party, entry.reason)
    }
    return record.object
  }

  async function notifyNow(input) {
    const { kind, record } = target(input)
    if (notificationUrl === null) throw new ControlError('No webhook URL was given at start', 409)
    const from = input.forwardedFor ?? forwardedFor
    if (typeof from !== 'string' || isIP(from) === 0)
      throw new ControlError('forwardedFor is an IP address')
    if (input.object !== undefined && !isRecord(input.object))
      throw new ControlError('object holds the fields to forge')
    const status = record.object.status
    const event =
      input.event ??
      (kind === 'payment' && (status === 'succeeded' || status === 'canceled')
        ? `payment.${status}`
        : kind === 'paymentMethod' && status === 'active'
          ? 'payment_method.active'
          : kind === 'refund'
            ? 'refund.succeeded'
            : undefined)
    if (typeof event !== 'string' || !/^[a-z_]+\.[a-z_]+$/.test(event))
      throw new ControlError('Nothing to notify of in this status: name the event to forge', 409)
    // `object` overrides fields: a forged body the API of the fake does not confirm.
    return deliver(event, { ...structuredClone(record.object), ...input.object }, from)
  }

  async function handleControl(req, res, command) {
    const reply = (body, status = 200) => send(res, status, body)
    if (req.method === 'GET' && command === 'state') return reply(snapshot())
    if (req.method === 'GET' && command === 'requests') return reply(state.requests)
    if (req.method !== 'POST') return reply({ error: 'Unknown control command' }, 404)
    const text = await bodyOf(req)
    let input
    try {
      input = text === '' ? {} : JSON.parse(text)
    } catch {
      return reply({ error: 'The body must be JSON' }, 400)
    }
    try {
      switch (command) {
        case 'behaviour': {
          const { target: queue, times, entry } = behaviourOf(input)
          for (let i = 0; i < times; i++) state.queue[queue].push({ ...entry })
          return reply({ behaviours: state.queue })
        }
        case 'complete':
          return reply(complete(input))
        case 'webhooks':
          if (typeof input.enabled !== 'boolean') throw new ControlError('enabled is a boolean')
          state.webhooksEnabled = input.enabled
          return reply({ enabled: state.webhooksEnabled })
        case 'notify':
          return reply(await notifyNow(input))
        case 'save-anyway':
          if (typeof input.enabled !== 'boolean') throw new ControlError('enabled is a boolean')
          state.saveAnyway = input.enabled
          return reply({ saveAnyway: state.saveAnyway })
        case 'autopayments':
          if (typeof input.enabled !== 'boolean') throw new ControlError('enabled is a boolean')
          state.autopayments = input.enabled
          return reply({ autopayments: state.autopayments })
        case 'card':
          state.card = cardOf(input)
          return reply({ card: state.card })
        case 'forget-idempotence-keys': {
          const forgotten = state.idempotence.size
          state.idempotence.clear()
          return reply({ forgotten })
        }
        case 'settle':
          await settle()
          return reply({ deliveries: state.deliveries })
        case 'reset':
          await settle()
          reset()
          return reply(snapshot())
        default:
          return reply({ error: 'Unknown control command' }, 404)
      }
    } catch (error) {
      if (error instanceof ControlError) return reply({ error: error.message }, error.status)
      throw error
    }
  }

  /** Resolves when every notification sent so far has been answered or has failed. */
  async function settle() {
    while (inFlight.size > 0) await Promise.all(inFlight)
  }

  // ── the server ───────────────────────────────────────────────────────────────────────────

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fake').pathname
    const route = path.startsWith('/v3/')
      ? handleApi(req, res, path)
      : path.startsWith('/pay/')
        ? handlePage(req, res, path.slice('/pay/'.length))
        : path.startsWith('/__control/')
          ? handleControl(req, res, path.slice('/__control/'.length))
          : Promise.resolve(send(res, 404, { error: 'Not found' }))
    route.catch(() => {
      if (res.headersSent) res.destroy()
      else send(res, 400, invalid(undefined, 'Malformed request').body)
    })
  })
  await listen(server, port)
  origin = `http://${HOST}:${server.address().port}`

  return {
    port: server.address().port,
    url: origin,
    /** YOOKASSA_API_URL of web and core. */
    apiUrl: `${origin}/v3`,
    controlUrl: `${origin}/__control`,
    settle,
    close: async () => {
      closing.abort()
      for (const res of hanging) res.destroy()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await Promise.allSettled(inFlight)
    },
  }
}

async function main(args) {
  const names = {
    '--port': 'port',
    '--webhook-url': 'webhookUrl',
    '--forwarded-for': 'forwardedFor',
  }
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]]
    if (!name || args[i + 1] === undefined || Object.hasOwn(options, name))
      throw new Error('Invalid arguments')
    options[name] = name === 'port' ? Number(args[i + 1]) : args[i + 1]
  }
  // The shop of the stand comes from the environment, as web and core take it: never from argv.
  const fake = await startFakeYookassa({
    ...options,
    shopId: process.env.YOOKASSA_SHOP_ID,
    secretKey: process.env.YOOKASSA_SECRET_KEY,
  })
  process.stdout.write(`${JSON.stringify({ ready: true, port: fake.port })}\n`)
  let closing = false
  const stop = async () => {
    if (!closing) {
      closing = true
      await fake.close()
    }
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    // Configuration mistakes name the option, never a value.
    process.stderr.write(`Fake YooKassa failed: ${error?.message ?? 'unknown error'}\n`)
    process.exitCode = 1
  })
