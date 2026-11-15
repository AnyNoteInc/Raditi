import { finishSignIn } from '@/server/mcp-sign-in'
import { mcpSignInDependencies } from '@/server/mcp-sign-in-runtime'

export const runtime = 'nodejs'

/** The return of the owner from the server of sign-in (docs/plan/80-mcp-server-credentials.md). */
export function GET(request: Request) {
  return finishSignIn(request, mcpSignInDependencies)
}
