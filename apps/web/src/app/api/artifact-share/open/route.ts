import { artifactSharingOpen } from '@repo/domain/artifacts'

import { env } from '@/env'
import { MAX_SHARE_BODY_BYTES, openSharedArtifact } from '@/server/artifact-share'
import { withBodyLimit } from '@/server/body-limit'
import { cabinetOnly } from '@/server/cabinet-only'
import { withOriFactHeader } from '@/server/ori-fact-header'
import { getServerCaller } from '@/trpc/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** «Открыть» of the page /a after sign-in and consent (docs/plan/88-artifacts.md, Ар33). */
const open = withOriFactHeader((request: Request) =>
  openSharedArtifact(request, {
    open: artifactSharingOpen(env.web().appEnv),
    opener: async (token) => (await getServerCaller()).artifact.shareOpen({ token }),
  }),
)

// The opening of access is a fact of the ORI: its answer names it to the edge (88.16а-2).
export const POST = cabinetOnly(withBodyLimit(MAX_SHARE_BODY_BYTES, open))
