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
  /** RUB including VAT, Decimal(12,2). */
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
  {
    slug: 'pack-10',
    name: 'Пакет 10 правок',
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
  /** Placeholder until P2 pins sandbox images by digest; set on create only. */
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

// ─── LLM providers, models and prices (spec §9, docs/business.md §5) ──────────

export interface LlmProviderSeed {
  slug: string
  name: string
}

export const llmProviderSeeds = [
  { slug: 'yandex-ai-studio', name: 'Yandex AI Studio' },
  { slug: 'cloudru', name: 'Cloud.ru Evolution Foundation Models' },
] as const satisfies readonly LlmProviderSeed[]

export type LlmProviderSlug = (typeof llmProviderSeeds)[number]['slug']

/** RUB per 1M tokens including VAT, Decimal(14,6). NULL cache prices are charged as input. */
export interface LlmPriceSeed {
  effectiveFrom: Date
  inputPer1m: DecimalString
  cacheReadPer1m: DecimalString | null
  cacheWritePer1m: DecimalString | null
  outputPer1m: DecimalString
  /** Decimal(5,4). */
  vatRate: DecimalString
  sourceUrl: string
}

export interface LlmModelSeed {
  providerSlug: LlmProviderSlug
  /** LiteLLM model_name. The provider model id stays NULL until the PoC confirms it. */
  slug: string
  name: string
  /** Router class; set on create only (the router is tuned in the database). */
  modelClass: ModelClass
  price: LlmPriceSeed
}

const VAT_22 = '0.2200'

/** Yandex AI Studio publishes RUB per 1K tokens with VAT; ×1000 here. No cache-write price. */
const yandexPrice = (
  input: DecimalString,
  cacheRead: DecimalString,
  output: DecimalString,
): LlmPriceSeed => ({
  effectiveFrom: moscowMidnight('2026-09-26'),
  inputPer1m: input,
  cacheReadPer1m: cacheRead,
  cacheWritePer1m: null,
  outputPer1m: output,
  vatRate: VAT_22,
  sourceUrl: 'https://aistudio.yandex.ru/docs/ru/ai-studio/pricing.html',
})

/** Cloud.ru tariff from 15.09.2026: RUB per 1M with VAT 22%; no cache prices for open models. */
const cloudruPrice = (input: DecimalString, output: DecimalString): LlmPriceSeed => ({
  effectiveFrom: moscowMidnight('2026-09-15'),
  inputPer1m: input,
  cacheReadPer1m: null,
  cacheWritePer1m: null,
  outputPer1m: output,
  vatRate: VAT_22,
  sourceUrl: 'https://cloud.ru/documents/tariffs/evolution/foundation-models',
})

export const llmModelSeeds: readonly LlmModelSeed[] = [
  {
    providerSlug: 'yandex-ai-studio',
    slug: 'qwen3.6-35b',
    name: 'Qwen3.6 35B',
    modelClass: 'light',
    price: yandexPrice('200', '50', '300'),
  },
  {
    providerSlug: 'yandex-ai-studio',
    slug: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    modelClass: 'light',
    price: yandexPrice('300', '75', '500'),
  },
  {
    providerSlug: 'yandex-ai-studio',
    slug: 'qwen3-235b',
    name: 'Qwen3 235B',
    modelClass: 'heavy',
    price: yandexPrice('500', '500', '500'),
  },
  {
    providerSlug: 'cloudru',
    slug: 'qwen3-coder-next',
    name: 'Qwen3-Coder-Next',
    modelClass: 'standard',
    price: cloudruPrice('122', '244'),
  },
  {
    providerSlug: 'cloudru',
    slug: 'kimi-k2.6',
    name: 'Kimi-K2.6',
    modelClass: 'standard',
    price: cloudruPrice('175.68', '725.9'),
  },
  {
    providerSlug: 'cloudru',
    slug: 'glm-5.1',
    name: 'GLM-5.1',
    modelClass: 'heavy',
    price: cloudruPrice('198.86', '829.6'),
  },
  {
    providerSlug: 'cloudru',
    slug: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    modelClass: 'heavy',
    price: cloudruPrice('183', '732'),
  },
  {
    providerSlug: 'cloudru',
    slug: 'gpt-oss-120b',
    name: 'gpt-oss-120b',
    modelClass: 'service',
    price: cloudruPrice('15.86', '61'),
  },
]

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
