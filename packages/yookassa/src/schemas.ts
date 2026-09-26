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

// TODO(M5): `receipt` for 54-FZ (customer e-mail or phone, items with vat_code,
// payment_subject and payment_mode); the scheme for wallet top-ups is open (spec §20).
export const createPaymentInputSchema = z.strictObject({
  amount: chargeAmountSchema,
  capture: z.boolean(),
  save_payment_method: z.boolean().optional(),
  payment_method_id: z.string().min(1).optional(),
  payment_method_data: z.strictObject({ type: z.string().min(1) }).optional(),
  confirmation: z
    .strictObject({ type: z.literal('redirect'), return_url: z.url({ protocol: /^https?$/ }) })
    .optional(),
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

const responseMetadataSchema = z.record(z.string(), z.string())

const cancellationDetailsSchema = z.object({ party: z.string(), reason: z.string() })

export const paymentMethodSchema = z.object({
  id: z.string(),
  type: z.string(),
  saved: z.boolean().default(false),
  title: z.string().optional(),
  card: z
    .object({
      first6: z.string().optional(),
      last4: z.string().optional(),
      expiry_month: z.string().optional(),
      expiry_year: z.string().optional(),
      card_type: z.string().optional(),
      issuer_country: z.string().optional(),
      issuer_name: z.string().optional(),
    })
    .optional(),
})
export type PaymentMethod = z.infer<typeof paymentMethodSchema>

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
