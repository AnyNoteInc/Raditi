// Reference data for the idempotent seed (prisma/seed.ts). Pure: no I/O, no Prisma runtime.
// Money and prices are decimal strings, never JS numbers (spec §16).
import type { AgentCapabilities, AgentDriverId } from '@repo/domain'

import type { ModelClass, PlanKind } from '../../src/generated/prisma/enums.ts'

/** A decimal number as a string, e.g. "4900.00": money never passes through a JS number. */
export type DecimalString = string

/** Start of a Moscow calendar day: tariffs and our rules switch at local midnight. */
export function moscowMidnight(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00+03:00`)
}

// ─── Plans (docs/business.md §6) ──────────────────────────────────────────────
//
// The credits of the tariffs and of the pack are the numbers of the credits model (spec §17): a
// database seeded with the terms of before gets them by the migration billing_credit_amounts,
// which runs before this seed.

/** Everything except name and sortOrder is a plan term: the seed creates it but never changes it. */
export interface PlanSeed {
  slug: string
  name: string
  kind: PlanKind
  /** RUB without VAT (the seller is self-employed), Decimal(12,2). */
  price: DecimalString
  creditsPerMonth: number | null
  tasksPerDay: number | null
  packCredits: number | null
  maxSites: number | null
  sortOrder: number
}

export const planSeeds = [
  {
    slug: 'start',
    name: 'Старт',
    kind: 'quota',
    price: '4900.00',
    creditsPerMonth: 300,
    tasksPerDay: 5,
    packCredits: null,
    maxSites: 1,
    sortOrder: 10,
  },
  {
    slug: 'business',
    name: 'Бизнес',
    kind: 'quota',
    price: '12900.00',
    creditsPerMonth: 800,
    tasksPerDay: 10,
    packCredits: null,
    maxSites: 3,
    sortOrder: 20,
  },
  {
    slug: 'agency',
    name: 'Агентство',
    kind: 'quota',
    price: '39900.00',
    creditsPerMonth: 2500,
    tasksPerDay: 30,
    packCredits: null,
    maxSites: 15,
    sortOrder: 30,
  },
  // The name says what the pack holds, in credits, and the slug carries no number; Appendix 1 of
  // the public offer names the pack by the same words. A pack stored under an earlier name is
  // renamed by the next seed run: names follow the seed, the terms below do not change.
  {
    slug: 'pack',
    name: 'Пакет из 100 кредитов',
    kind: 'pack',
    price: '1990.00',
    creditsPerMonth: null,
    tasksPerDay: null,
    packCredits: 100,
    maxSites: null,
    sortOrder: 40,
  },
  // Placeholder limits: the site count and the wallet minimum for pay-per-action are still open
  // (docs/business.md §6, «Открытые вопросы»). No subscription fee: the price is 0.
  {
    slug: 'payg',
    name: 'Оплата за действие',
    kind: 'payg',
    price: '0.00',
    creditsPerMonth: null,
    tasksPerDay: null,
    packCredits: null,
    maxSites: 1,
    sortOrder: 50,
  },
] as const satisfies readonly PlanSeed[]

export type PlanSlug = (typeof planSeeds)[number]['slug']

// ─── Pricing rules for pay-per-action (spec §17, docs/business.md §6) ─────────

export interface PricingRuleSeed {
  planSlug: PlanSlug
  modelClass: ModelClass
  effectiveFrom: Date
  /** Decimal(8,4). */
  markup: DecimalString
  /** RUB, Decimal(12,2). */
  feePerAction: DecimalString
  minCharge: DecimalString
  holdAmount: DecimalString
}

/** Launch hypothesis: markup ×2.0, fee 30 ₽, minimum 50 ₽, hold by model class. */
export const PAYG_RULES_EFFECTIVE_FROM = moscowMidnight('2026-09-26')

const paygRule = (modelClass: ModelClass, holdAmount: DecimalString): PricingRuleSeed => ({
  planSlug: 'payg',
  modelClass,
  effectiveFrom: PAYG_RULES_EFFECTIVE_FROM,
  markup: '2.0000',
  feePerAction: '30.00',
  minCharge: '50.00',
  holdAmount,
})

export const pricingRuleSeeds: readonly PricingRuleSeed[] = [
  paygRule('light', '300.00'),
  paygRule('standard', '600.00'),
  paygRule('heavy', '1500.00'),
]

// ─── Agent drivers (spec §8, §9) ──────────────────────────────────────────────

export interface AgentDriverSeed {
  id: AgentDriverId
  /**
   * Unread placeholder, set on create only: drivers run the shared SANDBOX_IMAGE pinned by
   * digest (spec §8). The column waits for the B16 contract migration.
   */
  image: string
  /** Mirrors the adapter in packages/agent-drivers (db may not import an adapter). */
  capabilities: AgentCapabilities
  /** Set on create only: operators switch drivers in the database. */
  enabled: boolean
}

const placeholderImage = (id: AgentDriverId): string => `raditi/agent-${id}`

// The product runs one shell, OpenCode. The seeds create no row of an earlier shell: a database
// seeded before the removal keeps those rows for the history that names them, switched off by
// the migration 20261011090000_switch_to_opencode, and a seed run leaves them as they are.
export const agentDriverSeeds: readonly AgentDriverSeed[] = [
  {
    id: 'opencode',
    image: placeholderImage('opencode'),
    // No forced output schema, no image input.
    capabilities: { resume: true, jsonEvents: true, outputSchema: false, mcp: true, images: false },
    enabled: true,
  },
]

// ─── Subscription catalogue (spec §9, §17; p3-design §15, B6) ──────────────────

/** Defaults apply only to missing rows; all existing catalogue settings are operator-owned. */
export interface LlmProviderSeed {
  slug: string
  name: string
  kind: 'subscription'
  enabled: false
}

export const llmProviderSeeds = [
  { slug: 'zai-coding', name: 'Z.ai GLM Coding Plan', kind: 'subscription', enabled: false },
] as const satisfies readonly LlmProviderSeed[]

export interface LlmModelSeed {
  providerSlug: string
  /** A stable profile id: standard and heavy can use the same upstream model. */
  slug: string
  name: string
  providerModelId: string | null
  modelClass: Exclude<ModelClass, 'service'>
  reserveOutputTokens: number
  enabled: false
}

// One model of the GLM Coding Plan for every class: the classes differ by the level of
// reasoning of the turn (low, high, max). The reserve is the output ceiling of the adapter's
// request policy. Switched off: the operator enables the provider, the profiles and an
// approved rate.
export const llmModelSeeds: readonly LlmModelSeed[] = (['light', 'standard', 'heavy'] as const).map(
  (modelClass): LlmModelSeed => ({
    providerSlug: 'zai-coding',
    slug: `glm-5.3-${modelClass}`,
    name: `GLM-5.3 · ${modelClass}`,
    providerModelId: 'glm-5.3',
    modelClass,
    reserveOutputTokens: 32_000,
    enabled: false,
  }),
)

// Accounting rates need owner approval and are never seeded (not even placeholder zeros).

// ─── Everything the seed writes ───────────────────────────────────────────────

export interface ReferenceData {
  plans: readonly PlanSeed[]
  pricingRules: readonly PricingRuleSeed[]
  agentDrivers: readonly AgentDriverSeed[]
  llmProviders: readonly LlmProviderSeed[]
  llmModels: readonly LlmModelSeed[]
}

export const referenceData: ReferenceData = {
  plans: planSeeds,
  pricingRules: pricingRuleSeeds,
  agentDrivers: agentDriverSeeds,
  llmProviders: llmProviderSeeds,
  llmModels: llmModelSeeds,
}
