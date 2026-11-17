import 'server-only'

import { clientIp, getSessionFromHeaders } from '@repo/auth'
import { prisma } from '@repo/db'
import {
  gitConnectUnavailable,
  githubHost,
  githubOffered,
  gitlabComHost,
  gitlabComOffered,
} from '@repo/domain'
import { createGitConnect, createGitTransport } from '@repo/git-providers/connect'
import { connectGithubApp, connectGitlabOAuth, createCaller, createContext } from '@repo/trpc'

import { env } from '@/env'
import { gitHostOptions, gitHostResolver, gitServices } from '@/server/git-services'
import type { GitSignInDependencies } from '@/server/git-sign-in'
import type { GithubSignInDependencies } from '@/server/github-sign-in'

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

/** The connection of the GitHub App as the app runs it (slice 84.25). */
export const githubSignInDependencies: GithubSignInDependencies = {
  appUrl: gitSignInDependencies.appUrl,
  secret: gitSignInDependencies.secret,
  now: gitSignInDependencies.now,
  userOf: gitSignInDependencies.userOf,
  checkProject: gitSignInDependencies.checkProject,
  github() {
    const git = env.git()
    const app = git.githubApp
    if (app === null || !githubOffered(env.web().appEnv, true)) return null
    return {
      slug: app.slug,
      app: { host: githubHost, clientId: app.clientId, clientSecret: app.clientSecret },
      webOrigin: git.endpoints.githubWebUrl ?? `https://${githubHost}`,
    }
  },
  connect() {
    const git = env.git()
    return createGitConnect('github', {
      transport: createGitTransport({ resolvePublic: gitHostResolver(gitHostOptions()) }),
      ...(git.endpoints.githubApiUrl ? { githubApiUrl: git.endpoints.githubApiUrl } : {}),
      ...(git.endpoints.githubWebUrl ? { githubWebUrl: git.endpoints.githubWebUrl } : {}),
    })
  },
  async save(input) {
    const services = gitServices()
    if (services === null) throw gitConnectUnavailable()
    return connectGithubApp(prisma, services, input)
  },
  clientIp,
}
