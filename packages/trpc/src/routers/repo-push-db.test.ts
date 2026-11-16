import { createHash, createHmac, randomUUID } from 'node:crypto'

import {
  createPrismaClient,
  ensureChatBranch,
  insertFeedEvent,
  type PrismaClient,
  type User,
} from '@repo/db'
import {
  legalDocuments,
  readRepoConfirmToken,
  repoCiDiffKey,
  type ObjectStorage,
  type SecretStore,
} from '@repo/domain'
import { TRPCError } from '@trpc/server'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../router.ts'
import type { ChatContext } from '../services/chat/context.ts'
import type { GitServices } from '../services/git/connections.ts'

// «Отправить в ветку» and «Открыть запрос на слияние» on PostgreSQL (docs/plan/84-projects.md,
// ПР13–ПР15; slice 84.19): the token binds the head of the chat and the diff of its card, the press
// is written once with the token itself and the job of core, and only the author of the project
// with a connection of their own may press.

const databaseUrl = process.env.DATABASE_URL
const SECRET = 'synthetic-repo-confirm-secret-of-the-trpc-test'
const mac = (material: string) => createHmac('sha256', SECRET).update(material).digest('base64url')
const image = `registry.invalid/raditi/opencode@sha256:${'a'.repeat(64)}`
const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)

function v7(): string {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function refusal(act: () => Promise<unknown>): Promise<string> {
  try {
    await act()
  } catch (error) {
    if (error instanceof TRPCError)
      return (error.cause as { code?: string } | undefined)?.code ?? error.code
    throw error
  }
  throw new Error('The procedure was not refused')
}

describe.skipIf(!databaseUrl)('PostgreSQL: the push of a chat branch (plan 84, 84.19)', () => {
  let db: PrismaClient
  const userIds: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const users = userIds.splice(0)
    const workspaces = await db.workspace.findMany({
      where: { createdById: { in: users } },
      select: { id: true },
    })
    const owned = { workspaceId: { in: workspaces.map(({ id }) => id) } }
    await db.outboxEvent.deleteMany({ where: { topic: 'git' } })
    await db.repoAction.deleteMany({ where: { createdById: { in: users } } })
    await db.taskEvent.deleteMany({ where: { task: owned } })
    await db.taskTurn.deleteMany({ where: { task: owned } })
    await db.task.deleteMany({ where: owned })
    await db.projectRepository.deleteMany({ where: owned })
    await db.gitConnection.deleteMany({ where: owned })
    await db.credentialRef.deleteMany({ where: owned })
    await db.creditLedger.deleteMany({ where: { account: owned } })
    await db.creditHold.deleteMany({ where: { account: owned } })
    await db.billingAccount.deleteMany({ where: owned })
    await db.project.deleteMany({ where: owned })
    await db.auditLog.deleteMany({ where: owned })
    await db.workspace.deleteMany({ where: { id: owned.workspaceId } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  // `raditi-artifacts` as core leaves it: the diffs of the build settings (ПР16).
  const kept = new Map<string, Buffer>()
  const chatContext: ChatContext = {
    appEnv: 'test',
    browser: null,
    storage: () =>
      ({
        get: async (_bucket: string, key: string) => {
          const bytes = kept.get(key)
          return bytes
            ? (async function* () {
                yield bytes
              })()
            : null
        },
      }) as unknown as ObjectStorage,
    secrets: () => ({}) as SecretStore,
  }

  async function person(): Promise<User> {
    const row = await db.user.create({
      data: { name: 'Push verification', email: `${randomUUID()}@git.example.ru` },
    })
    userIds.push(row.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({ ...consent, userId: row.id, source: 'sign_up' })),
    })
    return row
  }

  function callerOf(user: User, confirmMac: GitServices['confirmMac'] = mac) {
    return createCaller({
      prisma: db,
      headers: new Headers(),
      user,
      session: {
        id: randomUUID(),
        userId: user.id,
        token: `push-test-${randomUUID()}`,
        expiresAt: new Date('2030-01-01'),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: null,
        userAgent: null,
      },
      billing: null,
      chat: chatContext,
      git: {
        appEnv: 'test',
        secrets: { kvWrite: async () => ({ version: 1 }), kvMetadata: async () => null },
        checkHost: async () => {},
        gitlabComConfigured: false,
        confirmMac,
      },
    })
  }

  /** A project of the user with a connected repository, a chat in it and one card of a turn. */
  async function fixture(
    options: { mode?: 'read' | 'write'; ciTouched?: boolean; ciPaths?: object } = {},
  ) {
    const user = await person()
    const caller = callerOf(user)
    const projectId = v7()
    await caller.project.create({ projectId, name: 'Колос' })
    const { workspaceId } = await db.project.findUniqueOrThrow({ where: { id: projectId } })
    const connectionId = randomUUID()
    const ref = await db.credentialRef.create({
      data: {
        workspaceId,
        kind: 'git_connection',
        vaultPath: `kv/workspaces/${workspaceId}/git/${connectionId}`,
      },
    })
    await db.gitConnection.create({
      data: {
        id: connectionId,
        workspaceId,
        createdById: user.id,
        kind: 'gitlab_token',
        host: 'gitlab.example.ru',
        accountLogin: 'kolos',
        accountId: `acc-${connectionId.slice(0, 8)}`,
        credentialRefId: ref.id,
        state: 'ok',
      },
    })
    const projectRepositoryId = randomUUID()
    await db.projectRepository.create({
      data: {
        id: projectRepositoryId,
        projectId,
        workspaceId,
        connectionId,
        provider: 'gitlab',
        host: 'gitlab.example.ru',
        providerRepoId: '42',
        path: 'kolos/site',
        webUrl: 'https://gitlab.example.ru/kolos/site',
        defaultBranch: 'main',
        mode: options.mode ?? 'write',
        mirrorState: 'ready',
        ...(options.ciPaths ? { ciPaths: options.ciPaths } : {}),
      },
    })
    const task = await db.task.create({
      data: {
        id: v7(),
        workspaceId,
        projectId,
        createdById: user.id,
        status: 'awaiting_user',
        title: 'Новое меню',
      },
    })
    const head = 'c'.repeat(40)
    const turn = await db.taskTurn.create({
      data: {
        taskId: task.id,
        turnNo: 1,
        status: 'completed',
        driverId: 'opencode',
        image,
        baseSha: 'b'.repeat(40),
        headSha: head,
      },
    })
    const branch = await ensureChatBranch(db, {
      taskId: task.id,
      projectRepositoryId,
      title: task.title,
      baseSha: 'b'.repeat(40),
    })
    await insertFeedEvent(db, {
      taskId: task.id,
      turnId: turn.id,
      row: {
        type: 'feed.repo_changes',
        payload: {
          v: 1,
          branch: branch.branch,
          baseSha: 'b'.repeat(40),
          headSha: head,
          diffSha256: 'd'.repeat(64),
          files: 1,
          additions: 3,
          deletions: 1,
          list: [{ path: 'menu.html', additions: 3, deletions: 1 }],
          ciTouched: options.ciTouched ?? false,
          pushed: false,
          mergeRequest: null,
        },
      },
    })
    return { user, caller, task, head, branch, projectRepositoryId }
  }

  it('binds the token to the head and the diff of the card, and writes the press once', async () => {
    const f = await fixture()
    expect(await f.caller.projectRepo.branch({ taskId: f.task.id })).toMatchObject({
      branch: f.branch.branch,
      state: 'local',
      headSha: f.head,
      sent: false,
      canPush: true,
      mergeRequest: null,
      lastAction: null,
    })
    const prepared = await f.caller.projectRepo.preparePush({ taskId: f.task.id })
    expect(prepared).toMatchObject({
      branch: f.branch.branch,
      headSha: f.head,
      diffSha256: 'd'.repeat(64),
      stat: { files: 1, additions: 3, deletions: 1 },
      rewinds: false,
      opensMergeRequest: true,
      proposal: { title: 'Новое меню', description: '', draft: false, reservedId: null },
    })
    expect(readRepoConfirmToken(prepared.confirmToken, mac, new Date())).toMatchObject({
      kind: 'push',
      userId: f.user.id,
      taskId: f.task.id,
      targetBranch: f.branch.branch,
      headSha: f.head,
      diffSha256: 'd'.repeat(64),
      opensMergeRequest: true,
    })
    const mergeRequest = {
      title: 'Новое меню',
      description: 'Цены',
      draft: false,
      reservedId: null,
    }
    const { actionId } = await f.caller.projectRepo.confirmPush({
      confirmToken: prepared.confirmToken,
      mergeRequest,
    })
    const row = await db.repoAction.findUniqueOrThrow({ where: { id: actionId } })
    expect(row).toMatchObject({
      kind: 'open_mr',
      state: 'queued',
      createdById: f.user.id,
      taskId: f.task.id,
      args: { token: prepared.confirmToken, mergeRequest },
    })
    expect(
      await db.outboxEvent.count({
        where: { topic: 'git', type: 'git.action', payload: { equals: { actionId } } },
      }),
    ).toBe(1)
    expect(
      await refusal(() =>
        f.caller.projectRepo.confirmPush({ confirmToken: prepared.confirmToken, mergeRequest }),
      ),
    ).toBe('REPO_CONFIRM_USED')
    // A first push opens the merge request: a token for one without it is not that press.
    expect(
      await refusal(() =>
        f.caller.projectRepo.confirmPush({ confirmToken: prepared.confirmToken }),
      ),
    ).toBe('REPO_CONFIRM_INVALID')
    expect(await db.repoAction.count({ where: { taskId: f.task.id } })).toBe(1)
  })

  it('takes no press of another user, of a read-only repository or with build settings', async () => {
    const f = await fixture()
    const stranger = callerOf(await person())
    expect(await refusal(() => stranger.projectRepo.preparePush({ taskId: f.task.id }))).toBe(
      'NOT_FOUND',
    )
    const prepared = await f.caller.projectRepo.preparePush({ taskId: f.task.id })
    expect(
      await refusal(() =>
        stranger.projectRepo.confirmPush({
          confirmToken: prepared.confirmToken,
          mergeRequest: { title: 'а', description: '', draft: false, reservedId: null },
        }),
      ),
    ).toBe('REPO_CONFIRM_INVALID')
    const read = await fixture({ mode: 'read' })
    expect(await refusal(() => read.caller.projectRepo.preparePush({ taskId: read.task.id }))).toBe(
      'REPO_READ_ONLY',
    )
    const ci = await fixture({ ciTouched: true })
    expect(await refusal(() => ci.caller.projectRepo.preparePush({ taskId: ci.task.id }))).toBe(
      'REPO_CI_CHANGE',
    )
    // Without REPO_CONFIRM_SECRET no card is offered.
    expect(
      await refusal(() => callerOf(f.user, null).projectRepo.preparePush({ taskId: f.task.id })),
    ).toBe('GIT_CONNECT_UNAVAILABLE')
  })

  it('has nothing to send once the branch at the client holds the head, or every turn was undone', async () => {
    const f = await fixture()
    await db.projectRepoBranch.update({
      where: { taskId: f.task.id },
      data: { mirrorSha: f.head, remoteSha: f.head, state: 'pushed' },
    })
    expect(await refusal(() => f.caller.projectRepo.preparePush({ taskId: f.task.id }))).toBe(
      'REPO_NOTHING_TO_PUSH',
    )
    expect(await f.caller.projectRepo.branch({ taskId: f.task.id })).toMatchObject({ sent: true })
    const g = await fixture()
    await db.taskTurn.updateMany({ where: { taskId: g.task.id }, data: { undoneAt: new Date() } })
    expect(await refusal(() => g.caller.projectRepo.preparePush({ taskId: g.task.id }))).toBe(
      'REPO_NOTHING_TO_PUSH',
    )
  })

  // The card «Агент хочет изменить настройки сборки» (ПР16; slice 84.20).
  describe('a change of build settings', () => {
    const ciPatch =
      'diff --git a/.gitlab-ci.yml b/.gitlab-ci.yml\n--- a/.gitlab-ci.yml\n+++ b/.gitlab-ci.yml\n@@ -1 +1 @@\n-lint: a\n+lint: b\n' +
      'diff --git a/CODEOWNERS b/CODEOWNERS\n--- /dev/null\n+++ b/CODEOWNERS\n@@ -0,0 +1 @@\n+* @kolos\n'
    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

    /** What `git.ci_lint` of core leaves for the head of the chat. */
    async function linted(f: Awaited<ReturnType<typeof fixture>>, patch = ciPatch) {
      kept.set(repoCiDiffKey(f.task.id, f.head), Buffer.from(patch))
      await db.projectRepoBranch.update({
        where: { taskId: f.task.id },
        data: {
          ciDiffSha256: sha256(patch),
          ciLint: {
            v: 1,
            headSha: f.head,
            fromSha: 'b'.repeat(40),
            ciDiffSha256: sha256(patch),
            files: [
              { path: '.gitlab-ci.yml', additions: 1, deletions: 1 },
              { path: 'CODEOWNERS', additions: 1, deletions: 0 },
            ],
            tooLarge: false,
            lint: { valid: false, errors: ['jobs:lint script can not be empty'] },
            includes: [],
            declined: false,
          },
        },
      })
    }

    it('is loading until core has read it, then shows the diff and binds the token to it', async () => {
      const f = await fixture({ ciTouched: true })
      expect(await f.caller.projectRepo.branch({ taskId: f.task.id })).toMatchObject({
        ciChange: 'needed',
      })
      expect(await f.caller.projectRepo.prepareCiChange({ taskId: f.task.id })).toEqual({
        state: 'loading',
      })
      // Web asks core for the diff and the lint; it never reaches the provider itself.
      expect(
        await db.outboxEvent.count({
          where: {
            topic: 'git',
            type: 'git.ci_lint',
            payload: { equals: { taskId: f.task.id, headSha: f.head } },
          },
        }),
      ).toBe(1)
      await linted(f)
      const ready = await f.caller.projectRepo.prepareCiChange({ taskId: f.task.id })
      if (ready.state !== 'ready') throw new Error('not ready')
      expect(ready).toMatchObject({
        branch: f.branch.branch,
        headSha: f.head,
        ciDiffSha256: sha256(ciPatch),
        lint: { valid: false, errors: ['jobs:lint script can not be empty'] },
        opensMergeRequest: true,
      })
      expect(ready.files.map((file) => [file.path, file.additions, file.deletions])).toEqual([
        ['.gitlab-ci.yml', 1, 1],
        ['CODEOWNERS', 1, 0],
      ])
      expect(ready.files[1]!.diff).toContain('+* @kolos')
      expect(readRepoConfirmToken(ready.confirmToken, mac, new Date())).toMatchObject({
        kind: 'ci_change',
        headSha: f.head,
        diffSha256: 'd'.repeat(64),
        ciDiffSha256: sha256(ciPatch),
      })
      // «Отправить в ветку» is not the way, and the card's token opens no other press.
      expect(await refusal(() => f.caller.projectRepo.preparePush({ taskId: f.task.id }))).toBe(
        'REPO_CI_CHANGE',
      )
      const mergeRequest = { title: 'Новое меню', description: '', draft: false, reservedId: null }
      expect(
        await refusal(() =>
          f.caller.projectRepo.confirmPush({ confirmToken: ready.confirmToken, mergeRequest }),
        ),
      ).toBe('REPO_CONFIRM_INVALID')
      const { actionId } = await f.caller.projectRepo.confirmCiChange({
        confirmToken: ready.confirmToken,
        mergeRequest,
      })
      expect(await db.repoAction.findUniqueOrThrow({ where: { id: actionId } })).toMatchObject({
        kind: 'ci_push',
        state: 'queued',
        createdById: f.user.id,
      })
      expect(
        await db.outboxEvent.count({
          where: { topic: 'git', type: 'git.action', payload: { equals: { actionId } } },
        }),
      ).toBe(1)
      expect(
        await refusal(() =>
          f.caller.projectRepo.confirmCiChange({ confirmToken: ready.confirmToken, mergeRequest }),
        ),
      ).toBe('REPO_CONFIRM_USED')
    })

    it('refuses a diff that is not the one core kept, a declined one, and another project', async () => {
      const f = await fixture({ ciTouched: true })
      await linted(f)
      kept.set(repoCiDiffKey(f.task.id, f.head), Buffer.from(`${ciPatch}+more\n`))
      expect(await refusal(() => f.caller.projectRepo.prepareCiChange({ taskId: f.task.id }))).toBe(
        'REPO_CHANGED',
      )
      await linted(f)
      expect(await f.caller.projectRepo.declineCiChange({ taskId: f.task.id })).toEqual({
        declined: true,
      })
      expect(await f.caller.projectRepo.branch({ taskId: f.task.id })).toMatchObject({
        ciChange: 'declined',
      })
      expect(await refusal(() => f.caller.projectRepo.prepareCiChange({ taskId: f.task.id }))).toBe(
        'REPO_CI_DECLINED',
      )
      const stranger = callerOf(await person())
      expect(await refusal(() => stranger.projectRepo.declineCiChange({ taskId: f.task.id }))).toBe(
        'NOT_FOUND',
      )

      // `ci_config_path` on another project: nothing is sent, not even a branch without build paths.
      const foreign = { v: 1, configPath: null, foreign: true, includes: [] }
      const g = await fixture({ ciPaths: foreign })
      expect(await g.caller.projectRepo.branch({ taskId: g.task.id })).toMatchObject({
        ciChange: 'foreign',
      })
      expect(await refusal(() => g.caller.projectRepo.preparePush({ taskId: g.task.id }))).toBe(
        'REPO_CI_CONFIG_FOREIGN',
      )
      const h = await fixture({ ciTouched: true, ciPaths: foreign })
      expect(await refusal(() => h.caller.projectRepo.prepareCiChange({ taskId: h.task.id }))).toBe(
        'REPO_CI_CONFIG_FOREIGN',
      )
      // A branch without build settings has no such card.
      const plain = await fixture()
      expect(
        await refusal(() => plain.caller.projectRepo.prepareCiChange({ taskId: plain.task.id })),
      ).toBe('REPO_NOTHING_TO_PUSH')
    })
  })
})
