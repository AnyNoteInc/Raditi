import 'server-only'

import { clientIp, getSessionFromHeaders } from '@repo/auth'
import { prisma } from '@repo/db'
import { gitConnectUnavailable, gitlabComHost, gitlabComOffered } from '@repo/domain'
import { createGitConnect, createGitTransport } from '@repo/git-providers/connect'
import { connectGitlabOAuth, createCaller, createContext } from '@repo/trpc'

import { env } from '@/env'
import { gitHostOptions, gitHostResolver, gitServices } from '@/server/git-services'
import type { GitSignInDependencies } from '@/server/git-sign-in'

/** The sign-in on gitlab.com as the app runs it: its settings, its session, its Vault. */
export const gitSignInDependencies: GitSignInDependencies = {
  appUrl: () => env.web().appUrl,
  secret: () => env.auth().secret,
  now: () => Date.now(),
  async userOf(headers) {
    return (await getSessionFromHeaders(headers))?.user.id ?? null
  },
  async checkProject(headers, projectId) {
    await createCaller(await createContext({ headers })).projectRepo.get({ projectId })
  },
  gitlab() {
    const git = env.git()
    const oauth = git.gitlabOauth
    if (oauth === null || !gitlabComOffered(env.web().appEnv, true)) return null
    return {
      app: { host: gitlabComHost, clientId: oauth.clientId, clientSecret: oauth.clientSecret },
      authorizeOrigin: git.endpoints.gitlabComUrl ?? `https://${gitlabComHost}`,
    }
  },
  connect() {
    const git = env.git()
    return createGitConnect('gitlab', {
      transport: createGitTransport({ resolvePublic: gitHostResolver(gitHostOptions()) }),
      ...(git.endpoints.gitlabComUrl ? { gitlabComUrl: git.endpoints.gitlabComUrl } : {}),
    })
  },
  async save(input) {
    const services = gitServices()
    if (services === null) throw gitConnectUnavailable()
    await connectGitlabOAuth(prisma, services, input)
  },
  clientIp,
}
