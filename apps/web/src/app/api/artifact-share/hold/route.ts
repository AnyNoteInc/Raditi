import { artifactSharingOpen } from '@repo/domain/artifacts'

import { env } from '@/env'
import { holdShareToken, MAX_SHARE_BODY_BYTES } from '@/server/artifact-share'
import { withBodyLimit } from '@/server/body-limit'
import { cabinetOnly } from '@/server/cabinet-only'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The token of a link waits for the sign-in (docs/plan/88-artifacts.md, Ар33). */
export const POST = cabinetOnly(
  withBodyLimit(MAX_SHARE_BODY_BYTES, (request: Request) =>
    holdShareToken(request, artifactSharingOpen(env.web().appEnv)),
  ),
)
