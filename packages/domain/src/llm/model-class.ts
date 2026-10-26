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

/**
 * How hard the model thinks, as the owner of a site picks it when a dialog starts (owner's
 * request of 26.10.2026): the three profiles of the one model are its reasoning levels `low`,
 * `high` and `max` (spec §20, П5), so the choice is the class of the dialog.
 */
export const reasoningEfforts = ['low', 'high', 'max'] as const
export const reasoningEffortSchema = z.enum(reasoningEfforts)
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>

const classOfEffort = Object.freeze({
  low: 'light',
  high: 'standard',
  max: 'heavy',
} satisfies Record<ReasoningEffort, ModelClass>)

export const modelClassOfEffort = (effort: ReasoningEffort): ModelClass => classOfEffort[effort]

const effortOfClass = Object.freeze({
  light: 'low',
  standard: 'high',
  heavy: 'max',
} satisfies Record<ModelClass, ReasoningEffort>)

/** The level a dialog thinks at, from its class: the switch of a started dialog shows it. */
export const effortOfModelClass = (modelClass: ModelClass): ReasoningEffort =>
  effortOfClass[modelClass]
