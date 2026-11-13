import type { ModelClass, Prisma } from './generated/prisma/client.ts'

/** The model a pass of a class runs on (spec §9: a class is a profile). */
export interface ClassProfile<Backend extends string = string> {
  /** The backend of the model's provider: one of those the caller named. */
  backend: Backend
  modelId: string
  modelSlug: string
  providerModelId: string
}

/**
 * The profile a pass of the class gets (spec §9): an enabled model of the class with a provider
 * model id, under an enabled subscription provider whose slug is one of `backends` — the backends
 * the caller runs, in the order it prefers them —, the first by that order and then by slug.
 * null — none: the planner refuses such a pass `unavailable`, and «Попробовать ещё» into the class
 * is refused before anything moves. One query for both, so that they never disagree. Read
 * without a lock.
 */
export async function classProfile<Backend extends string>(
  db: Pick<Prisma.TransactionClient, 'llmModel'>,
  input: { modelClass: ModelClass; backends: readonly Backend[] },
): Promise<ClassProfile<Backend> | null> {
  return (await classProfiles(db, input))[0] ?? null
}

/**
 * Every enabled profile of the class, in the order of `backends` and then by slug, one per
 * backend: the first is `classProfile`; the next ones are where a pass goes when the quota of the
 * one before is out (owner's answer of 13.11.2026: the plan, then the API paid by the token).
 */
export async function classProfiles<Backend extends string>(
  db: Pick<Prisma.TransactionClient, 'llmModel'>,
  input: { modelClass: ModelClass; backends: readonly Backend[] },
): Promise<ClassProfile<Backend>[]> {
  const { modelClass, backends } = input
  const models = await db.llmModel.findMany({
    where: {
      enabled: true,
      modelClass,
      providerModelId: { not: null },
      provider: { enabled: true, kind: 'subscription', slug: { in: [...backends] } },
    },
    select: { id: true, slug: true, providerModelId: true, provider: { select: { slug: true } } },
  })
  const rank = (slug: string) => backends.findIndex((backend) => backend === slug)
  const sorted = models.sort(
    (a, b) =>
      rank(a.provider.slug) - rank(b.provider.slug) ||
      (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  )
  const profiles: ClassProfile<Backend>[] = []
  for (const model of sorted) {
    const backend = backends.find((id) => id === model.provider.slug)
    if (backend === undefined || model.providerModelId === null) continue
    if (profiles.some((profile) => profile.backend === backend)) continue
    profiles.push({
      backend,
      modelId: model.id,
      modelSlug: model.slug,
      providerModelId: model.providerModelId,
    })
  }
  return profiles
}
