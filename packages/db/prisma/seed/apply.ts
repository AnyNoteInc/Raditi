// Writes the reference data from data.ts by natural keys, in one transaction. A rerun writes
// nothing: rows are compared first and only changed fields are updated. A failure rolls back all.
// - Catalogue fields (plan names and order, provider and model names, driver capabilities) follow
//   the seed.
// - Plan terms (kind, price, quotas, site limit) are what customers buy: set on create only, and a
//   mismatch with the stored plan fails the seed. A new price is a deliberate migration or a new
//   plan, never a side effect of a seed run.
// - Operational switches (enabled flags, image digests, model classes, provider model ids) are
//   set on create only: operators and later tasks own them.
// - Versioned rows (pricing rules, model prices) are immutable history: a changed value must come
//   as a new effective_from, so a mismatch with the stored row fails the seed.
import { isDeepStrictEqual } from 'node:util'

import { Prisma, type PrismaClient } from '../../src/generated/prisma/client.ts'
import { referenceData, type ReferenceData } from './data.ts'

export const seededTables = [
  'plans',
  'pricing_rules',
  'agent_drivers',
  'llm_providers',
  'llm_models',
  'llm_model_prices',
] as const
export type SeededTable = (typeof seededTables)[number]
export type SeedCounts = Record<SeededTable, number>

export interface SeedReport {
  created: SeedCounts
  updated: SeedCounts
}

const zeroCounts = (): SeedCounts => ({
  plans: 0,
  pricing_rules: 0,
  agent_drivers: 0,
  llm_providers: 0,
  llm_models: 0,
  llm_model_prices: 0,
})

const IMMUTABLE_PLAN_TERMS =
  'Plan terms are immutable: change a price or quota by a deliberate migration, or add a new plan.'
const IMMUTABLE_VERSIONED_ROW =
  'Versioned rows are immutable: add a row with a new effective_from instead.'

export async function seedReferenceData(
  db: PrismaClient,
  data: ReferenceData = referenceData,
): Promise<SeedReport> {
  return db.$transaction(async (tx) => {
    const report: SeedReport = { created: zeroCounts(), updated: zeroCounts() }
    const count = (table: SeededTable, outcome: 'created' | 'updated' | 'unchanged') => {
      if (outcome !== 'unchanged') report[outcome][table] += 1
    }

    for (const { slug, name, sortOrder, ...terms } of data.plans) {
      const stored = await tx.plan.findUnique({ where: { slug } })
      if (!stored) {
        await tx.plan.create({ data: { slug, name, sortOrder, ...terms } })
        count('plans', 'created')
        continue
      }
      assertUnchanged(`plans ${slug}`, stored, terms, IMMUTABLE_PLAN_TERMS)
      const diff = changedFields(stored, { name, sortOrder })
      if (diff) await tx.plan.update({ where: { slug }, data: diff })
      count('plans', diff ? 'updated' : 'unchanged')
    }

    for (const { planSlug, ...rule } of data.pricingRules) {
      const plan = await tx.plan.findUniqueOrThrow({ where: { slug: planSlug } })
      const key = {
        planId: plan.id,
        modelClass: rule.modelClass,
        effectiveFrom: rule.effectiveFrom,
      }
      const stored = await tx.pricingRule.findUnique({
        where: { planId_modelClass_effectiveFrom: key },
      })
      if (!stored) {
        await tx.pricingRule.create({ data: { ...key, ...rule } })
        count('pricing_rules', 'created')
        continue
      }
      assertUnchanged(
        `pricing_rules ${planSlug}/${rule.modelClass}`,
        stored,
        rule,
        IMMUTABLE_VERSIONED_ROW,
      )
    }

    for (const { id, image, capabilities, enabled } of data.agentDrivers) {
      const stored = await tx.agentDriver.findUnique({ where: { id } })
      if (!stored) {
        await tx.agentDriver.create({
          data: { id, image, capabilities: { ...capabilities }, enabled },
        })
        count('agent_drivers', 'created')
        continue
      }
      const diff = changedFields(stored, { capabilities: { ...capabilities } })
      if (diff) await tx.agentDriver.update({ where: { id }, data: diff })
      count('agent_drivers', diff ? 'updated' : 'unchanged')
    }

    const providerIds = new Map<string, string>()
    for (const { slug, name } of data.llmProviders) {
      const stored = await tx.llmProvider.findUnique({ where: { slug } })
      if (!stored) {
        const created = await tx.llmProvider.create({ data: { slug, name } })
        providerIds.set(slug, created.id)
        count('llm_providers', 'created')
        continue
      }
      providerIds.set(slug, stored.id)
      const diff = changedFields(stored, { name })
      if (diff) await tx.llmProvider.update({ where: { slug }, data: diff })
      count('llm_providers', diff ? 'updated' : 'unchanged')
    }

    for (const { providerSlug, slug, name, modelClass, price } of data.llmModels) {
      const providerId = providerIds.get(providerSlug)
      if (!providerId) throw new Error(`[seed] unknown provider ${providerSlug} for ${slug}`)
      const where = { providerId_slug: { providerId, slug } }
      let modelId: string
      const stored = await tx.llmModel.findUnique({ where })
      if (!stored) {
        modelId = (await tx.llmModel.create({ data: { providerId, slug, name, modelClass } })).id
        count('llm_models', 'created')
      } else {
        modelId = stored.id
        const diff = changedFields(stored, { name })
        if (diff) await tx.llmModel.update({ where, data: diff })
        count('llm_models', diff ? 'updated' : 'unchanged')
      }

      const key = { modelId, effectiveFrom: price.effectiveFrom }
      const storedPrice = await tx.llmModelPrice.findUnique({
        where: { modelId_effectiveFrom: key },
      })
      if (!storedPrice) {
        await tx.llmModelPrice.create({ data: { ...key, ...price } })
        count('llm_model_prices', 'created')
        continue
      }
      assertUnchanged(
        `llm_model_prices ${providerSlug}/${slug}`,
        storedPrice,
        price,
        IMMUTABLE_VERSIONED_ROW,
      )
    }

    return report
  })
}

/** Fields of `wanted` that differ from the stored row, or null when nothing changed. */
export function changedFields<T extends object>(stored: object, wanted: T): Partial<T> | null {
  const diff: Partial<T> = {}
  let changed = false
  for (const key of Object.keys(wanted) as (keyof T & string)[]) {
    const have: unknown = Reflect.get(stored, key)
    const want = wanted[key]
    if (!sameValue(have, want)) {
      diff[key] = want
      changed = true
    }
  }
  return changed ? diff : null
}

/** Decimals compare by value ("725.9" equals 725.900000), everything else structurally. */
function sameValue(have: unknown, want: unknown): boolean {
  if (Prisma.Decimal.isDecimal(have) && (typeof want === 'string' || typeof want === 'number')) {
    return have.equals(new Prisma.Decimal(want))
  }
  return isDeepStrictEqual(have, want)
}

function assertUnchanged(what: string, stored: object, seed: object, rule: string): void {
  const diff = changedFields(stored, seed)
  if (!diff) return
  const fields = Object.keys(diff)
    .map(
      (field) =>
        `${field}: stored ${String(Reflect.get(stored, field))}, seed ${String(Reflect.get(diff, field))}`,
    )
    .join('; ')
  throw new Error(`[seed] ${what} differs (${fields}). ${rule}`)
}
