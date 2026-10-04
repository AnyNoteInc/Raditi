import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import process from 'node:process'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// The client and the notification parser of the platform (Node strips the types): whatever the
// fake answers or sends must be what web and core accept.
import {
  createYookassaClient,
  parseWebhookEvent,
  verifyTrustedIp,
  YookassaApiError,
} from '../../../packages/yookassa/src/index.ts'
import { BEHAVIOURS, DEFAULT_CARD, startFakeYookassa, TARGETS } from './fake-yookassa.mjs'

const SHOP = { shopId: '123456', secretKey: 'test_fake-shop-secret-key' }
const BASIC = Buffer.from(`${SHOP.shopId}:${SHOP.secretKey}`).toString('base64')
const RETURN_URL = 'http://127.0.0.1:3100/settings/billing/return?order=order_1'
const amount = (value = '4900.00') => ({ value, currency: 'RUB' })

async function start(t, options = {}) {
  const fake = await startFakeYookassa({ ...SHOP, ...options })
  t.after(() => fake.close())
  return fake
}
const clientOf = (fake, options = {}) =>
  createYookassaClient({ ...SHOP, baseUrl: fake.apiUrl, ...options })

/** A control command, as a stand sends it over HTTP. */
async function control(fake, command, body) {
  const response = await fetch(
    `${fake.controlUrl}/${command}`,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  )
  return { status: response.status, body: await response.json() }
}
const stateOf = async (fake) => (await control(fake, 'state')).body

/** Stands for web: collects notifications and answers `status`. */
async function receiver(t, status = 200) {
  const received = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    received.push({
      path: req.url,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    })
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { url: `http://127.0.0.1:${server.address().port}/api/webhooks/yookassa`, received }
}

/** A buyer presses a button of the page; the redirect is not followed. */
const press = (url, action) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action }).toString(),
    redirect: 'manual',
  })

const redirectPayment = (overrides = {}) => ({
  amount: amount(),
  capture: true,
  confirmation: { type: 'redirect', return_url: RETURN_URL },
  description: 'Тариф «Бизнес», 1 месяц',
  metadata: { order_id: 'order_1' },
  ...overrides,
})

/** Pays a first payment that saves its method; returns the saved method id. */
async function savedMethod(fake, client, key = 'first-payment') {
  const payment = await client.createPayment(redirectPayment({ save_payment_method: true }), key)
  await press(payment.confirmation.confirmation_url, 'pay')
  await fake.settle()
  const paid = await client.getPayment(payment.id)
  assert.equal(paid.payment_method.saved, true)
  return paid.payment_method.id
}
const charge = (methodId, value) => ({ amount: amount(value), payment_method_id: methodId })

test('listens on loopback only and takes nothing without the Basic auth of the shop', async (t) => {
  const fake = await start(t)
  assert.match(fake.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(fake.apiUrl, `${fake.url}/v3`)

  for (const headers of [
    {},
    { authorization: `Basic ${Buffer.from(`${SHOP.shopId}:wrong-secret-key`).toString('base64')}` },
    { authorization: `Bearer ${BASIC}` },
  ]) {
    const response = await fetch(`${fake.apiUrl}/payments/any`, { headers })
    assert.equal(response.status, 401)
    assert.equal((await response.json()).code, 'invalid_credentials')
  }
  await assert.rejects(
    createYookassaClient({ ...SHOP, secretKey: 'another-key', baseUrl: fake.apiUrl }).createPayment(
      redirectPayment(),
      'key-1',
    ),
    (error) => error instanceof YookassaApiError && error.status === 401,
  )
  // A refused request creates nothing and does not spend its key.
  assert.deepEqual((await stateOf(fake)).payments, [])
  assert.deepEqual((await stateOf(fake)).idempotenceKeys, [])
  assert.equal((await clientOf(fake).createPayment(redirectPayment(), 'key-1')).status, 'pending')
})

test('never stores or shows the credentials', async (t) => {
  const hook = await receiver(t)
  const fake = await start(t, { webhookUrl: hook.url })
  const client = clientOf(fake)
  await savedMethod(fake, client)
  await fetch(`${fake.apiUrl}/payments/x`, {
    headers: { authorization: 'Basic c2VjcmV0OnNlY3JldA==' },
  })

  const requests = (await control(fake, 'requests')).body
  assert.ok(requests.length >= 3)
  assert.deepEqual(Object.keys(requests[0]).sort(), [
    'at',
    'authorized',
    'body',
    'idempotenceKey',
    'method',
    'path',
    'status',
  ])
  assert.equal(requests.at(-1).authorized, false)
  const everything = JSON.stringify([requests, await stateOf(fake), hook.received])
  for (const secret of [SHOP.secretKey, BASIC, 'c2VjcmV0OnNlY3JldA==', 'authorization'])
    assert.equal(everything.includes(secret), false, secret)
})

test('refuses to start with a broken shop or a notification address outside loopback', async () => {
  await assert.rejects(startFakeYookassa({ ...SHOP, shopId: 'shop' }), /shopId must be digits/)
  await assert.rejects(startFakeYookassa({ ...SHOP, secretKey: 'short' }), /secretKey must be/)
  await assert.rejects(startFakeYookassa({ ...SHOP, port: 70_000 }), /Invalid port/)
  await assert.rejects(
    startFakeYookassa({ ...SHOP, forwardedFor: 'web' }),
    /forwardedFor must be an IP address/,
  )
  for (const webhookUrl of [
    'https://raditi.ru/api/webhooks/yookassa',
    'http://10.20.0.4:3000/api/webhooks/yookassa',
    'http://user:password@127.0.0.1:3000/hook',
    'ftp://127.0.0.1/hook',
    'not a url',
  ])
    await assert.rejects(
      startFakeYookassa({ ...SHOP, webhookUrl }),
      /^Error: webhookUrl must be an http\(s\) URL on loopback$/,
    )
  for (const webhookUrl of ['http://localhost:3000/hook', 'http://[::1]:3000/hook']) {
    const fake = await startFakeYookassa({ ...SHOP, webhookUrl })
    await fake.close()
  }
})

test('a payment by redirect: the page, «Оплатить», the answer of the API and the notification', async (t) => {
  const hook = await receiver(t)
  const fake = await start(t, { webhookUrl: hook.url })
  const client = clientOf(fake)

  const created = await client.createPayment(
    redirectPayment({ save_payment_method: true }),
    'checkout-1',
  )
  assert.equal(created.status, 'pending')
  assert.equal(created.paid, false)
  assert.equal(created.test, true)
  assert.deepEqual(created.amount, amount())
  assert.deepEqual(created.metadata, { order_id: 'order_1' })
  assert.deepEqual(created.confirmation, {
    type: 'redirect',
    confirmation_url: `${fake.url}/pay/${created.id}`,
  })
  assert.equal(created.payment_method, undefined)

  const page = await fetch(created.confirmation.confirmation_url)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /^text\/html; charset=utf-8$/)
  const html = await page.text()
  assert.match(html, /<button name="action" value="pay">Оплатить<\/button>/)
  assert.match(html, /<button name="action" value="refuse">Отказаться<\/button>/)
  assert.match(html, /Оплата 4900\.00 ₽/)
  assert.match(html, /Тариф «Бизнес», 1 месяц/)
  assert.match(html, /Деньги не списываются/)
  // Looking at the page changes nothing.
  assert.equal((await client.getPayment(created.id)).status, 'pending')
  assert.deepEqual(hook.received, [])

  const pressed = await press(created.confirmation.confirmation_url, 'pay')
  assert.equal(pressed.status, 303)
  assert.equal(pressed.headers.get('location'), RETURN_URL)
  await fake.settle()

  const paid = await client.getPayment(created.id)
  assert.equal(paid.status, 'succeeded')
  assert.equal(paid.paid, true)
  assert.equal(paid.refundable, true)
  assert.equal(paid.confirmation, undefined)
  assert.deepEqual(paid.income_amount, amount('4728.50'))
  assert.deepEqual(paid.payment_method, {
    type: 'bank_card',
    // As in the documentation: the saved method has the id of the payment that saved it.
    id: created.id,
    saved: true,
    status: 'active',
    title: 'Bank card *4444',
    card: DEFAULT_CARD,
  })

  assert.equal(hook.received.length, 1)
  const [notification] = hook.received
  assert.equal(notification.path, '/api/webhooks/yookassa')
  assert.equal(notification.headers['content-type'], 'application/json')
  // Exactly one address: web takes the sender from nowhere else.
  assert.equal(notification.headers['x-forwarded-for'], '127.0.0.1')
  assert.deepEqual(Object.keys(notification.body), ['type', 'event', 'object'])
  assert.equal(notification.body.type, 'notification')
  const event = parseWebhookEvent(notification.body)
  assert.equal(event.event, 'payment.succeeded')
  assert.deepEqual(event.object, paid)
  assert.deepEqual(
    (await stateOf(fake)).webhooks.deliveries.map(({ at: _at, ...rest }) => rest),
    [{ event: 'payment.succeeded', objectId: created.id, forwardedFor: '127.0.0.1', status: 200 }],
  )

  // A second press and a look at the page after the payment change nothing.
  assert.equal((await press(created.confirmation.confirmation_url, 'pay')).status, 303)
  const after = await (await fetch(created.confirmation.confirmation_url)).text()
  assert.doesNotMatch(after, /Оплатить|Отказаться/)
  assert.match(after, /Вернуться в магазин/)
  await fake.settle()
  assert.equal(hook.received.length, 1)
})

test('saves the payment method only when the payment asked for it', async (t) => {
  const fake = await start(t)
  const client = clientOf(fake)
  for (const [key, save_payment_method] of [
    ['no-flag', undefined],
    ['flag-false', false],
  ]) {
    const payment = await client.createPayment(
      redirectPayment(save_payment_method === undefined ? {} : { save_payment_method }),
      key,
    )
    await press(payment.confirmation.confirmation_url, 'pay')
    const paid = await client.getPayment(payment.id)
    assert.equal(paid.status, 'succeeded')
    assert.equal(paid.payment_method.saved, false)
    assert.equal(paid.payment_method.status, 'inactive')
    // A method that was not saved cannot be charged.
    await assert.rejects(
      client.chargeWithSavedMethod(charge(paid.payment_method.id), `charge-${key}`),
      (error) => error.status === 400 && error.body.parameter === 'payment_method_id',
    )
  }
  assert.deepEqual((await stateOf(fake)).savedMethodIds, [])
})

test('save-anyway: the method comes back saved though the payment said false', async (t) => {
  const fake = await start(t)
  const client = clientOf(fake)
  assert.deepEqual((await control(fake, 'save-anyway', { enabled: true })).body, {
    saveAnyway: true,
  })
  const payment = await client.createPayment(
    redirectPayment({ save_payment_method: false }),
    'no-consent',
  )
  await press(payment.confirmation.confirmation_url, 'pay')
  const paid = await client.getPayment(payment.id)
  assert.equal(paid.payment_method.saved, true)
  assert.equal(paid.payment_method.status, 'active')
  assert.equal((await control(fake, 'requests')).body[0].body.save_payment_method, false)
  // ЮKassa would let the shop charge it: only the shop's own consent check stops that.
  assert.equal(
    (await client.chargeWithSavedMethod(charge(paid.payment_method.id), 'charge')).status,
    'succeeded',
  )
  assert.equal((await control(fake, 'save-anyway', { enabled: 'yes' })).status, 400)
})

test('«Отказаться» cancels the payment and still returns the buyer to the shop', async (t) => {
  const hook = await receiver(t)
  const fake = await start(t, { webhookUrl: hook.url })
  const client = clientOf(fake)
  const payment = await client.createPayment(redirectPayment(), 'refused')

  const pressed = await press(payment.confirmation.confirmation_url, 'refuse')
  assert.equal(pressed.status, 303)
  assert.equal(pressed.headers.get('location'), RETURN_URL)
  await fake.settle()

  const canceled = await client.getPayment(payment.id)
  assert.equal(canceled.status, 'canceled')
  assert.equal(canceled.paid, false)
  assert.deepEqual(canceled.cancellation_details, {
    party: 'yoo_money',
    reason: 'expired_on_confirmation',
  })
  assert.equal(canceled.payment_method, undefined)
  const event = parseWebhookEvent(hook.received[0].body)
  assert.equal(event.event, 'payment.canceled')
  assert.deepEqual(event.object, canceled)

  assert.equal((await press(payment.confirmation.confirmation_url, 'dance')).status, 303)
  const other = await client.createPayment(redirectPayment(), 'unknown-action')
  assert.equal((await press(other.confirmation.confirmation_url, 'dance')).status, 400)
  assert.equal((await fetch(`${fake.url}/pay/no-such-payment`)).status, 404)
  assert.equal((await press(`${fake.url}/pay/no-such-payment`, 'pay')).status, 404)
})

test('Idempotence-Key: required, and a repeated key returns the first response', async (t) => {
  const fake = await start(t)
  const client = clientOf(fake)

  const missing = await fetch(`${fake.apiUrl}/payments`, {
    method: 'POST',
    headers: { authorization: `Basic ${BASIC}`, 'content-type': 'application/json' },
    body: JSON.stringify(redirectPayment()),
  })
  assert.equal(missing.status, 400)
  assert.deepEqual((({ code, parameter }) => ({ code, parameter }))(await missing.json()), {
    code: 'invalid_request',
    parameter: 'Idempotence-Key',
  })

  const first = await client.createPayment(redirectPayment(), 'order-1')
  await press(first.confirmation.confirmation_url, 'pay')
  // The first response, not the state of the payment now.
  assert.deepEqual(await client.createPayment(redirectPayment(), 'order-1'), first)
  assert.equal((await client.getPayment(first.id)).status, 'succeeded')
  // The same key with another request still answers with the first one, and says so in the log.
  assert.deepEqual(
    await client.createPayment(redirectPayment({ amount: amount('1.00') }), 'order-1'),
    first,
  )
  const other = await client.createPayment(redirectPayment(), 'order-2')
  assert.notEqual(other.id, first.id)

  let state = await stateOf(fake)
  assert.deepEqual(
    state.payments.map((payment) => payment.id),
    [first.id, other.id],
  )
  assert.deepEqual(state.idempotenceKeys, ['order-1', 'order-2'])
  const posts = (await control(fake, 'requests')).body.filter((entry) => entry.method === 'POST')
  assert.deepEqual(
    posts.map(({ idempotenceKey, replayed, sameRequest, status }) => ({
      idempotenceKey,
      replayed,
      sameRequest,
      status,
    })),
    [
      { idempotenceKey: undefined, replayed: undefined, sameRequest: undefined, status: 400 },
      { idempotenceKey: 'order-1', replayed: undefined, sameRequest: undefined, status: 200 },
      { idempotenceKey: 'order-1', replayed: true, sameRequest: true, status: 200 },
      { idempotenceKey: 'order-1', replayed: true, sameRequest: false, status: 200 },
      { idempotenceKey: 'order-2', replayed: undefined, sameRequest: undefined, status: 200 },
    ],
  )

  // A refusal is the first response of its key as well: ЮKassa wants a new key after a 400.
  const refused = { ...redirectPayment(), capture: false }
  await assert.rejects(client.createPayment(refused, 'order-3'), (error) => error.status === 400)
  await assert.rejects(
    client.createPayment(redirectPayment(), 'order-3'),
    (error) => error.status === 400 && error.body.parameter === 'capture',
  )

  // Real ЮKassa keeps a key for 24 hours; after that the same key is a new request.
  assert.deepEqual((await control(fake, 'forget-idempotence-keys', {})).body, { forgotten: 3 })
  const again = await client.createPayment(redirectPayment(), 'order-1')
  assert.notEqual(again.id, first.id)
  state = await stateOf(fake)
  assert.equal(state.payments.length, 3)
  assert.deepEqual(state.idempotenceKeys, ['order-1'])
})

test('a saved method is charged at once: succeeded, with a notification', async (t) => {
  const hook = await receiver(t)
  const fake = await start(t, { webhookUrl: hook.url })
  const client = clientOf(fake)
  const methodId = await savedMethod(fake, client)
  hook.received.length = 0

  const renewal = await client.chargeWithSavedMethod(
    { ...charge(methodId), description: 'Продление', metadata: { order_id: 'order_2' } },
    'renew.sub_1.1790000000000',
  )
  await fake.settle()

  assert.equal(renewal.status, 'succeeded')
  assert.equal(renewal.paid, true)
  assert.equal(renewal.confirmation, undefined)
  assert.equal(renewal.payment_method.id, methodId)
  assert.equal(renewal.payment_method.saved, true)
  assert.notEqual(renewal.id, methodId)
  assert.deepEqual(await client.getPayment(renewal.id), renewal)
  assert.equal(hook.received.length, 1)
  assert.deepEqual(parseWebhookEvent(hook.received[0].body).object, renewal)
  const sent = (await control(fake, 'requests')).body.at(-2)
  assert.deepEqual(sent.body, {
    ...charge(methodId),
    description: 'Продление',
    metadata: { order_id: 'order_2' },
    capture: true,
  })

  await assert.rejects(
    client.chargeWithSavedMethod(charge('no-such-method'), 'renew.sub_2.1'),
    (error) => error.status === 400 && error.code === 'invalid_request',
  )
})

test('behaviour cancel: the bank declines the charge with the reason given', async (t) => {
  const hook = await receiver(t)
  const fake = await start(t, { webhookUrl: hook.url })
  const client = clientOf(fake)
  const methodId = await savedMethod(fake, client)
  hook.received.length = 0

  const queued = await control(fake, 'behaviour', {
    target: 'saved',
    behaviour: 'cancel',
    reason: 'insufficient_funds',
  })
  assert.deepEqual(queued.body.behaviours.saved, [
    { behaviour: 'cancel', party: 'payment_network', reason: 'insufficient_funds' },
  ])

  const declined = await client.chargeWithSavedMethod(charge(methodId), 'renew.sub_1.1')
  await fake.settle()
  assert.equal(declined.status, 'canceled')
  assert.equal(declined.paid, false)
  assert.deepEqual(declined.cancellation_details, {
    party: 'payment_network',
    reason: 'insufficient_funds',
  })
  const event = parseWebhookEvent(hook.received[0].body)
  assert.equal(event.event, 'payment.canceled')
  assert.equal(event.object.cancellation_details.reason, 'insufficient_funds')

  // One behaviour, one payment: the next charge succeeds again.
  assert.equal(
    (await client.chargeWithSavedMethod(charge(methodId), 'renew.sub_1.2')).status,
    'succeeded',
  )
  // `times` repeats it; the party can be named, e.g. a permission revoked in the wallet.
  await control(fake, 'behaviour', {
    behaviour: 'cancel',
    reason: 'permission_revoked',
    party: 'yoo_money',
    times: 2,
  })
  for (const key of ['renew.sub_1.3', 'renew.sub_1.4']) {
    const again = await client.chargeWithSavedMethod(charge(methodId), key)
    assert.deepEqual(again.cancellation_details, {
      party: 'yoo_money',
      reason: 'permission_revoked',
    })
  }
  assert.deepEqual((await stateOf(fake)).behaviours.saved, [])
})

test('behaviour stay-pending: the charge hangs until a control command completes it', async (t) => {
  const hook = await receiver(t)
  const fake = await start(t, { webhookUrl: hook.url })
  const client = clientOf(fake)
  const methodId = await savedMethod(fake, client)
  hook.received.length = 0

  await control(fake, 'behaviour', { target: 'saved', behaviour: 'stay-pending', times: 3 })
  const stuck = await client.chargeWithSavedMethod(charge(methodId), 'renew.sub_1.1')
  assert.equal(stuck.status, 'pending')
  assert.equal(stuck.paid, false)
  assert.equal(stuck.confirmation, undefined)
  await fake.settle()
  assert.deepEqual(hook.received, [])
  // No page for a charge without the buyer.
  assert.equal((await fetch(`${fake.url}/pay/${stuck.id}`)).status, 404)

  const completed = await control(fake, 'complete', { paymentId: stuck.id })
  assert.equal(completed.status, 200)
  assert.equal(completed.body.status, 'succeeded')
  await fake.settle()
  assert.equal((await client.getPayment(stuck.id)).status, 'succeeded')
  assert.equal(parseWebhookEvent(hook.received[0].body).event, 'payment.succeeded')
  assert.equal((await control(fake, 'complete', { paymentId: stuck.id })).status, 409)

  const second = await client.chargeWithSavedMethod(charge(methodId), 'renew.sub_1.2')
  const canceled = await control(fake, 'complete', {
    paymentId: second.id,
    outcome: 'cancel',
    reason: 'card_expired',
  })
  assert.deepEqual(canceled.body.cancellation_details, {
    party: 'payment_network',
    reason: 'card_expired',
  })
  assert.equal((await control(fake, 'complete', { paymentId: second.id })).status, 409)
  assert.equal((await control(fake, 'complete', { paymentId: 'no-such-payment' })).status, 404)
  assert.equal((await control(fake, 'complete', {})).status, 400)

  // A command the fake does not understand leaves the payment pending.
  const third = await client.chargeWithSavedMethod(charge(methodId), 'renew.sub_1.3')
  for (const body of [
    { paymentId: third.id, outcome: 'explode' },
    { paymentId: third.id, outcome: 'cancel', reason: 'two words' },
  ])
    assert.equal((await control(fake, 'complete', body)).status, 400)
  assert.equal((await client.getPayment(third.id)).status, 'pending')
})

test('behaviour http-500-once: the charge is made, the answer is lost, the same key finds it', async (t) => {
  const fake = await start(t)
  const client = clientOf(fake)
  const methodId = await savedMethod(fake, client)

  await control(fake, 'behaviour', { target: 'saved', behaviour: 'http-500-once' })
  const error = await client
    .chargeWithSavedMethod(charge(methodId), 'renew.sub_1.1')
    .catch((caught) => caught)
  assert.ok(error instanceof YookassaApiError)
  assert.equal(error.status, 500)
  assert.equal(error.code, 'internal_server_error')
  assert.equal(error.retryable, true)

  // Money moved once: the repeat with the same key returns that payment, not a second one.
  const found = await client.chargeWithSavedMethod(charge(methodId), 'renew.sub_1.1')
  assert.equal(found.status, 'succeeded')
  assert.deepEqual(await client.chargeWithSavedMethod(charge(methodId), 'renew.sub_1.1'), found)
  let renewals = (await stateOf(fake)).payments.filter((payment) => payment.id !== methodId)
  assert.deepEqual(
    renewals.map((payment) => payment.id),
    [found.id],
  )

  // What a client with a bug does: a new key after the 500 charges the buyer twice.
  await control(fake, 'behaviour', { target: 'saved', behaviour: 'http-500-once' })
  await assert.rejects(client.chargeWithSavedMethod(charge(methodId), 'renew.sub_1.2'))
  await client.chargeWithSavedMethod(charge(methodId), 'renew.sub_1.2-retry')
  renewals = (await stateOf(fake)).payments.filter((payment) => payment.id !== methodId)
  assert.equal(renewals.length, 3)
  assert.ok(renewals.every((payment) => payment.status === 'succeeded'))

  // processed: false — the request died before ЮKassa did anything.
  await control(fake, 'behaviour', {
    target: 'saved',
    behaviour: 'http-500-once',
    processed: false,
  })
  await assert.rejects(
    client.chargeWithSavedMethod(charge(methodId), 'renew.sub_1.3'),
    (caught) => caught.status === 500,
  )
  assert.equal((await stateOf(fake)).payments.length, 4)
  assert.equal(
    (await client.chargeWithSavedMethod(charge(methodId), 'renew.sub_1.3')).status,
    'succeeded',
  )
  assert.equal((await stateOf(fake)).payments.length, 5)
})

test('behaviour timeout: no answer ever comes, the same key finds the payment', async (t) => {
  const fake = await start(t)
  const methodId = await savedMethod(fake, clientOf(fake))
  const impatient = clientOf(fake, { timeoutMs: 150 })

  await control(fake, 'behaviour', { target: 'saved', behaviour: 'timeout' })
  await assert.rejects(
    impatient.chargeWithSavedMethod(charge(methodId), 'renew.sub_1.1'),
    (error) => error.message === 'YooKassa request timed out' && error.retryable === true,
  )
  const found = await impatient.chargeWithSavedMethod(charge(methodId), 'renew.sub_1.1')
  assert.equal(found.status, 'succeeded')
  assert.equal((await stateOf(fake)).payments.length, 2)

  await control(fake, 'behaviour', { target: 'saved', behaviour: 'timeout', processed: false })
  await assert.rejects(impatient.chargeWithSavedMethod(charge(methodId), 'renew.sub_1.2'))
  assert.equal((await stateOf(fake)).payments.length, 2)
  const timedOut = (await control(fake, 'requests')).body.filter(
    (entry) => entry.behaviour === 'timeout',
  )
  assert.deepEqual(
    timedOut.map((entry) => entry.status),
    [null, null],
  )
})

test('behaviours of a payment by redirect apply when the buyer presses «Оплатить»', async (t) => {
  const hook = await receiver(t)
  const fake = await start(t, { webhookUrl: hook.url })
  const client = clientOf(fake)
  const methodId = await savedMethod(fake, client)
  hook.received.length = 0

  await control(fake, 'behaviour', {
    target: 'payment',
    behaviour: 'cancel',
    reason: 'card_expired',
  })
  await control(fake, 'behaviour', { target: 'payment', behaviour: 'stay-pending' })
  await control(fake, 'behaviour', { target: 'payment', behaviour: 'http-500-once' })
  await control(fake, 'behaviour', { target: 'payment', behaviour: 'succeed' })
  // The two targets do not mix: a charge with a saved method takes nothing from this queue.
  assert.equal(
    (await client.chargeWithSavedMethod(charge(methodId), 'renew.sub_1.1')).status,
    'succeeded',
  )
  await fake.settle()
  hook.received.length = 0

  const declined = await client.createPayment(redirectPayment(), 'declined')
  assert.equal(declined.status, 'pending')
  assert.equal((await press(declined.confirmation.confirmation_url, 'pay')).status, 303)
  assert.deepEqual((await client.getPayment(declined.id)).cancellation_details, {
    party: 'payment_network',
    reason: 'card_expired',
  })

  const stuck = await client.createPayment(redirectPayment(), 'stuck')
  assert.equal((await press(stuck.confirmation.confirmation_url, 'pay')).status, 303)
  assert.equal((await client.getPayment(stuck.id)).status, 'pending')
  assert.equal((await control(fake, 'complete', { paymentId: stuck.id })).body.status, 'succeeded')

  await assert.rejects(
    client.createPayment(redirectPayment(), 'lost-answer'),
    (error) => error.status === 500,
  )
  const lost = await client.createPayment(redirectPayment(), 'lost-answer')
  assert.equal(lost.status, 'pending')

  const plain = await client.createPayment(redirectPayment(), 'plain')
  await press(plain.confirmation.confirmation_url, 'pay')
  assert.equal((await client.getPayment(plain.id)).status, 'succeeded')

  await fake.settle()
  assert.deepEqual(
    hook.received.map((entry) => [entry.body.event, entry.body.object.id]),
    [
      ['payment.canceled', declined.id],
      ['payment.succeeded', stuck.id],
      ['payment.succeeded', plain.id],
    ],
  )
  assert.deepEqual((await stateOf(fake)).behaviours, { payment: [], saved: [] })
})

test('refuses a behaviour it does not know, naming what it takes', async (t) => {
  const fake = await start(t)
  assert.deepEqual(BEHAVIOURS, ['succeed', 'cancel', 'stay-pending', 'http-500-once', 'timeout'])
  assert.deepEqual(TARGETS, ['payment', 'saved'])
  for (const body of [
    { behaviour: 'explode' },
    { behaviour: 'cancel', target: 'refund' },
    { behaviour: 'succeed', reason: 'insufficient_funds' },
    { behaviour: 'cancel', reason: 'two words' },
    { behaviour: 'cancel', times: 0 },
    { behaviour: 'timeout', processed: 'no' },
    [],
  ]) {
    const refused = await control(fake, 'behaviour', body)
    assert.equal(refused.status, 400, JSON.stringify(body))
    assert.equal(typeof refused.body.error, 'string')
  }
  assert.deepEqual((await stateOf(fake)).behaviours, { payment: [], saved: [] })
  assert.equal((await control(fake, 'no-such-command', {})).status, 404)
  const broken = await fetch(`${fake.controlUrl}/behaviour`, { method: 'POST', body: '{not json' })
  assert.equal(broken.status, 400)
})

test('withholds notifications, sends them on command, from another address or forged', async (t) => {
  const hook = await receiver(t)
  const fake = await start(t, { webhookUrl: hook.url, forwardedFor: '127.0.0.1' })
  const client = clientOf(fake)

  assert.deepEqual((await control(fake, 'webhooks', { enabled: false })).body, { enabled: false })
  const payment = await client.createPayment(redirectPayment(), 'lost-webhook')
  await press(payment.confirmation.confirmation_url, 'pay')
  await fake.settle()
  assert.deepEqual(hook.received, [])
  assert.deepEqual(
    (await stateOf(fake)).webhooks.deliveries.map(({ at: _at, ...rest }) => rest),
    [
      {
        event: 'payment.succeeded',
        objectId: payment.id,
        forwardedFor: '127.0.0.1',
        withheld: true,
      },
    ],
  )

  // Sent on command while still withheld; the delivery is the answer.
  const sent = await control(fake, 'notify', { paymentId: payment.id })
  assert.equal(sent.status, 200)
  assert.equal(sent.body.status, 200)
  assert.equal(hook.received.length, 1)
  assert.deepEqual(
    parseWebhookEvent(hook.received[0].body).object,
    await client.getPayment(payment.id),
  )

  // «From» an address outside the allowlist of web: the body is genuine, the sender is not.
  const foreign = await control(fake, 'notify', {
    paymentId: payment.id,
    forwardedFor: '203.0.113.7',
  })
  assert.equal(foreign.body.forwardedFor, '203.0.113.7')
  assert.equal(hook.received[1].headers['x-forwarded-for'], '203.0.113.7')
  const allowlist = ['127.0.0.1']
  const senders = hook.received.map((entry) =>
    verifyTrustedIp(entry.headers['x-forwarded-for'], allowlist, { requireAllowlist: false }),
  )
  assert.deepEqual(senders, [true, false])

  // A forged body: it says «succeeded» about a payment the API still calls pending.
  const pending = await client.createPayment(redirectPayment(), 'forged')
  assert.equal((await control(fake, 'notify', { paymentId: pending.id })).status, 409)
  const forged = await control(fake, 'notify', {
    paymentId: pending.id,
    event: 'payment.succeeded',
    object: { status: 'succeeded', paid: true },
  })
  assert.equal(forged.status, 200)
  const claim = parseWebhookEvent(hook.received[2].body)
  assert.equal(claim.event, 'payment.succeeded')
  assert.equal(claim.object.id, pending.id)
  assert.equal(claim.object.status, 'succeeded')
  assert.equal((await client.getPayment(pending.id)).status, 'pending')

  for (const body of [
    { paymentId: payment.id, forwardedFor: 'web' },
    { paymentId: payment.id, object: 'succeeded' },
    { paymentId: payment.id, refundId: 'both' },
    {},
  ])
    assert.equal((await control(fake, 'notify', body)).status, 400)
  assert.equal((await control(fake, 'notify', { paymentId: 'no-such-payment' })).status, 404)
  assert.equal((await control(fake, 'webhooks', { enabled: 'no' })).status, 400)

  assert.deepEqual((await control(fake, 'webhooks', { enabled: true })).body, { enabled: true })
  await press(pending.confirmation.confirmation_url, 'pay')
  await fake.settle()
  assert.equal(hook.received.length, 4)
})

test('sends a notification once, whatever the answer, and from the configured address', async (t) => {
  const failing = await receiver(t, 500)
  const fake = await start(t, { webhookUrl: failing.url, forwardedFor: '185.71.76.10' })
  const client = clientOf(fake)
  const payment = await client.createPayment(redirectPayment(), 'failing-hook')
  await press(payment.confirmation.confirmation_url, 'pay')
  assert.equal((await control(fake, 'settle', {})).body.deliveries[0].status, 500)
  await delay(50)
  // No retries.
  assert.equal(failing.received.length, 1)
  assert.equal(failing.received[0].headers['x-forwarded-for'], '185.71.76.10')

  // Nobody listens: the delivery fails, the payment does not.
  const closed = createServer()
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve))
  const closedPort = closed.address().port
  await new Promise((resolve) => closed.close(resolve))
  const deaf = await start(t, { webhookUrl: `http://127.0.0.1:${closedPort}/hook` })
  const other = await clientOf(deaf).createPayment(redirectPayment(), 'deaf-hook')
  await press(other.confirmation.confirmation_url, 'pay')
  await deaf.settle()
  assert.equal((await stateOf(deaf)).webhooks.deliveries[0].error, 'failed')
  assert.equal((await clientOf(deaf).getPayment(other.id)).status, 'succeeded')

  // Without a notification address nothing is sent and a command to send is refused.
  const silent = await start(t)
  const third = await clientOf(silent).createPayment(redirectPayment(), 'no-hook')
  await press(third.confirmation.confirmation_url, 'pay')
  assert.equal((await stateOf(silent)).webhooks.deliveries[0].skipped, 'no webhook URL')
  assert.equal((await control(silent, 'notify', { paymentId: third.id })).status, 409)
})

test('a payment method saved without a payment: the page, «Привязать», payment_method.active', async (t) => {
  const hook = await receiver(t)
  const fake = await start(t, { webhookUrl: hook.url })
  const client = clientOf(fake)
  const input = {
    type: 'bank_card',
    confirmation: { type: 'redirect', return_url: RETURN_URL },
    metadata: { subscription_id: 'sub_1' },
  }

  const created = await client.createPaymentMethod(input, 'bind-1')
  assert.deepEqual(created, {
    id: created.id,
    type: 'bank_card',
    saved: false,
    status: 'pending',
    confirmation: { type: 'redirect', confirmation_url: `${fake.url}/pay/${created.id}` },
    metadata: { subscription_id: 'sub_1' },
  })
  assert.deepEqual(await client.createPaymentMethod(input, 'bind-1'), created)
  assert.deepEqual(await client.getPaymentMethod(created.id), created)
  // Not saved yet: it cannot be charged.
  await assert.rejects(client.chargeWithSavedMethod(charge(created.id), 'too-early'))

  const html = await (await fetch(created.confirmation.confirmation_url)).text()
  assert.match(html, /<button name="action" value="pay">Привязать<\/button>/)
  assert.match(html, /<button name="action" value="refuse">Отказаться<\/button>/)
  assert.match(html, /Привязка способа оплаты/)

  await control(fake, 'card', { last4: '1111', card_type: 'Visa', first6: '411111' })
  const pressed = await press(created.confirmation.confirmation_url, 'pay')
  assert.equal(pressed.status, 303)
  assert.equal(pressed.headers.get('location'), RETURN_URL)
  await fake.settle()

  const active = await client.getPaymentMethod(created.id)
  assert.deepEqual(active, {
    id: created.id,
    type: 'bank_card',
    saved: true,
    status: 'active',
    title: 'Bank card *1111',
    card: { ...DEFAULT_CARD, last4: '1111', card_type: 'Visa', first6: '411111' },
    metadata: { subscription_id: 'sub_1' },
  })
  assert.equal(hook.received.length, 1)
  assert.equal(hook.received[0].headers['x-forwarded-for'], '127.0.0.1')
  const event = parseWebhookEvent(hook.received[0].body)
  assert.equal(event.event, 'payment_method.active')
  assert.deepEqual(event.object, active)

  const renewal = await client.chargeWithSavedMethod(charge(created.id), 'renew.sub_1.1')
  assert.equal(renewal.status, 'succeeded')
  assert.deepEqual(renewal.payment_method, {
    type: 'bank_card',
    id: created.id,
    saved: true,
    status: 'active',
    title: 'Bank card *1111',
    card: active.card,
  })

  // «Отказаться»: inactive, and ЮKassa has no notification for that.
  const refused = await client.createPaymentMethod({ ...input, type: 'sbp' }, 'bind-2')
  assert.equal(refused.type, 'sbp')
  await press(refused.confirmation.confirmation_url, 'refuse')
  await fake.settle()
  const inactive = await client.getPaymentMethod(refused.id)
  assert.equal(inactive.status, 'inactive')
  assert.equal(inactive.saved, false)
  assert.equal(hook.received.length, 2)

  // An СБП account has no card; a control command binds it without the page.
  const sbp = await client.createPaymentMethod({ ...input, type: 'sbp' }, 'bind-3')
  const bound = await control(fake, 'complete', { paymentMethodId: sbp.id })
  assert.equal(bound.body.status, 'active')
  assert.equal(bound.body.title, 'СБП')
  assert.equal(bound.body.card, undefined)
  assert.equal((await client.getPaymentMethod(sbp.id)).card, undefined)

  await assert.rejects(
    client.getPaymentMethod('no-such-method'),
    (error) => error.status === 404 && error.code === 'not_found',
  )
  assert.equal((await control(fake, 'card', { last4: '12' })).status, 400)
  assert.equal((await control(fake, 'card', { cvc: '123' })).status, 400)
})

test('refunds: once per key, never beyond the payment, with refund.succeeded', async (t) => {
  const hook = await receiver(t)
  const fake = await start(t, { webhookUrl: hook.url })
  const client = clientOf(fake)
  const payment = await client.createPayment(redirectPayment(), 'to-refund')

  await assert.rejects(
    client.createRefund({ payment_id: payment.id, amount: amount() }, 'refund.pending'),
    (error) => error.status === 400 && error.body.parameter === 'payment_id',
  )
  await press(payment.confirmation.confirmation_url, 'pay')
  await fake.settle()
  hook.received.length = 0

  const part = await client.createRefund(
    { payment_id: payment.id, amount: amount('1900.00'), description: 'Возврат' },
    'refund.order_1',
  )
  assert.equal(part.status, 'succeeded')
  assert.equal(part.payment_id, payment.id)
  assert.deepEqual(part.amount, amount('1900.00'))
  assert.deepEqual(await client.getRefund(part.id), part)
  // The command repeated with its key: the same refund, no second one.
  assert.deepEqual(
    await client.createRefund(
      { payment_id: payment.id, amount: amount('1900.00'), description: 'Возврат' },
      'refund.order_1',
    ),
    part,
  )
  await fake.settle()
  let refunded = await client.getPayment(payment.id)
  assert.deepEqual(refunded.refunded_amount, amount('1900.00'))
  assert.equal(refunded.refundable, true)
  assert.equal(hook.received.length, 1)
  const event = parseWebhookEvent(hook.received[0].body)
  assert.equal(event.event, 'refund.succeeded')
  assert.deepEqual(event.object, part)

  await assert.rejects(
    client.createRefund({ payment_id: payment.id, amount: amount('3000.01') }, 'refund.too-much'),
    (error) => error.status === 400 && error.body.parameter === 'amount',
  )
  const rest = await client.createRefund(
    { payment_id: payment.id, amount: amount('3000.00') },
    'refund.rest',
  )
  refunded = await client.getPayment(payment.id)
  assert.deepEqual(refunded.refunded_amount, amount())
  assert.equal(refunded.refundable, false)
  await assert.rejects(
    client.createRefund({ payment_id: payment.id, amount: amount('1.00') }, 'refund.nothing-left'),
  )
  await assert.rejects(
    client.createRefund({ payment_id: 'no-such-payment', amount: amount() }, 'refund.unknown'),
  )
  await assert.rejects(client.getRefund('no-such-refund'), (error) => error.status === 404)
  assert.deepEqual(
    (await stateOf(fake)).refunds.map((refund) => refund.id),
    [part.id, rest.id],
  )
  assert.equal((await control(fake, 'complete', { refundId: part.id })).status, 400)
})

test('refuses what the platform must never send: a receipt, two stages, broken money', async (t) => {
  const fake = await start(t)
  const post = async (body, key) => {
    const response = await fetch(`${fake.apiUrl}/payments`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${BASIC}`,
        'content-type': 'application/json',
        'idempotence-key': key,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  const cases = [
    ['receipt', redirectPayment({ receipt: { items: [] } })],
    ['capture', redirectPayment({ capture: false })],
    ['capture', (({ capture: _capture, ...rest }) => rest)(redirectPayment())],
    ['amount', redirectPayment({ amount: { value: 4900, currency: 'RUB' } })],
    ['amount', redirectPayment({ amount: amount('4900.0') })],
    ['amount', redirectPayment({ amount: amount('0.00') })],
    ['amount', redirectPayment({ amount: { value: '10.00', currency: 'USD' } })],
    ['confirmation', (({ confirmation: _confirmation, ...rest }) => rest)(redirectPayment())],
    ['confirmation', redirectPayment({ confirmation: { type: 'embedded' } })],
    ['confirmation', redirectPayment({ confirmation: { type: 'redirect', return_url: '/back' } })],
    ['metadata', redirectPayment({ metadata: { order_id: 1 } })],
    ['description', redirectPayment({ description: 'я'.repeat(129) })],
    ['save_payment_method', redirectPayment({ save_payment_method: 'true' })],
  ]
  for (const [index, [parameter, body]] of cases.entries()) {
    const refused = await post(body, `refused-${index}`)
    assert.equal(refused.status, 400, parameter)
    assert.equal(refused.body.type, 'error')
    assert.equal(refused.body.code, 'invalid_request')
    assert.equal(refused.body.parameter, parameter)
  }
  for (const [index, body] of ['{not json', '[]', 'null'].entries())
    assert.equal((await post(body, `broken-${index}`)).status, 400)
  assert.deepEqual((await stateOf(fake)).payments, [])

  const unknown = await fetch(`${fake.apiUrl}/receipts`, {
    method: 'POST',
    headers: { authorization: `Basic ${BASIC}`, 'idempotence-key': 'receipt-1' },
    body: '{}',
  })
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).code, 'not_found')
  assert.equal((await fetch(`${fake.url}/`)).status, 404)
})

test('reset forgets payments, keys, behaviours and the log, and keeps the shop', async (t) => {
  const hook = await receiver(t)
  const fake = await start(t, { webhookUrl: hook.url })
  const client = clientOf(fake)
  const methodId = await savedMethod(fake, client)
  await control(fake, 'behaviour', { behaviour: 'stay-pending' })
  await control(fake, 'webhooks', { enabled: false })
  await control(fake, 'save-anyway', { enabled: true })
  await control(fake, 'card', { last4: '0000' })

  const cleared = await control(fake, 'reset', {})
  assert.deepEqual(cleared.body, {
    payments: [],
    paymentMethods: [],
    refunds: [],
    savedMethodIds: [],
    behaviours: { payment: [], saved: [] },
    idempotenceKeys: [],
    saveAnyway: false,
    card: DEFAULT_CARD,
    webhooks: { enabled: true, url: hook.url, forwardedFor: '127.0.0.1', deliveries: [] },
  })
  assert.deepEqual((await control(fake, 'requests')).body, [])
  await assert.rejects(client.getPayment(methodId), (error) => error.status === 404)
  assert.equal((await client.createPayment(redirectPayment(), 'first-payment')).status, 'pending')
})

test(
  'standalone: the shop comes from the environment, only readiness is printed, SIGTERM stops it',
  { timeout: 10_000 },
  async (t) => {
    const script = fileURLToPath(new URL('./fake-yookassa.mjs', import.meta.url))
    const run = (args, env) => {
      const child = spawn(process.execPath, [script, ...args], {
        env: { PATH: process.env.PATH, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      t.after(() => child.kill('SIGKILL'))
      const output = { stdout: '', stderr: '' }
      child.stdout.on('data', (chunk) => (output.stdout += chunk))
      child.stderr.on('data', (chunk) => (output.stderr += chunk))
      return { child, output, exited: new Promise((resolve) => child.once('exit', resolve)) }
    }
    const shop = { YOOKASSA_SHOP_ID: SHOP.shopId, YOOKASSA_SECRET_KEY: SHOP.secretKey }

    const { child, output, exited } = run(
      ['--port', '0', '--webhook-url', 'http://127.0.0.1:9/hook', '--forwarded-for', '127.0.0.1'],
      shop,
    )
    for (let i = 0; i < 500 && !output.stdout.includes('\n'); i++) await delay(10)
    const ready = JSON.parse(output.stdout.trim())
    assert.deepEqual(Object.keys(ready).sort(), ['port', 'ready'])
    const client = createYookassaClient({ ...SHOP, baseUrl: `http://127.0.0.1:${ready.port}/v3` })
    const payment = await client.createPayment(redirectPayment(), 'standalone')
    assert.equal(
      payment.confirmation.confirmation_url,
      `http://127.0.0.1:${ready.port}/pay/${payment.id}`,
    )
    child.kill('SIGTERM')
    assert.equal(await exited, 0)
    assert.deepEqual(JSON.parse(output.stdout.trim()), ready)
    assert.equal(output.stderr, '')

    // Broken settings: one line that names the option and shows no value.
    for (const [args, env, message] of [
      [[], { YOOKASSA_SHOP_ID: SHOP.shopId }, 'secretKey must be at least 8 characters'],
      [[], { YOOKASSA_SECRET_KEY: SHOP.secretKey }, 'shopId must be digits only'],
      [
        ['--webhook-url', 'https://raditi.ru/hook'],
        shop,
        'webhookUrl must be an http(s) URL on loopback',
      ],
      [['--secret-key', SHOP.secretKey], shop, 'Invalid arguments'],
      [['--port'], shop, 'Invalid arguments'],
    ]) {
      const failed = run(args, env)
      assert.equal(await failed.exited, 1)
      assert.equal(failed.output.stdout, '')
      assert.equal(failed.output.stderr, `Fake YooKassa failed: ${message}\n`)
      assert.equal(failed.output.stderr.includes(SHOP.secretKey), false)
    }
  },
)
