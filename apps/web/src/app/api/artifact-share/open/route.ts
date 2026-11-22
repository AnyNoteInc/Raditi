import { artifactSharingOpen } from '@repo/domain/artifacts'

import { env } from '@/env'
import { MAX_SHARE_BODY_BYTES, openSharedArtifact } from '@/server/artifact-share'
import { withBodyLimit } from '@/server/body-limit'
import { cabinetOnly } from '@/server/cabinet-only'
import { getServerCaller } from '@/trpc/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** «Открыть» of the page /a after sign-in and consent (docs/plan/88-artifacts.md, Ар33). */
export const POST = cabinetOnly(
  withBodyLimit(MAX_SHARE_BODY_BYTES, (request: Request) =>
    openSharedArtifact(request, {
      open: artifactSharingOpen(env.web().appEnv),
      opener: async (token) => (await getServerCaller()).artifact.shareOpen({ token }),
    }),
  ),
)
