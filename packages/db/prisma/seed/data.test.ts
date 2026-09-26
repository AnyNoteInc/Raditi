import { describe, expect, it } from 'vitest'

import { agentDriverIds, type AgentCapabilities } from '@repo/domain'
import { ModelClass, PlanKind } from '../../src/generated/prisma/enums.ts'
import {
  PAYG_RULES_EFFECTIVE_FROM,
  agentDriverSeeds,
  llmModelSeeds,
  llmProviderSeeds,
  moscowMidnight,
  planSeeds,
  pricingRuleSeeds,
} from './data.ts'

// Exact string formats per column precision (spec §16).
const money12x2 = /^\d{1,10}\.\d{2}$/
const markup8x4 = /^\d{1,4}\.\d{4}$/
const vat5x4 = /^0\.\d{4}$/
const price14x6 = /^\d{1,8}(\.\d{1,6})?$/

describe('plans (docs/business.md §6)', () => {
  it('match the tariff table exactly', () => {
    expect(planSeeds.map(({ sortOrder: _, ...plan }) => plan)).toEqual([
      {
        slug: 'start',
        name: 'Старт',
        kind: 'quota',
        price: '4900.00',
        editsPerMonth: 30,
        editsPerDay: 5,
        packEdits: null,
        maxSites: 1,
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
      },
      {
        slug: 'payg',
        name: 'Оплата за действие',
        kind: 'payg',
        price: '0.00',
        editsPerMonth: null,
        editsPerDay: null,
        packEdits: null,
        maxSites: 1,
      },
    ])
  })

  it('have unique slugs, valid kinds and prices as Decimal(12,2) strings', () => {
    expect(new Set(planSeeds.map((p) => p.slug)).size).toBe(planSeeds.length)
    for (const plan of planSeeds) {
      expect(Object.values(PlanKind)).toContain(plan.kind)
      expect(plan.price).toMatch(money12x2)
    }
  })
})

describe('pricing rules (spec §17 hypothesis)', () => {
  it('cover light, standard and heavy on pay-per-action from 26.09.2026 (Moscow)', () => {
    expect(PAYG_RULES_EFFECTIVE_FROM.toISOString()).toBe('2026-09-25T21:00:00.000Z')
    expect(pricingRuleSeeds).toEqual([
      {
        planSlug: 'payg',
        modelClass: 'light',
        effectiveFrom: PAYG_RULES_EFFECTIVE_FROM,
        markup: '2.0000',
        feePerAction: '30.00',
        minCharge: '50.00',
        holdAmount: '300.00',
      },
      {
        planSlug: 'payg',
        modelClass: 'standard',
        effectiveFrom: PAYG_RULES_EFFECTIVE_FROM,
        markup: '2.0000',
        feePerAction: '30.00',
        minCharge: '50.00',
        holdAmount: '600.00',
      },
      {
        planSlug: 'payg',
        modelClass: 'heavy',
        effectiveFrom: PAYG_RULES_EFFECTIVE_FROM,
        markup: '2.0000',
        feePerAction: '30.00',
        minCharge: '50.00',
        holdAmount: '1500.00',
      },
    ])
  })

  it('satisfy the migration CHECKs and reference a payg plan', () => {
    const payg = planSeeds.filter((p) => p.kind === 'payg').map((p) => p.slug)
    for (const rule of pricingRuleSeeds) {
      expect(payg).toContain(rule.planSlug)
      expect(rule.markup).toMatch(markup8x4)
      for (const amount of [rule.feePerAction, rule.minCharge, rule.holdAmount]) {
        expect(amount).toMatch(money12x2)
      }
      // Whole-kopeck strings compare exactly as integers of kopecks.
      const kopecks = (s: string) => BigInt(s.replace('.', ''))
      expect(kopecks(rule.holdAmount) >= kopecks(rule.minCharge)).toBe(true)
    }
  })
})

describe('agent drivers', () => {
  it('seed codex and kimi enabled, qwen and opencode disabled, with domain ids', () => {
    expect(agentDriverSeeds.map(({ id, enabled }) => [id, enabled])).toEqual([
      ['codex', true],
      ['kimi', true],
      ['qwen', false],
      ['opencode', false],
    ])
    for (const driver of agentDriverSeeds) {
      expect(agentDriverIds).toContain(driver.id)
      expect(driver.image).toBe(`raditi/agent-${driver.id}`)
    }
  })

  it('carry exactly the AgentCapabilities keys', () => {
    const keys: (keyof AgentCapabilities)[] = [
      'images',
      'jsonEvents',
      'mcp',
      'outputSchema',
      'resume',
    ]
    for (const driver of agentDriverSeeds) {
      expect(Object.keys(driver.capabilities).sort()).toEqual(keys)
    }
    const codex = agentDriverSeeds.find((d) => d.id === 'codex')
    expect(codex?.capabilities).toEqual({
      resume: true,
      jsonEvents: true,
      outputSchema: true,
      mcp: true,
      images: true,
    })
  })
})

describe('LLM providers, models and prices', () => {
  it('seed Yandex AI Studio and Cloud.ru', () => {
    expect(llmProviderSeeds).toEqual([
      { slug: 'yandex-ai-studio', name: 'Yandex AI Studio' },
      { slug: 'cloudru', name: 'Cloud.ru Evolution Foundation Models' },
    ])
  })

  it('price every model in RUB per 1M with VAT 22% (exact strings)', () => {
    const table = llmModelSeeds.map(({ providerSlug, slug, modelClass, price }) => [
      providerSlug,
      slug,
      modelClass,
      price.inputPer1m,
      price.cacheReadPer1m,
      price.cacheWritePer1m,
      price.outputPer1m,
    ])
    expect(table).toEqual([
      ['yandex-ai-studio', 'qwen3.6-35b', 'light', '200', '50', null, '300'],
      ['yandex-ai-studio', 'deepseek-v4-flash', 'light', '300', '75', null, '500'],
      ['yandex-ai-studio', 'qwen3-235b', 'heavy', '500', '500', null, '500'],
      ['cloudru', 'qwen3-coder-next', 'standard', '122', null, null, '244'],
      ['cloudru', 'kimi-k2.6', 'standard', '175.68', null, null, '725.9'],
      ['cloudru', 'glm-5.1', 'heavy', '198.86', null, null, '829.6'],
      ['cloudru', 'deepseek-v4-pro', 'heavy', '183', null, null, '732'],
      ['cloudru', 'gpt-oss-120b', 'service', '15.86', null, null, '61'],
    ])
  })

  it('take effect on the tariff dates and fit the column precisions', () => {
    const providers = llmProviderSeeds.map((p) => p.slug)
    const keys = new Set<string>()
    for (const { providerSlug, slug, modelClass, price } of llmModelSeeds) {
      expect(providers).toContain(providerSlug)
      expect(Object.values(ModelClass)).toContain(modelClass)
      keys.add(`${providerSlug}/${slug}`)

      const effective = providerSlug === 'cloudru' ? '2026-09-15' : '2026-09-26'
      expect(price.effectiveFrom).toEqual(moscowMidnight(effective))
      expect(price.vatRate).toBe('0.2200')
      expect(price.vatRate).toMatch(vat5x4)
      expect(price.sourceUrl).toMatch(/^https:\/\//)
      for (const value of [price.inputPer1m, price.cacheReadPer1m, price.outputPer1m]) {
        if (value !== null) expect(value).toMatch(price14x6)
      }
    }
    expect(keys.size).toBe(llmModelSeeds.length)
  })

  it('keeps every amount a string, never a JS number', () => {
    const amounts = [
      ...planSeeds.map((p) => p.price),
      ...pricingRuleSeeds.flatMap((r) => [r.markup, r.feePerAction, r.minCharge, r.holdAmount]),
      ...llmModelSeeds.flatMap(({ price: p }) => [p.inputPer1m, p.outputPer1m, p.vatRate]),
    ]
    for (const amount of amounts) expect(typeof amount).toBe('string')
  })
})
