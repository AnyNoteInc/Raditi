import type { Prisma } from '@repo/db'
import {
  candidateFactsSchema,
  candidateVersionFacts,
  conflict,
  proposeVersion,
  type VersionFacts,
  type VersionProposal,
} from '@repo/domain'

/**
 * The number a release of a candidate is offered under (Р26): from the highest version the
 * platform knows of the site — installed, of any release (the burnt numbers too) and the base
 * of the candidate; `v0.0.0` without any. The tags of the repository are core's to see: a tag
 * taken there refuses the release before anything is pushed.
 */
export async function versionProposal(
  db: Pick<Prisma.TransactionClient, 'site' | 'siteRelease'>,
  input: { siteId: string; baseVersion: string | null; facts: unknown },
): Promise<VersionProposal> {
  const site = await db.site.findUniqueOrThrow({
    where: { id: input.siteId },
    select: { installedVersion: true },
  })
  const releases = await db.siteRelease.findMany({
    where: { siteId: input.siteId },
    select: { version: true },
  })
  return proposeVersion(
    {
      installed: site.installedVersion,
      releases: [...releases.map((release) => release.version), input.baseVersion ?? ''],
      tags: [],
    },
    versionFactsOf(input.facts),
  )
}

/**
 * What the platform knows of a candidate when it proposes a number: the same rule core recorded
 * the candidate's proposal by (`candidateVersionFacts` — media count as new files).
 */
export function versionFactsOf(facts: unknown): VersionFacts {
  const parsed = candidateFactsSchema.safeParse(facts)
  if (!parsed.success) throw conflict('The facts of the candidate are unreadable')
  return candidateVersionFacts(parsed.data)
}
