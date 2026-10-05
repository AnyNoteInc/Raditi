import { z } from 'zod'

/** Product profiles; the legacy database enum keeps service until the P4 contract migration. */
export const modelClasses = ['light', 'standard', 'heavy'] as const
export const modelClassSchema = z.enum(modelClasses)
export type ModelClass = z.infer<typeof modelClassSchema>

/** RUB including VAT, admission ceilings per attempt on a quota plan (spec §17). */
export const quotaAttemptCeilingsRub = Object.freeze({
  light: '135.00',
  standard: '285.00',
  heavy: '735.00',
} satisfies Record<ModelClass, string>)
