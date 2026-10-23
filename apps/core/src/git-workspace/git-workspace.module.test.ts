import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Test } from '@nestjs/testing'
import type { GitProvider } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CoreConfig } from '../config/config.ts'
import { CoreConfigModule } from '../config/config.module.ts'
import { testCoreConfig } from '../testing/fakes.ts'
import { gitWorkspaceOptions } from './git-config.ts'
import { GitCredentialRuntime } from './git-credential-runtime.ts'
import { GitWorkspaceModule } from './git-workspace.module.ts'
import { GitWorkspaceService } from './git-workspace.service.ts'
import { GIT_PROVIDER } from './git-workspace.tokens.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const compile = (config: CoreConfig) =>
  Test.createTestingModule({
    imports: [CoreConfigModule.forRoot({ config, background: false }), GitWorkspaceModule],
  }).compile()

/** A provider that only records what the module asks of its credential lifecycle. */
const lifecycle = () => ({
  kind: 'gitea' as const,
  sweepCredentials: vi.fn(async () => {}),
  revokeCredentials: vi.fn(async () => {}),
})
const running = (provider: ReturnType<typeof lifecycle>, background: boolean) =>
  Test.createTestingModule({
    imports: [
      CoreConfigModule.forRoot({ config: testCoreConfig(), background }),
      GitWorkspaceModule,
    ],
  })
    .overrideProvider(GIT_PROVIDER)
    .useValue(provider)
    .compile()

describe('GitWorkspaceModule', () => {
  it('provides nothing to clone with while git is not configured', async () => {
    const moduleRef = await compile(testCoreConfig())
    expect(testCoreConfig().git).toBeNull()
    expect(moduleRef.get<GitProvider | null>(GIT_PROVIDER)).toBeNull()
    expect(moduleRef.get<GitWorkspaceService | null>(GitWorkspaceService)).toBeNull()
    await moduleRef.close()
  })

  it('provides the configured provider and a workspace bound to its origin and CA file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raditi-git-module-test-'))
    roots.push(root)
    const caFile = join(root, 'ca.pem')
    await writeFile(caFile, 'synthetic CA placeholder\n')
    const git = {
      kind: 'gitea' as const,
      baseUrl: 'https://gitea.raditi.test:3443/gitea',
      token: 'synthetic-bot-token',
      caFile,
    }
    const moduleRef = await compile({ ...testCoreConfig(), git })

    expect(moduleRef.get<GitProvider>(GIT_PROVIDER).kind).toBe('gitea')
    expect(moduleRef.get(GitWorkspaceService)).toBeInstanceOf(GitWorkspaceService)
    expect(gitWorkspaceOptions(git)).toEqual({
      transport: { kind: 'https', allowedOrigins: ['https://gitea.raditi.test:3443'], caFile },
    })
    expect(gitWorkspaceOptions({ ...git, caFile: null })).toEqual({
      transport: { kind: 'https', allowedOrigins: ['https://gitea.raditi.test:3443'] },
    })
    // GIT_MIRROR_DIR (plan 53, Р10): where the mirrors and the bundle cache live.
    expect(gitWorkspaceOptions({ ...git, caFile: null, mirrorDir: '/work/mirrors' })).toEqual({
      transport: { kind: 'https', allowedOrigins: ['https://gitea.raditi.test:3443'] },
      mirrorDir: '/work/mirrors',
    })
    await moduleRef.close()
  })

  it('fails at start, not in the first turn, when the CA file is missing', async () => {
    const git = {
      kind: 'gitea' as const,
      baseUrl: 'https://gitea.raditi.test',
      token: 'synthetic-bot-token',
      caFile: '/nonexistent/raditi/gitea-ca.pem',
    }
    await expect(compile({ ...testCoreConfig(), git })).rejects.toThrow('CA file')
  })

  it('sweeps the grants of earlier processes at start and revokes its own at shutdown', async () => {
    const provider = lifecycle()
    const moduleRef = await running(provider, true)
    expect(provider.sweepCredentials).not.toHaveBeenCalled()

    await moduleRef.init()
    expect(provider.sweepCredentials).toHaveBeenCalledOnce()
    expect(provider.revokeCredentials).not.toHaveBeenCalled()

    await moduleRef.close()
    expect(provider.revokeCredentials).toHaveBeenCalledOnce()
    expect(provider.sweepCredentials).toHaveBeenCalledOnce()
  })

  it('asks the provider for nothing at start without background work, and still revokes', async () => {
    const provider = lifecycle()
    const moduleRef = await running(provider, false)
    await moduleRef.init()
    expect(provider.sweepCredentials).not.toHaveBeenCalled()
    await moduleRef.close()
    expect(provider.revokeCredentials).toHaveBeenCalledOnce()
  })

  it('starts and stops without a provider', async () => {
    const moduleRef = await compile(testCoreConfig())
    await moduleRef.init()
    await moduleRef.close()
    expect(moduleRef.get(GitCredentialRuntime)).toBeInstanceOf(GitCredentialRuntime)
  })
})

describe('GitCredentialRuntime', () => {
  it('does not wait for the sweep at start and only warns when it fails', async () => {
    const warn = vi.fn()
    let fail!: (error: Error) => void
    const provider = {
      sweepCredentials: vi.fn(() => new Promise<void>((_resolve, reject) => void (fail = reject))),
      revokeCredentials: vi.fn(async () => {}),
    }
    const runtime = new GitCredentialRuntime(provider, true, { warn })

    // Returns while Gitea has not answered: core starts with Gitea down.
    expect(runtime.onApplicationBootstrap()).toBeUndefined()
    expect(provider.sweepCredentials).toHaveBeenCalledOnce()
    expect(warn).not.toHaveBeenCalled()

    fail(new Error('synthetic-bot-token must not be logged'))
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce())
    expect(warn).toHaveBeenCalledWith('git_credentials_sweep_failed')
  })

  it('stops even when the provider could not revoke, and says so', async () => {
    const warn = vi.fn()
    const provider = {
      sweepCredentials: vi.fn(async () => {}),
      revokeCredentials: vi.fn(async () => {
        throw new Error('synthetic-bot-token must not be logged')
      }),
    }
    const runtime = new GitCredentialRuntime(provider, true, { warn })
    await expect(runtime.onApplicationShutdown()).resolves.toBeUndefined()
    expect(warn.mock.calls).toEqual([['git_credentials_revoke_failed']])
  })
})
