import { readFileSync } from 'node:fs'

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
        creditsPerMonth: 300,
        creditsPerDay: 50,
        packCredits: null,
        maxSites: 1,
      },
      {
        slug: 'business',
        name: 'Бизнес',
        kind: 'quota',
        price: '12900.00',
        creditsPerMonth: 800,
        creditsPerDay: 100,
        packCredits: null,
        maxSites: 3,
      },
      {
        slug: 'agency',
        name: 'Агентство',
        kind: 'quota',
        price: '39900.00',
        creditsPerMonth: 2500,
        creditsPerDay: 300,
        packCredits: null,
        maxSites: 15,
      },
      {
        slug: 'pack',
        name: 'Пакет из 100 кредитов',
        kind: 'pack',
        price: '1990.00',
        creditsPerMonth: null,
        creditsPerDay: null,
        packCredits: 100,
        maxSites: null,
      },
      {
        slug: 'payg',
        name: 'Оплата за действие',
        kind: 'payg',
        price: '0.00',
        creditsPerMonth: null,
        creditsPerDay: null,
        packCredits: null,
        maxSites: 1,
      },
    ])
  })

  // CHECK plans_credits_per_day_check and plans_day_within_month_check: a day of a tariff gives
  // some of its month, never more; a pack and pay-per-action have no day.
  it('give a day only to a tariff, and never more than its month', () => {
    for (const plan of planSeeds) {
      if (plan.kind !== 'quota') {
        expect(plan.creditsPerDay).toBeNull()
        continue
      }
      expect(plan.creditsPerDay).toBeGreaterThan(0)
      expect(plan.creditsPerDay).toBeLessThanOrEqual(plan.creditsPerMonth)
    }
  })

  it('have unique slugs, valid kinds and prices as Decimal(12,2) strings', () => {
    expect(new Set(planSeeds.map((p) => p.slug)).size).toBe(planSeeds.length)
    for (const plan of planSeeds) {
      expect(Object.values(PlanKind)).toContain(plan.kind)
      expect(plan.price).toMatch(money12x2)
    }
  })
})

describe('Appendix 1 of the public offer', () => {
  // The offer prints the plans a second time, by hand, as terms of the contract. A term that
  // moves in `planSeeds` moves in the offer too, and the reverse: neither moves alone (once the
  // offer is published, as a new edition of it).
  const offer = readFileSync(
    new URL('../../../../apps/web/content/legal/public-offer.md', import.meta.url),
    'utf8',
  )
  // The table stands between the heading of the appendix and its first clause.
  const rows = (/## Приложение № 1\.[\s\S]*?(?=\n\*\*1\.1\.\*\*)/.exec(offer)?.[0] ?? '')
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2)
    .map((line) => line.split('|').slice(1, -1))

  // Whole numbers in groups of three, as money is printed: «2 500», never «2500».
  const whole = String.raw`(\d{1,3}(?: \d{3})*)`
  const tariff = {
    price: new RegExp(`^${whole} ₽ в месяц$`),
    terms: new RegExp(
      `^${whole} Кредит(?:|а|ов) в месяц, из них не более ${whole} Кредит(?:|а|ов) в день; ` +
        String.raw`(?:до )?(\d+) Сайт(?:|а|ов) Заказчика$`,
    ),
  }
  const pack = {
    price: new RegExp(`^${whole} ₽$`),
    terms: new RegExp(`^${whole} Кредит(?:|а|ов); не сгорают, дневным лимитом не ограничены$`),
  }
  const count = (printed = '') => Number(printed.replaceAll(' ', ''))
  const roubles = (printed = '') => `${printed.replaceAll(' ', '')}.00`

  /** What a row of the table promises; a row that reads as neither kind is returned as it is. */
  function promised(cells: string[]) {
    const [name = '', price = '', terms = ''] = cells.map((cell) => cell.trim())
    const month = tariff.price.exec(price)
    const [, credits, creditsPerDay, maxSites] = tariff.terms.exec(terms) ?? []
    if (month && credits !== undefined)
      return {
        name,
        price: roubles(month[1]),
        creditsPerMonth: count(credits),
        creditsPerDay: count(creditsPerDay),
        maxSites: count(maxSites),
      }
    const once = pack.price.exec(price)
    const [, packCredits] = pack.terms.exec(terms) ?? []
    if (once && packCredits !== undefined)
      return { name, price: roubles(once[1]), packCredits: count(packCredits) }
    return { unread: cells.join('|') }
  }

  it('prints every tariff and the pack with the price and the terms of the seed', () => {
    // «Оплата за действие» is not sold and the offer does not name it.
    const sold = planSeeds.filter((plan) => plan.kind !== 'payg')
    expect(rows.map(promised)).toEqual(
      sold.map((plan) =>
        plan.kind === 'pack'
          ? { name: plan.name, price: plan.price, packCredits: plan.packCredits }
          : {
              name: `«${plan.name}»`,
              price: plan.price,
              creditsPerMonth: plan.creditsPerMonth,
              creditsPerDay: plan.creditsPerDay,
              maxSites: plan.maxSites,
            },
      ),
    )
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
    // Each backend offers every class once.
    for (const backend of llmBackendIds)
      expect(
        llmModelSeeds
          .filter((model) => model.providerSlug === backend)
          .map((model) => model.modelClass),
      ).toEqual(['light', 'standard', 'heavy'])
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

  it.each([
    ['the Z.ai plan', 'zai-coding', 'Z.ai GLM Coding Plan'],
    ['the Z.ai pay-per-token API', 'zai-api', 'Z.ai API'],
  ])('offers one GLM model in three profiles of %s, all switched off', (_name, slug, name) => {
    const profiles = llmModelSeeds.filter((model) => model.providerSlug === slug)
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
    expect(llmProviderSeeds.find((provider) => provider.slug === slug)).toEqual({
      slug,
      name,
      kind: 'subscription',
      enabled: false,
    })
  })

  it('names the profiles of both Z.ai offers alike, so only their provider tells them apart', () => {
    // The billing readers name a priced model by its display name (credit-conversion): two
    // profiles of one name are told apart only while one provider's profiles are switched on.
    const profiles = (slug: string) =>
      llmModelSeeds
        .filter((model) => model.providerSlug === slug)
        .map(({ providerSlug: _provider, ...profile }) => profile)
    expect(profiles('zai-api')).toEqual(profiles('zai-coding'))
  })

  it('reserves for a Z.ai profile no less output than its request policy may ask for', () => {
    // The body policy of the adapter caps `max_tokens` of every request at this number
    // (`zaiMaxOutputTokens`, packages/llm-backends/src/zai-coding/body.ts; its own test pins
    // it). The seeds may not import an adapter, so the number is written here once more: a
    // reserve below it would let one call outgrow what the gateway held for it.
    // Both offers of the adapter share it (createZaiBodyPolicy).
    const policyMaxOutputTokens = 32_000
    const profiles = llmModelSeeds.filter((model) =>
      ['zai-coding', 'zai-api'].includes(model.providerSlug),
    )
    expect(profiles).toHaveLength(6)
    for (const model of profiles)
      expect(model.reserveOutputTokens).toBeGreaterThanOrEqual(policyMaxOutputTokens)
  })
})
