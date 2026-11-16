import { readFileSync } from 'node:fs'

import { Logger, Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { gitlabComHost, type SecretStore } from '@repo/domain'
import { createGitProvider, createGitTransport } from '@repo/git-providers'
import { createGitConnect } from '@repo/git-providers/connect'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../config/config.tokens.ts'
import { GitWorkspaceModule } from '../git-workspace/git-workspace.module.ts'
import { GIT_WORKSPACE } from '../git-workspace/git-workspace.tokens.ts'
import type { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import { GitAuthSource } from './git-auth-source.ts'
import { GitJobs } from './git-jobs.ts'
import { GitProcessor } from './git.processor.ts'
import { GIT_JOBS } from './git.tokens.ts'
import { publicHostResolver } from './public-host.ts'

/** Where web sends the client back from gitlab.com; GitLab wants it again on a refresh. */
export const gitlabCallbackPath = '/api/git/gitlab/callback'

/**
 * The git connections and the repositories of projects in core (docs/plan/84-projects.md, §4.3;
 * slice 84.17): the worker of the queue `git` over the trusted git of GitWorkspaceModule, the
 * access of a connection from Vault (`core-git`) and the adapters of @repo/git-providers, every
 * request to an address checked once per operation.
 */
@Module({
  imports: [GitWorkspaceModule],
  providers: [
    {
      provide: GIT_JOBS,
      inject: [PRISMA, SECRET_STORE, CORE_CONFIG, GIT_WORKSPACE],
      useFactory: (
        prisma: PrismaClient,
        secrets: SecretStore,
        config: CoreConfig,
        workspace: GitWorkspaceService,
      ) => {
        const logger = new Logger('Git')
        const ca = config.git.caFile ? readFileSync(config.git.caFile, 'utf8') : undefined
        const resolvePublic = publicHostResolver({
          refusedSubnets: config.gitRefusedSubnets,
          allowLoopback: config.git.allowLoopback,
        })
        // The host of the operation goes to its checked address; a fake of a stand standing in
        // for it (`https://localhost:<port>`) is resolved and checked on its own.
        const pinned = (host: string, address: string) =>
          createGitTransport({
            resolvePublic: (name) =>
              name === host ? Promise.resolve(address) : resolvePublic(name),
            ...(ca ? { ca } : {}),
          })
        const gitlabComUrl = config.gitApps.endpoints.gitlabComUrl
        const oauth = config.gitApps.gitlabOauth
        const auth = new GitAuthSource({
          prisma,
          secrets,
          connect: () =>
            createGitConnect('gitlab', {
              transport: createGitTransport({ resolvePublic, ...(ca ? { ca } : {}) }),
              ...(gitlabComUrl ? { gitlabComUrl } : {}),
            }),
          gitlabOauth: oauth
            ? {
                host: gitlabComHost,
                clientId: oauth.clientId,
                clientSecret: oauth.clientSecret,
                redirectUri: `${config.billing.appUrl}${gitlabCallbackPath}`,
              }
            : null,
        })
        return new GitJobs({
          prisma,
          auth,
          resolvePublic,
          provider: ({ kind, host, address }) =>
            createGitProvider({
              kind,
              host,
              transport: pinned(host, address),
              endpoints: config.gitApps.endpoints,
            }),
          workspace,
          logger: { log: (line) => logger.log(line), warn: (line) => logger.warn(line) },
        })
      },
    },
    GitProcessor,
  ],
  // The fetch of a pass of a chat with a repository (docs/plan/84-projects.md, §4.3, step 3).
  exports: [GIT_JOBS],
})
export class GitModule {}
