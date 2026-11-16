import { randomUUID } from 'node:crypto'

import {
  gitConnectionKinds,
  gitConnectionStates,
  gitRepoVisibilities,
  repoMirrorStates,
  repoModes,
  repoProviderKinds,
} from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import { uuidv7 } from './uuidv7.ts'

const databaseUrl = process.env.DATABASE_URL

/** The error of a refused write, or null when it went through. */
async function refusal(act: () => Promise<unknown>): Promise<string | null> {
  try {
    await act()
    return null
  } catch (error) {
    return String((error as Error).message)
  }
}

// The git connections and the repository of a project (docs/plan/84-projects.md, ПР9, ПР10,
// §4.1): the CHECKs of migrations 20261117140000_credential_kind_git_connection and
// 20261117140100_git_connections, on a schema of their own.
describe.skipIf(!databaseUrl)(
  'PostgreSQL: git connections and project repositories (plan 84)',
  () => {
    let schema: MigratedSchema
    let db: PrismaClient

    beforeAll(async () => {
      schema = await createMigratedSchema(databaseUrl ?? '', 'git_connections')
      await schema.migrate()
      db = schemaClient(databaseUrl ?? '', schema)
    }, 60_000)
    afterAll(async () => {
      await db?.$disconnect()
      await schema?.drop()
    })

    async function owner() {
      const user = await db.user.create({
        data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
      })
      const workspace = await db.workspace.create({
        data: { name: 'Synthetic', dataClass: 'synthetic', createdById: user.id },
      })
      const project = await db.project.create({
        data: {
          id: uuidv7(),
          workspaceId: workspace.id,
          createdById: user.id,
          name: 'Сайт кофейни',
        },
      })
      return { userId: user.id, workspaceId: workspace.id, projectId: project.id }
    }

    const tokenRef = (workspaceId: string | null, id = randomUUID()) =>
      db.credentialRef.create({
        data: {
          workspaceId,
          kind: 'git_connection',
          vaultPath: `kv/workspaces/${workspaceId ?? 'none'}/git/${id}`,
        },
      })

    it('takes a reference of kind git_connection with its workspace, and only with it', async () => {
      const { workspaceId } = await owner()
      const ref = await tokenRef(workspaceId)
      expect(ref).toMatchObject({ kind: 'git_connection', workspaceId, keyVersion: 1 })
      expect(await refusal(() => tokenRef(null))).toMatch(/credential_refs_platform_scope_check/)
      // The CHECK it replaces is kept for the rest: the secret of an MCP server with its workspace,
      // the platform's own references without one.
      await db.credentialRef.create({
        data: { workspaceId, kind: 'mcp_server', vaultPath: `kv/workspaces/${workspaceId}/mcp/a` },
      })
      expect(
        await refusal(() =>
          db.credentialRef.create({
            data: { workspaceId: null, kind: 'mcp_server', vaultPath: `kv/x/${randomUUID()}` },
          }),
        ),
      ).toMatch(/credential_refs_platform_scope_check/)
      expect(
        await refusal(() =>
          db.credentialRef.create({
            data: { workspaceId, kind: 'subscription', vaultPath: `subs/data/${randomUUID()}` },
          }),
        ),
      ).toMatch(/credential_refs_platform_scope_check/)
      await db.credentialRef.create({
        data: { workspaceId: null, kind: 'subscription', vaultPath: `subs/data/${randomUUID()}` },
      })
    })

    it('keeps a token connection with its reference and a GitHub App one without it', async () => {
      const { userId, workspaceId } = await owner()
      const ref = await tokenRef(workspaceId)
      const gitlab = await db.gitConnection.create({
        data: {
          id: uuidv7(),
          workspaceId,
          createdById: userId,
          kind: 'gitlab_token',
          host: 'gitlab.example.ru',
          accountLogin: 'coffee',
          accountId: '42',
          credentialRefId: ref.id,
        },
      })
      expect(gitlab).toMatchObject({ state: 'checking', installationId: null })
      const github = await db.gitConnection.create({
        data: {
          id: uuidv7(),
          workspaceId,
          createdById: userId,
          kind: 'github_app',
          host: 'github.com',
          accountLogin: 'coffee-org',
          accountId: '7',
          installationId: 123_456_789_012n,
          githubUserId: '99',
          state: 'ok',
        },
      })
      expect(github.installationId).toBe(123_456_789_012n)
      // A reference belongs to one connection; the reference outlives no connection by itself.
      expect(
        await refusal(() =>
          db.gitConnection.create({
            data: { ...gitlab, id: uuidv7(), accountId: '43', createdAt: undefined },
          }),
        ),
      ).toMatch(/credential_ref_id|Unique/i)
      expect(await refusal(() => db.credentialRef.delete({ where: { id: ref.id } }))).toMatch(
        /foreign key|git_connections_credential_ref_id_fkey/i,
      )
      // The same account twice for the same user is one connection.
      expect(
        await refusal(() =>
          db.gitConnection.create({
            data: { ...github, id: uuidv7(), createdAt: undefined, updatedAt: undefined },
          }),
        ),
      ).toMatch(/Unique|workspace_id/i)
    })

    it.each([
      ['a GitHub App without its installation', { kind: 'github_app', githubUserId: '1' }],
      ['a GitHub App without its user', { kind: 'github_app', installationId: 1n }],
      [
        'a GitHub App off github.com',
        { kind: 'github_app', installationId: 1n, githubUserId: '1', host: 'github.example.ru' },
      ],
      [
        'a GitHub App with a token',
        { kind: 'github_app', installationId: 1n, githubUserId: '1', token: true },
      ],
      ['a GitLab token without its reference', { kind: 'gitlab_token' }],
      [
        'a GitLab token with an installation',
        { kind: 'gitlab_token', token: true, installationId: 1n },
      ],
      [
        'the OAuth app off gitlab.com',
        { kind: 'gitlab_oauth', token: true, host: 'gitlab.example.ru' },
      ],
      ['an unknown kind', { kind: 'bitbucket', token: true }],
      ['an unknown state', { kind: 'gitlab_token', token: true, state: 'broken' }],
      [
        'a reason that is no code',
        { kind: 'gitlab_token', token: true, stateReason: 'Нет доступа' },
      ],
      ['a host with a port', { kind: 'gitlab_token', token: true, host: 'gitlab.example.ru:8443' }],
      ['a host in capitals', { kind: 'gitlab_token', token: true, host: 'GitLab.example.ru' }],
      ['an empty login', { kind: 'gitlab_token', token: true, accountLogin: ' ' }],
    ])('refuses %s', async (_, input) => {
      const { userId, workspaceId } = await owner()
      const { token, ...data } = input as { token?: boolean } & Record<string, unknown>
      const ref = token ? await tokenRef(workspaceId) : null
      const error = await refusal(() =>
        db.gitConnection.create({
          data: {
            id: uuidv7(),
            workspaceId,
            createdById: userId,
            host:
              data.kind === 'gitlab_oauth'
                ? 'gitlab.com'
                : data.kind === 'github_app'
                  ? 'github.com'
                  : 'gitlab.example.ru',
            accountLogin: 'coffee',
            accountId: '42',
            ...(ref ? { credentialRefId: ref.id } : {}),
            ...data,
          } as never,
        }),
      )
      expect(error).toMatch(/git_connections_\w+_check|23514/)
    })

    it('names every kind, state and visibility of the domain', async () => {
      const { userId, workspaceId } = await owner()
      for (const kind of gitConnectionKinds) {
        const github = kind === 'github_app'
        const ref = github ? null : await tokenRef(workspaceId)
        const connection = await db.gitConnection.create({
          data: {
            id: uuidv7(),
            workspaceId,
            createdById: userId,
            kind,
            host: github ? 'github.com' : 'gitlab.com',
            accountLogin: kind,
            accountId: kind,
            ...(github ? { installationId: 1n, githubUserId: '1' } : { credentialRefId: ref?.id }),
          },
        })
        for (const state of gitConnectionStates)
          await db.gitConnection.update({ where: { id: connection.id }, data: { state } })
        for (const visibility of gitRepoVisibilities)
          await db.gitConnectionRepository.create({
            data: {
              connectionId: connection.id,
              providerRepoId: visibility,
              path: `coffee/${visibility}`,
              name: visibility,
              visibility,
              defaultBranch: 'main',
              branches: ['main', 'dev'],
              canPush: true,
              canHook: false,
              syncedAt: new Date(),
            },
          })
      }
      expect(await db.gitConnectionRepository.count()).toBeGreaterThanOrEqual(9)
      const connection = await db.gitConnection.findFirstOrThrow({ where: { workspaceId } })
      for (const [what, data] of [
        ['a visibility', { visibility: 'secret' }],
        ['branches of no list', { branches: { main: true } }],
        ['more than 100 branches', { branches: Array.from({ length: 101 }, (_, i) => `b${i}`) }],
      ] as const)
        expect(
          await refusal(() =>
            db.gitConnectionRepository.create({
              data: {
                connectionId: connection.id,
                providerRepoId: randomUUID().slice(0, 8),
                path: 'coffee/site',
                name: 'site',
                visibility: 'private',
                defaultBranch: 'main',
                canPush: true,
                canHook: false,
                syncedAt: new Date(),
                ...data,
              },
            }),
          ),
          what,
        ).toMatch(/git_connection_repositories_\w+_check/)
    })

    it('binds one repository to a project: a public link reads only, the address is of its host', async () => {
      const { userId, workspaceId, projectId } = await owner()
      const link = {
        id: uuidv7(),
        projectId,
        workspaceId,
        provider: 'gitlab',
        host: 'gitlab.com',
        path: 'group/sub/project',
        webUrl: 'https://gitlab.com/group/sub/project',
        defaultBranch: 'main',
        mode: 'read',
      }
      const bad = (data: Record<string, unknown>) =>
        refusal(() =>
          db.projectRepository.create({ data: { ...link, id: uuidv7(), ...data } as never }),
        )
      expect(await bad({ mode: 'write' })).toMatch(/project_repositories_connection_mode_check/)
      expect(await bad({ webUrl: 'https://evil.example/group/sub/project' })).toMatch(
        /project_repositories_web_url_check/,
      )
      expect(await bad({ webUrl: 'https://gitlab.com.evil.example/x' })).toMatch(
        /project_repositories_web_url_check/,
      )
      expect(
        await bad({
          provider: 'github',
          host: 'github.example.ru',
          webUrl: 'https://github.example.ru/a/b',
        }),
      ).toMatch(/project_repositories_host_check/)
      expect(await bad({ provider: 'gitea' })).toMatch(/project_repositories_provider_check/)
      expect(await bad({ mirrorState: 'gone' })).toMatch(/project_repositories_mirror_state_check/)
      expect(await bad({ lastFetchedSha: 'A'.repeat(40) })).toMatch(
        /project_repositories_sha_check/,
      )
      const created = await db.projectRepository.create({ data: link })
      expect(created).toMatchObject({ mirrorState: 'syncing', connectionId: null })
      for (const mirrorState of repoMirrorStates)
        await db.projectRepository.update({ where: { id: link.id }, data: { mirrorState } })
      // One repository per project.
      expect(await bad({})).toMatch(/Unique|project_id/i)
      expect(repoModes).toEqual(['read', 'write'])
      expect(repoProviderKinds).toEqual(['github', 'gitlab'])

      // Through a connection it may write; a bound connection is not removed under it.
      const other = await owner()
      const ref = await tokenRef(other.workspaceId)
      const connection = await db.gitConnection.create({
        data: {
          id: uuidv7(),
          workspaceId: other.workspaceId,
          createdById: other.userId,
          kind: 'gitlab_oauth',
          host: 'gitlab.com',
          accountLogin: 'coffee',
          accountId: '42',
          credentialRefId: ref.id,
        },
      })
      await db.projectRepository.create({
        data: {
          ...link,
          id: uuidv7(),
          projectId: other.projectId,
          workspaceId: other.workspaceId,
          connectionId: connection.id,
          providerRepoId: '42',
          mode: 'write',
          lastFetchedSha: 'a'.repeat(40),
        },
      })
      expect(
        await refusal(() => db.gitConnection.delete({ where: { id: connection.id } })),
      ).toMatch(/foreign key|project_repositories_connection_id_fkey/i)
      // A project in the trash and then purged takes its repository with it.
      await db.project.delete({ where: { id: projectId } })
      expect(await db.projectRepository.count({ where: { projectId } })).toBe(0)
      expect(userId).toBeTruthy()
    })
  },
)
