import { withBodyLimit } from '@/server/body-limit'
import { MAX_MCP_SIGN_IN_BODY_BYTES, startSignIn } from '@/server/mcp-sign-in'
import { mcpSignInDependencies } from '@/server/mcp-sign-in-runtime'

export const runtime = 'nodejs'

/** The start of a sign-in to an MCP server (docs/plan/80-mcp-server-credentials.md, §3.4). */
export const POST = withBodyLimit(MAX_MCP_SIGN_IN_BODY_BYTES, (request) =>
  startSignIn(request, mcpSignInDependencies),
)
