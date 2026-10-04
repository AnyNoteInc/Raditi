import { z } from 'zod'

/**
 * Money on the wire: a decimal string with exactly two decimals, "4900.00" (spec §17).
 * Never a float and never integer kopecks; convert a Decimal with toFixed(2) only after
 * making sure it has no more than two decimals.
 */
export const amountValueSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,9})\.\d{2}$/, 'must be a decimal string with two decimals, e.g. "4900.00"')

export const positiveAmountValueSchema = amountValueSchema.refine(
  (value) => value !== '0.00',
  'must be greater than zero',
)

export const amountSchema = z.object({
  value: amountValueSchema,
  currency: z.literal('RUB'),
})
export type Amount = z.infer<typeof amountSchema>

const chargeAmountSchema = z.strictObject({
  value: positiveAmountValueSchema,
  currency: z.literal('RUB'),
})

/** ЮKassa limits: up to 16 keys, key up to 32 characters, value up to 512 characters. */
export const metadataSchema = z
  .record(z.string().min(1).max(32), z.string().max(512))
  .refine((m) => Object.keys(m).length <= 16, 'at most 16 metadata keys')

const redirectConfirmationSchema = z.strictObject({
  type: z.literal('redirect'),
  return_url: z.url({ protocol: /^https?$/ }),
})

// The seller is self-employed (НПД): there is no 54-ФЗ receipt, so no `receipt` object is sent.
export const createPaymentInputSchema = z.strictObject({
  amount: chargeAmountSchema,
  capture: z.boolean(),
  save_payment_method: z.boolean().optional(),
  payment_method_id: z.string().min(1).optional(),
  payment_method_data: z.strictObject({ type: z.string().min(1) }).optional(),
  confirmation: redirectConfirmationSchema.optional(),
  description: z.string().max(128).optional(),
  metadata: metadataSchema.optional(),
})
export type CreatePaymentInput = z.input<typeof createPaymentInputSchema>

/** Recurring charge with a saved payment method: no confirmation, captured at once. */
export const chargeSavedInputSchema = z.strictObject({
  amount: chargeAmountSchema,
  payment_method_id: z.string().min(1),
  description: z.string().max(128).optional(),
  metadata: metadataSchema.optional(),
})
export type ChargeSavedInput = z.input<typeof chargeSavedInputSchema>

export const createRefundInputSchema = z.strictObject({
  payment_id: z.string().min(1),
  amount: chargeAmountSchema,
  description: z.string().max(250).optional(),
  metadata: metadataSchema.optional(),
})
export type CreateRefundInput = z.input<typeof createRefundInputSchema>

/** What can be saved without a payment (POST /payment_methods): a bank card or an СБП account. */
export const savablePaymentMethodTypes = ['bank_card', 'sbp'] as const
export type SavablePaymentMethodType = (typeof savablePaymentMethodTypes)[number]

/**
 * Saves a payment method without charging it: the user confirms on the ЮKassa page and comes
 * back to `return_url`; the page lives for an hour. Card data never passes through us.
 */
export const createPaymentMethodInputSchema = z.strictObject({
  type: z.enum(savablePaymentMethodTypes),
  confirmation: redirectConfirmationSchema,
  metadata: metadataSchema.optional(),
})
export type CreatePaymentMethodInput = z.input<typeof createPaymentMethodInputSchema>

const responseMetadataSchema = z.record(z.string(), z.string())

// `reason` stays a plain string: ЮKassa adds reasons, and an unknown one must not fail a read.
const cancellationDetailsSchema = z.object({ party: z.string(), reason: z.string() })

/** pending — waits for the user; active — saved, usable for charges; inactive — not saved. */
export const paymentMethodStatuses = ['pending', 'active', 'inactive'] as const
export type PaymentMethodStatus = (typeof paymentMethodStatuses)[number]

const cardSchema = z.object({
  first6: z.string().optional(),
  last4: z.string().optional(),
  expiry_month: z.string().optional(),
  expiry_year: z.string().optional(),
  card_type: z.string().optional(),
  issuer_country: z.string().optional(),
  issuer_name: z.string().optional(),
})

/**
 * The method a payment was made with. Only `saved: true` means it can be charged again:
 * `status` is `inactive` for every payment that did not try to save its method.
 */
export const paymentMethodSchema = z.object({
  id: z.string(),
  type: z.string(),
  saved: z.boolean().default(false),
  status: z.enum(paymentMethodStatuses).optional(),
  title: z.string().optional(),
  card: cardSchema.optional(),
})
export type PaymentMethod = z.infer<typeof paymentMethodSchema>

/** The object of POST and GET /payment_methods; `confirmation` is there while it is pending. */
export const savedPaymentMethodSchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  saved: z.boolean(),
  status: z.enum(paymentMethodStatuses),
  title: z.string().optional(),
  card: cardSchema.optional(),
  confirmation: z
    .object({
      type: z.string(),
      confirmation_url: z.string().optional(),
      return_url: z.string().optional(),
    })
    .optional(),
  metadata: responseMetadataSchema.optional(),
})
export type SavedPaymentMethod = z.infer<typeof savedPaymentMethodSchema>

export const paymentStatuses = ['pending', 'waiting_for_capture', 'succeeded', 'canceled'] as const
export type PaymentStatus = (typeof paymentStatuses)[number]

export const paymentSchema = z.object({
  id: z.string().min(1),
  status: z.enum(paymentStatuses),
  paid: z.boolean(),
  amount: amountSchema,
  income_amount: amountSchema.optional(),
  refunded_amount: amountSchema.optional(),
  description: z.string().optional(),
  created_at: z.string(),
  captured_at: z.string().optional(),
  expires_at: z.string().optional(),
  confirmation: z
    .object({
      type: z.string(),
      confirmation_url: z.string().optional(),
      return_url: z.string().optional(),
    })
    .optional(),
  payment_method: paymentMethodSchema.optional(),
  metadata: responseMetadataSchema.optional(),
  cancellation_details: cancellationDetailsSchema.optional(),
  refundable: z.boolean().optional(),
  test: z.boolean().optional(),
})
export type Payment = z.infer<typeof paymentSchema>

export const refundStatuses = ['pending', 'succeeded', 'canceled'] as const
export type RefundStatus = (typeof refundStatuses)[number]

export const refundSchema = z.object({
  id: z.string().min(1),
  payment_id: z.string().min(1),
  status: z.enum(refundStatuses),
  amount: amountSchema,
  description: z.string().optional(),
  created_at: z.string(),
  metadata: responseMetadataSchema.optional(),
  cancellation_details: cancellationDetailsSchema.optional(),
})
export type Refund = z.infer<typeof refundSchema>

export const errorBodySchema = z.object({
  type: z.string().optional(),
  id: z.string().optional(),
  code: z.string().optional(),
  description: z.string().optional(),
  parameter: z.string().optional(),
})
