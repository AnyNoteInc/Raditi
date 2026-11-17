import type { PrismaClient } from '@repo/db'
import { codeHostsAbroadPublishedInProduction } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import {
  addTokenConnection,
  connectGithubApp,
  connectGitlabOAuth,
  listConnections,
  type GitServices,
} from './connections.ts'

// The gate of code hosts abroad on the server (docs/plan/84-projects.md, ПР29; slice 84.16а): in
// production gitlab.com and github.com open only together with `codeHostsAbroadPublishedInProduction`,
// which the owner turns on after the notice of art. 12 of 152-FZ. A direct attempt — the return of
// a sign-in, a token for gitlab.com — is refused before anything reaches the database or Vault.

/** A database nothing may reach: the gate refuses first, or the test learns it did not. */
const untouchable = new Proxy({} as PrismaClient, {
  get() {
    throw new Error('reached the database')
  },
})

function services(appEnv: GitServices['appEnv']) {
  return {
    appEnv,
    secrets: {
      kvWrite: () => Promise.reject(new Error('reached Vault')),
      kvMetadata: () => Promise.reject(new Error('reached Vault')),
    },
    checkHost: vi.fn(async () => undefined),
    gitlabComConfigured: true,
    githubConfigured: true,
  } satisfies GitServices
}

const github = (git: GitServices) =>
  connectGithubApp(untouchable, git, {
    userId: 'u',
    installation: {
      installationId: '77',
      account: { login: 'acme', id: '500' },
      user: { login: 'elena-k', id: '9' },
      repositories: [],
    },
    ip: null,
  })

const gitlab = (git: GitServices) =>
  connectGitlabOAuth(untouchable, git, {
    userId: 'u',
    account: { login: 'elena.k', id: '42' },
    tokens: { accessToken: 'a', refreshToken: null, expiresAt: null },
    ip: null,
  })

/** What a direct attempt in production meets: the refusal while the gate is closed. */
const closed = (code: string) =>
  codeHostsAbroadPublishedInProduction ? { message: 'reached the database' } : { code }

describe('the gate of code hosts abroad', () => {
  it('offers neither GitLab.com nor GitHub in production until the notice is confirmed', async () => {
    const none = { workspace: { findFirst: async () => null } } as unknown as PrismaClient
    const listed = await listConnections(none, services('production'), {
      userId: 'u',
      appEnv: 'production',
    })
    expect(listed.available).toEqual({
      github: codeHostsAbroadPublishedInProduction,
      gitlabCom: codeHostsAbroadPublishedInProduction,
      ownServer: true,
    })
    const outside = await listConnections(none, services('development'), {
      userId: 'u',
      appEnv: 'development',
    })
    expect(outside.available).toEqual({ github: true, gitlabCom: true, ownServer: true })
  })

  it('refuses the return of a sign-in on github.com or gitlab.com before the database', async () => {
    await expect(github(services('production'))).rejects.toMatchObject(
      closed('GIT_CONNECT_UNAVAILABLE'),
    )
    await expect(gitlab(services('production'))).rejects.toMatchObject(
      closed('GIT_CONNECT_UNAVAILABLE'),
    )
    // Outside production the gate lets both through: they go on to the database.
    await expect(github(services('development'))).rejects.toThrow('reached the database')
    await expect(gitlab(services('development'))).rejects.toThrow('reached the database')
  })

  it('takes no token for gitlab.com in production while the gate is closed, an own server it takes', async () => {
    const git = services('production')
    const token = (host: string) =>
      addTokenConnection(untouchable, git, {
        userId: 'u',
        host,
        token: 'glpat-synthetic',
        ip: null,
      })
    for (const host of ['gitlab.com', 'https://gitlab.com/', 'www.gitlab.com'])
      await expect(token(host)).rejects.toMatchObject(closed('GIT_GITLAB_COM_TOKEN'))
    if (!codeHostsAbroadPublishedInProduction) expect(git.checkHost).not.toHaveBeenCalled()
    // An own server in Russia never waits on the gate: it goes on to the check of its host.
    await expect(token('git.kolos-bakery.ru')).rejects.toThrow('reached the database')
    expect(git.checkHost).toHaveBeenCalledWith('git.kolos-bakery.ru')
  })
})
