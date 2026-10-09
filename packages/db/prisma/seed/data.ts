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

/** Everything except name and sortOrder is a plan term: the seed creates it but never changes it. */
export interface PlanSeed {
  slug: string
  name: string
  kind: PlanKind
  /** RUB without VAT (the seller is self-employed), Decimal(12,2). */
  price: DecimalString
  editsPerMonth: number | null
  editsPerDay: number | null
  packEdits: number | null
  maxSites: number | null
  sortOrder: number
}

export const planSeeds = [
  {
    slug: 'start',
    name: 'Старт',
    kind: 'quota',
    price: '4900.00',
    editsPerMonth: 30,
    editsPerDay: 5,
    packEdits: null,
    maxSites: 1,
    sortOrder: 10,
  },
  {
    slug: 'business',
    name: 'Бизнес',
    kind: 'quota',
    price: '12900.00',
    editsPerMonth: 80,
    editsPerDay: 10,
    packEdits: null,
    maxSites: 3,
    sortOrder: 20,
  },
  {
    slug: 'agency',
    name: 'Агентство',
    kind: 'quota',
    price: '39900.00',
    editsPerMonth: 250,
    editsPerDay: 30,
    packEdits: null,
    maxSites: 15,
    sortOrder: 30,
  },
  // The name of the public offer. A stored «Пакет 10 правок» is renamed by the next seed run:
  // names follow the seed, the terms below do not change.
  {
    slug: 'pack-10',
    name: 'Пакет из 10 правок',
    kind: 'pack',
    price: '1990.00',
    editsPerMonth: null,
    editsPerDay: null,
    packEdits: 10,
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
    editsPerMonth: null,
    editsPerDay: null,
    packEdits: null,
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

/** Kimi Code, Qwen Code and OpenCode: no forced output schema, no image input. */
const streamJsonCliCapabilities: AgentCapabilities = {
  resume: true,
  jsonEvents: true,
  outputSchema: false,
  mcp: true,
  images: false,
}

const placeholderImage = (id: AgentDriverId): string => `raditi/agent-${id}`

export const agentDriverSeeds: readonly AgentDriverSeed[] = [
  {
    id: 'codex',
    image: placeholderImage('codex'),
    capabilities: { resume: true, jsonEvents: true, outputSchema: true, mcp: true, images: true },
    enabled: true,
  },
  {
    id: 'kimi',
    image: placeholderImage('kimi'),
    capabilities: streamJsonCliCapabilities,
    enabled: true,
  },
  {
    id: 'qwen',
    image: placeholderImage('qwen'),
    capabilities: streamJsonCliCapabilities,
    enabled: false,
  },
  {
    id: 'opencode',
    image: placeholderImage('opencode'),
    capabilities: streamJsonCliCapabilities,
    enabled: false,
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
  { slug: 'openai-chatgpt', name: 'ChatGPT', kind: 'subscription', enabled: false },
  { slug: 'kimi-code', name: 'Kimi Code', kind: 'subscription', enabled: false },
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

// The design names GPT-6 profiles, but the local spike confirmed only gpt-6.1-sol.
// Do not silently replace a profile or guess an upstream id: the operator confirms it before
// enabling a model. Kimi's k3-256k is the explicit id in p3-design §3.6, still disabled here.
export const llmModelSeeds: readonly LlmModelSeed[] = [
  {
    providerSlug: 'openai-chatgpt',
    slug: 'gpt-6-luna-light',
    name: 'GPT-6 Luna · light',
    providerModelId: null,
    modelClass: 'light',
    reserveOutputTokens: 32_000,
    enabled: false,
  },
  {
    providerSlug: 'openai-chatgpt',
    slug: 'gpt-6-sol-standard',
    name: 'GPT-6 Sol · standard',
    providerModelId: null,
    modelClass: 'standard',
    reserveOutputTokens: 32_000,
    enabled: false,
  },
  {
    providerSlug: 'openai-chatgpt',
    slug: 'gpt-6-sol-heavy',
    name: 'GPT-6 Sol · heavy',
    providerModelId: null,
    modelClass: 'heavy',
    reserveOutputTokens: 32_000,
    enabled: false,
  },
  {
    providerSlug: 'kimi-code',
    slug: 'k3-256k-standard',
    name: 'Kimi K3 256K · standard',
    providerModelId: 'k3-256k',
    modelClass: 'standard',
    reserveOutputTokens: 32_768,
    enabled: false,
  },
  // One model of the GLM Coding Plan for every class: the classes differ by the level of
  // reasoning of the turn (low, high, max). The reserve is the output ceiling of the adapter's
  // request policy. Switched off like the rest: the operator enables the provider, the
  // profiles and an approved rate.
  ...(['light', 'standard', 'heavy'] as const).map((modelClass): LlmModelSeed => ({
    providerSlug: 'zai-coding',
    slug: `glm-5.3-${modelClass}`,
    name: `GLM-5.3 · ${modelClass}`,
    providerModelId: 'glm-5.3',
    modelClass,
    reserveOutputTokens: 32_000,
    enabled: false,
  })),
]

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
