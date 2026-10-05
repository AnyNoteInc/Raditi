// Writes the reference data from data.ts by natural keys, in one transaction. A rerun writes
// nothing: rows are compared first and only changed fields are updated. A failure rolls back all.
// - Catalogue fields (plan names and order, driver capabilities) follow the seed.
// - Plan terms (kind, price, quotas, site limit) are what customers buy: set on create only, and a
//   mismatch with the stored plan fails the seed. A new price is a deliberate migration or a new
//   plan, never a side effect of a seed run.
// - Driver operational switches (enabled flags and image digests) are set on create only:
//   operators and later tasks own them.
// - Pricing rules are immutable history: a changed value must come as a new effective_from,
//   so a mismatch with the stored row fails the seed.
// - Missing subscription providers and models are created disabled. Existing catalogue rows
//   stay untouched; prices are never seeded and require owner approval (spec §17).
import { isDeepStrictEqual } from 'node:util'

import { Prisma, type PrismaClient } from '../../src/generated/prisma/client.ts'
import { referenceData, type ReferenceData } from './data.ts'

export const seededTables = [
  'plans',
  'pricing_rules',
  'agent_drivers',
  'llm_providers',
  'llm_models',
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

    for (const provider of data.llmProviders) {
      const stored = await tx.llmProvider.findUnique({ where: { slug: provider.slug } })
      if (stored) {
        assertSubscriptionProvider(provider.slug, stored.kind)
        continue
      }
      await tx.llmProvider.create({ data: provider })
      count('llm_providers', 'created')
    }

    for (const { providerSlug, ...model } of data.llmModels) {
      const provider = await tx.llmProvider.findUniqueOrThrow({ where: { slug: providerSlug } })
      assertSubscriptionProvider(providerSlug, provider.kind)
      const key = { providerId: provider.id, slug: model.slug }
      const stored = await tx.llmModel.findUnique({ where: { providerId_slug: key } })
      // Preserve every operator choice, including enabled, upstream id, class and reserve.
      // No model price operation belongs in the seed: history is append-only and approved.
      if (stored) continue
      await tx.llmModel.create({ data: { ...model, providerId: provider.id } })
      count('llm_models', 'created')
    }

    return report
  })
}

function assertSubscriptionProvider(slug: string, kind: string): void {
  if (kind !== 'subscription') {
    throw new Error(`[seed] llm_providers ${slug} is not a subscription; migrate it explicitly.`)
  }
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
