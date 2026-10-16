import { describe, expect, it } from 'vitest'

import { agentDriverIds, llmBackendIds, type AgentCapabilities } from '@repo/domain'
import { PlanKind } from '../../src/generated/prisma/enums.ts'
import {
  PAYG_RULES_EFFECTIVE_FROM,
  agentDriverSeeds,
  llmModelSeeds,
  llmProviderSeeds,
  planSeeds,
  pricingRuleSeeds,
  referenceData,
} from './data.ts'

// Exact string formats per column precision (spec §16).
const money12x2 = /^\d{1,10}\.\d{2}$/
const markup8x4 = /^\d{1,4}\.\d{4}$/

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
        name: 'Пакет из 10 правок',
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
  it('seed exactly the drivers of the domain, switched on', () => {
    // The seeds create no row of a removed shell. A database seeded before the removal keeps
    // such rows as history, switched off by the migration 20261011090000_switch_to_opencode.
    expect(agentDriverSeeds.map(({ id }) => id)).toEqual(agentDriverIds)
    expect(agentDriverSeeds.map(({ id, enabled }) => [id, enabled])).toEqual([['opencode', true]])
    for (const driver of agentDriverSeeds) expect(driver.image).toBe(`raditi/agent-${driver.id}`)
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
    // What the adapter declares (packages/agent-drivers/src/opencode.ts): the result contract
    // is in the prompt, not a forced schema, and the shell takes no image.
    expect(agentDriverSeeds.find((d) => d.id === 'opencode')?.capabilities).toEqual({
      resume: true,
      jsonEvents: true,
      outputSchema: false,
      mcp: true,
      images: false,
    })
  })
})

describe('default reference data', () => {
  it('adds subscription defaults without accounting rates or a service profile', () => {
    expect(Object.keys(referenceData).sort()).toEqual([
      'agentDrivers',
      'llmModels',
      'llmProviders',
      'plans',
      'pricingRules',
    ])
    expect(pricingRuleSeeds.map((rule) => rule.modelClass)).toEqual(['light', 'standard', 'heavy'])
  })

  it('keeps every amount a string, never a JS number', () => {
    const amounts = [
      ...planSeeds.map((p) => p.price),
      ...pricingRuleSeeds.flatMap((r) => [r.markup, r.feePerAction, r.minCharge, r.holdAmount]),
    ]
    for (const amount of amounts) expect(typeof amount).toBe('string')
  })
})

describe('subscription catalogue defaults', () => {
  it('creates only supported subscription backends, initially switched off', () => {
    expect(llmProviderSeeds.map(({ slug }) => slug)).toEqual(llmBackendIds)
    for (const provider of llmProviderSeeds) {
      expect(provider.kind).toBe('subscription')
      expect(provider.enabled).toBe(false)
    }
  })

  it('uses separate disabled profiles with the explicit backend output reserves', () => {
    // Every profile belongs to a backend of the domain: none is seeded for a removed provider.
    expect([...new Set(llmModelSeeds.map((model) => model.providerSlug))]).toEqual(llmBackendIds)
    expect(llmModelSeeds.map((model) => model.modelClass)).toEqual(['light', 'standard', 'heavy'])
    const naturalKeys = llmModelSeeds.map((model) => `${model.providerSlug}/${model.slug}`)
    expect(new Set(naturalKeys).size).toBe(llmModelSeeds.length)
    for (const model of llmModelSeeds) {
      expect(model.enabled).toBe(false)
      expect(model.reserveOutputTokens).toBe(32_000)
      expect(Object.keys(model).sort()).toEqual([
        'enabled',
        'modelClass',
        'name',
        'providerModelId',
        'providerSlug',
        'reserveOutputTokens',
        'slug',
      ])
    }
  })

  it('offers one GLM model in three profiles of the Z.ai plan, all switched off', () => {
    const profiles = llmModelSeeds.filter((model) => model.providerSlug === 'zai-coding')
    expect(profiles.map((model) => model.slug)).toEqual([
      'glm-5.3-light',
      'glm-5.3-standard',
      'glm-5.3-heavy',
    ])
    for (const model of profiles) {
      // One model for every class: the classes differ by the level of reasoning of the turn.
      expect(model.providerModelId).toBe('glm-5.3')
      expect(model.enabled).toBe(false)
    }
    expect(llmProviderSeeds.find((provider) => provider.slug === 'zai-coding')).toEqual({
      slug: 'zai-coding',
      name: 'Z.ai GLM Coding Plan',
      kind: 'subscription',
      enabled: false,
    })
  })

  it('reserves for a Z.ai profile no less output than its request policy may ask for', () => {
    // The body policy of the adapter caps `max_tokens` of every request at this number
    // (`zaiMaxOutputTokens`, packages/llm-backends/src/zai-coding/body.ts; its own test pins
    // it). The seeds may not import an adapter, so the number is written here once more: a
    // reserve below it would let one call outgrow what the gateway held for it.
    const policyMaxOutputTokens = 32_000
    const profiles = llmModelSeeds.filter((model) => model.providerSlug === 'zai-coding')
    expect(profiles).toHaveLength(3)
    for (const model of profiles)
      expect(model.reserveOutputTokens).toBeGreaterThanOrEqual(policyMaxOutputTokens)
  })
})
