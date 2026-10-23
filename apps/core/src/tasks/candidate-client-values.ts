import type { PrismaClient } from '@repo/db'
import type { SecretStore } from '@repo/domain'

import { readSiteEnvValuesToRefuse } from '../site-env/site-env-values.ts'
import type { CandidateValues } from './candidate-builder.ts'

/**
 * The values of the client's variables a candidate's plan is checked against (CandidateValues):
 * the rows before the values — a row set after them is seen when the revision is recorded, and
 * its description dropped there.
 */
export function candidateClientValues(
  prisma: Pick<PrismaClient, 'siteEnvVar'>,
  secrets: Pick<SecretStore, 'kvRead'>,
): CandidateValues['clientValues'] {
  return async (siteId) => {
    const variables = await prisma.siteEnvVar.findMany({
      where: { siteId },
      select: { name: true, keyVersion: true },
    })
    return {
      values:
        variables.length === 0
          ? []
          : await readSiteEnvValuesToRefuse(
              secrets,
              siteId,
              variables.map((variable) => variable.name),
            ),
      variables,
    }
  }
}
