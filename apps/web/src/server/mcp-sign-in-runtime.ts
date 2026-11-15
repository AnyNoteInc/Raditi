import 'server-only'

import { clientIp, getSessionFromHeaders } from '@repo/auth'
import { prisma } from '@repo/db'
import { DomainError } from '@repo/domain'
import { connectSignedInServer, createCaller, createContext } from '@repo/trpc'

import { env } from '@/env'
import { mcpOAuthClient } from '@/server/mcp-oauth'
import { mcpServerServices } from '@/server/mcp-servers'
import type { McpSignInDependencies } from '@/server/mcp-sign-in'
import { publicRequester } from '@/server/public-request'

/** The sign-in of an MCP server as the app runs it: its settings, its session, its Vault. */
export const mcpSignInDependencies: McpSignInDependencies = {
  appUrl: () => env.web().appUrl,
  secret: () => env.auth().secret,
  now: () => Date.now(),
  async userOf(headers) {
    return (await getSessionFromHeaders(headers))?.user.id ?? null
  },
  async check(headers, input) {
    return createCaller(await createContext({ headers })).siteAgentSkills.signInCheck(input)
  },
  client: () => mcpOAuthClient(publicRequester(env.web().mcpServerProbe)),
  async connect(input) {
    const services = mcpServerServices()
    if (services === null)
      throw new DomainError(
        'SITE_SKILL_AUTH_UNAVAILABLE',
        'Servers with a key cannot be added here',
        503,
      )
    await connectSignedInServer(prisma, services, input)
  },
  clientIp,
}
