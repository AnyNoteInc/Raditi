import { Buffer } from 'node:buffer'

import type { z } from 'zod'

import { YookassaApiError, YookassaError } from './errors.ts'
import {
  chargeSavedInputSchema,
  createPaymentInputSchema,
  createPaymentMethodInputSchema,
  createRefundInputSchema,
  errorBodySchema,
  paymentSchema,
  refundSchema,
  savedPaymentMethodSchema,
  type ChargeSavedInput,
  type CreatePaymentInput,
  type CreatePaymentMethodInput,
  type CreateRefundInput,
  type Payment,
  type Refund,
  type SavedPaymentMethod,
} from './schemas.ts'

export interface YookassaClientOptions {
  shopId: string
  secretKey: string
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

/**
 * Every POST carries an Idempotence-Key: ЮKassa keeps it for 24 hours, so a retry of a
 * failed or timed-out call with the same key never charges twice.
 */
export interface YookassaClient {
  createPayment(input: CreatePaymentInput, idempotenceKey: string): Promise<Payment>
  chargeWithSavedMethod(input: ChargeSavedInput, idempotenceKey: string): Promise<Payment>
  getPayment(paymentId: string): Promise<Payment>
  /** Saves a payment method without a payment; the answer carries `confirmation_url`. */
  createPaymentMethod(
    input: CreatePaymentMethodInput,
    idempotenceKey: string,
  ): Promise<SavedPaymentMethod>
  getPaymentMethod(paymentMethodId: string): Promise<SavedPaymentMethod>
  createRefund(input: CreateRefundInput, idempotenceKey: string): Promise<Refund>
  getRefund(refundId: string): Promise<Refund>
}

const DEFAULT_BASE_URL = 'https://api.yookassa.ru/v3'
const DEFAULT_TIMEOUT_MS = 30_000
/**
 * Narrower than what ЮKassa accepts, on purpose: letters, digits, dot, hyphen and underscore.
 * Our keys are UUIDs, `renew.<subscriptionId>.<ms>` and `refund.<orderId>`; a colon from a
 * credit_ledger key must fail here, before the request, not at the API.
 */
const IDEMPOTENCE_KEY = /^[A-Za-z0-9._-]{1,64}$/

/** The credentials stay in this closure: the client object has nothing secret to log. */
export function createYookassaClient(options: YookassaClientOptions): YookassaClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const authorization = `Basic ${Buffer.from(`${options.shopId}:${options.secretKey}`).toString('base64')}`
  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function request<S extends z.ZodType>(
    schema: S,
    path: string,
    init: { method: 'GET' } | { method: 'POST'; body: unknown; idempotenceKey: string },
  ): Promise<z.output<S>> {
    const headers: Record<string, string> = { Authorization: authorization }
    let body: string | undefined
    if (init.method === 'POST') {
      headers['Content-Type'] = 'application/json'
      headers['Idempotence-Key'] = init.idempotenceKey
      body = JSON.stringify(init.body)
    }

    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: init.method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'failed'
      throw new YookassaError(`YooKassa request ${reason}`, { cause: err, retryable: true })
    }

    const json: unknown = await response.json().catch(() => undefined)

    if (!response.ok) {
      const parsed = errorBodySchema.safeParse(json)
      const err = parsed.success ? parsed.data : {}
      const parts = [err.code, err.description, err.parameter && `parameter=${err.parameter}`]
      const message = parts.filter(Boolean).join(': ') || 'YooKassa API request failed'
      throw new YookassaApiError(message, response.status, err.code, json)
    }

    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      throw new YookassaError('Unexpected YooKassa response', { cause: parsed.error })
    }
    return parsed.data
  }

  return {
    async createPayment(input, idempotenceKey) {
      return request(paymentSchema, '/payments', {
        method: 'POST',
        body: validate(createPaymentInputSchema, input, 'payment'),
        idempotenceKey: checkIdempotenceKey(idempotenceKey),
      })
    },

    async chargeWithSavedMethod(input, idempotenceKey) {
      const charge = validate(chargeSavedInputSchema, input, 'charge')
      return request(paymentSchema, '/payments', {
        method: 'POST',
        body: { ...charge, capture: true },
        idempotenceKey: checkIdempotenceKey(idempotenceKey),
      })
    },

    async getPayment(paymentId) {
      return request(paymentSchema, `/payments/${pathId(paymentId)}`, { method: 'GET' })
    },

    async createPaymentMethod(input, idempotenceKey) {
      return request(savedPaymentMethodSchema, '/payment_methods', {
        method: 'POST',
        body: validate(createPaymentMethodInputSchema, input, 'payment method'),
        idempotenceKey: checkIdempotenceKey(idempotenceKey),
      })
    },

    async getPaymentMethod(paymentMethodId) {
      return request(savedPaymentMethodSchema, `/payment_methods/${pathId(paymentMethodId)}`, {
        method: 'GET',
      })
    },

    async createRefund(input, idempotenceKey) {
      return request(refundSchema, '/refunds', {
        method: 'POST',
        body: validate(createRefundInputSchema, input, 'refund'),
        idempotenceKey: checkIdempotenceKey(idempotenceKey),
      })
    },

    async getRefund(refundId) {
      return request(refundSchema, `/refunds/${pathId(refundId)}`, { method: 'GET' })
    },
  }
}

function validate<S extends z.ZodType>(schema: S, input: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    throw new YookassaError(`Invalid ${what} input: ${problems.join('; ')}`, {
      cause: parsed.error,
    })
  }
  return parsed.data
}

function checkIdempotenceKey(key: string): string {
  if (!IDEMPOTENCE_KEY.test(key)) {
    throw new YookassaError(
      'Idempotence-Key must be 1–64 characters: letters, digits, dot, hyphen and underscore',
    )
  }
  return key
}

function pathId(id: string): string {
  if (id.length === 0) throw new YookassaError('Empty object id')
  return encodeURIComponent(id)
}
