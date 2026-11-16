import { describe, expect, it } from 'vitest'

import { DomainError, repoProviderOffers, type RepoRef } from '@repo/domain'

import { createGitProvider, gitProviderCiPaths } from './create-git-provider.ts'
import { fakeSend } from './testing/fake-send.ts'
import { createGitTransport } from './transport.ts'

const repo: RepoRef = { provider: 'github', host: 'github.com', path: 'acme/site' }
const anonymous = { kind: 'anonymous' } as const

function setup(routes: Parameters<typeof fakeSend>[0]) {
  const { send, calls } = fakeSend(routes)
  const transport = createGitTransport({ resolvePublic: async () => '140.82.112.6', send })
  return { provider: createGitProvider({ kind: 'github', host: 'github.com', transport }), calls }
}

describe('GitHub, anonymous reading', () => {
  it('reads a public repository; size is in kilobytes', async () => {
    const { provider, calls } = setup({
      'GET /repos/acme/site': {
        status: 200,
        body: {
          id: 7,
          full_name: 'acme/site',
          default_branch: 'main',
          private: false,
          html_url: 'https://evil.example/x',
          size: 10,
        },
      },
    })
    expect(await provider.getRepository(anonymous, repo)).toEqual({
      ref: { ...repo, providerRepoId: '7' },
      defaultBranch: 'main',
      private: false,
      webUrl: 'https://github.com/acme/site',
      cloneUrl: 'https://github.com/acme/site.git',
      sizeBytes: 10_240,
    })
    expect(calls[0]!.url.host).toBe('api.github.com')
    expect(calls[0]!.headers['x-github-api-version']).toBe('2022-11-28')
    expect(calls[0]!.headers.authorization).toBeUndefined()
  })

  it('a private or missing repository is null', async () => {
    const { provider } = setup({})
    expect(await provider.getRepository(anonymous, repo)).toBeNull()
  })

  it('lists branches and filters them', async () => {
    const { provider } = setup({
      'GET /repos/acme/site/branches': {
        status: 200,
        body: [{ name: 'main' }, { name: 'feature/menu' }],
      },
    })
    expect(await provider.listBranches(anonymous, repo, 'MENU')).toEqual(['feature/menu'])
  })

  it('maps workflow runs', async () => {
    const { provider } = setup({
      'GET /repos/acme/site/actions/runs': {
        status: 200,
        body: {
          workflow_runs: [
            {
              id: 1,
              name: 'CI',
              head_sha: 'a'.repeat(40),
              head_branch: 'main',
              status: 'completed',
              conclusion: 'timed_out',
            },
          ],
        },
      },
    })
    const [run] = await provider.listRuns(anonymous, repo, { branch: 'main' })
    expect(run).toMatchObject({
      id: '1',
      status: 'failed',
      url: 'https://github.com/acme/site/actions/runs/1',
    })
  })

  it('writes and tokens wait for the GitHub App', async () => {
    const { provider, calls } = setup({})
    await expect(
      provider.openPullRequest(anonymous, repo, {
        head: 'a',
        base: 'main',
        title: 't',
        body: '',
        draft: false,
      }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    await expect(
      provider.issueCredentials({ kind: 'token', token: 't' }, repo, 'write', { ttlSeconds: 60 }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    expect(calls).toHaveLength(0)
    expect(provider.support).toMatchObject({ autoMerge: false, ciLint: false, label: 'GitHub' })
    expect(provider.support.requestRef(3)).toBe('#3')
  })

  it('names the paths of build settings of each provider without an adapter (ПР16)', () => {
    const transport = createGitTransport({ resolvePublic: async () => '203.0.113.1' })
    for (const [kind, host] of [
      ['github', 'github.com'],
      ['gitlab', 'gitlab.example.ru'],
    ] as const) {
      const provider = createGitProvider({ kind, host, transport })
      expect(gitProviderCiPaths(kind)).toEqual(provider.support.ciPaths)
      expect(gitProviderCiPaths(kind)).toContain('CODEOWNERS')
    }
  })

  it('what a card offers of each provider is what its adapter supports (ПР15)', () => {
    const transport = createGitTransport({ resolvePublic: async () => '203.0.113.1' })
    for (const [kind, host] of [
      ['github', 'github.com'],
      ['gitlab', 'gitlab.example.ru'],
    ] as const) {
      const { support, branchHead } = createGitProvider({ kind, host, transport })
      expect(repoProviderOffers[kind]).toEqual({
        autoMerge: support.autoMerge,
        manualJobs: support.manualJobs,
      })
      // A deploy reads the head of the main branch again before it plays a job.
      if (support.manualJobs) expect(branchHead).toBeTypeOf('function')
    }
  })

  it('GitHub lives on github.com only', () => {
    const transport = createGitTransport({ resolvePublic: async () => '203.0.113.1' })
    expect(() =>
      createGitProvider({ kind: 'github', host: 'github.example.ru', transport }),
    ).toThrow(DomainError)
    expect(() =>
      createGitProvider({
        kind: 'github',
        host: 'github.com',
        transport,
        endpoints: { githubApiUrl: 'https://10.0.0.1' },
      }),
    ).toThrow(DomainError)
  })
})
