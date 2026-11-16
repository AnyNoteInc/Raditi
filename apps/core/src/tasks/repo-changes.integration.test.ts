import { randomUUID } from 'node:crypto'

import { createPrismaClient, reserveRepoProposal, type PrismaClient } from '@repo/db'
import { readFeedRow } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { diffStat, repoDiffKey, RepoChanges, RepoTurnPreparer } from './repo-turns.ts'

// What a turn of a chat with a repository left, told at the end of its pass
// (docs/plan/84-projects.md, ПР12, ПР26, §4.3, step 8): the card «Изменения в ветке» with the
// counts of its diff, the diff kept in raditi-artifacts, `task_turns.base_sha`/`head_sha`; changes
// the checks refused told by `feed.repo_left`; once per turn. Rows of its own, removed at the end.

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const quiet = { log: vi.fn(), warn: vi.fn() }
const base = 'b'.repeat(40)
const head = 'c'.repeat(40)
const branch = 'raditi/chat-0193a1b2c3d4'
const plan = { projectRepositoryId: '', branch, mode: 'write' as const }

/** A UUID of version 7, as the browser makes the id of a project. */
function uuidv7(): string {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const patch = Buffer.from(
  [
    'diff --git a/index.js b/index.js',
    'index 1111111..2222222 100644',
    '--- a/index.js',
    '+++ b/index.js',
    '@@ -1 +1,2 @@',
    '-hello',
    '+hello, world',
    '+again',
    'diff --git a/.gitlab-ci.yml b/.gitlab-ci.yml',
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    '+++ b/.gitlab-ci.yml',
    '@@ -0,0 +1 @@',
    '+stages: [test]',
    '',
  ].join('\n'),
)

describe('diffStat', () => {
  it('counts the lines of each file of a patch, a removed line beginning with `---` too', () => {
    expect(diffStat(patch)).toEqual([
      { path: 'index.js', additions: 2, deletions: 1 },
      { path: '.gitlab-ci.yml', additions: 1, deletions: 0 },
    ])
    expect(diffStat(new Uint8Array())).toEqual([])
  })
})

describe.skipIf(!enabled)(
  'the changes of a repository told in the chat with PostgreSQL (plan 84, 84.18)',
  () => {
    let db: PrismaClient
    let workspaceId: string
    let userId: string
    let projectRepositoryId: string
    const puts: { key: string; bytes: Uint8Array }[] = []
    const storage = {
      put: vi.fn(async (_bucket: string, key: string, bytes: Uint8Array) => {
        puts.push({ key, bytes })
      }),
    }
    let changes: RepoChanges

    beforeAll(async () => {
      db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
      userId = (
        await db.user.create({ data: { name: 'Synthetic', email: `${randomUUID()}@example.test` } })
      ).id
      workspaceId = (
        await db.workspace.create({
          data: { name: 'Synthetic repo', dataClass: 'synthetic', createdById: userId },
        })
      ).id
      const project = await db.project.create({
        data: { id: uuidv7(), workspaceId, createdById: userId, name: 'Колос' },
      })
      projectRepositoryId = randomUUID()
      await db.projectRepository.create({
        data: {
          id: projectRepositoryId,
          projectId: project.id,
          workspaceId,
          provider: 'gitlab',
          host: 'gitlab.example.ru',
          path: 'kolos/site',
          webUrl: 'https://gitlab.example.ru/kolos/site',
          defaultBranch: 'main',
          mode: 'read',
          mirrorState: 'ready',
        },
      })
      plan.projectRepositoryId = projectRepositoryId
      changes = new RepoChanges({ db, storage: storage as never, logger: quiet })
    })
    afterAll(async () => {
      if (!db) return
      await db.taskEvent.deleteMany({ where: { task: { workspaceId } } })
      await db.taskTurn.deleteMany({ where: { task: { workspaceId } } })
      await db.task.deleteMany({ where: { workspaceId } })
      await db.projectRepository.deleteMany({ where: { workspaceId } })
      await db.project.deleteMany({ where: { workspaceId } })
      await db.workspace.delete({ where: { id: workspaceId } })
      await db.user.delete({ where: { id: userId } })
      await db.$disconnect()
    })

    const chatWithTurn = async () => {
      const task = await db.task.create({
        data: { workspaceId, title: 'Зимнее меню' },
        select: { id: true },
      })
      const turn = await db.taskTurn.create({
        data: {
          taskId: task.id,
          turnNo: 1,
          status: 'completed',
          driverId: 'opencode',
          image: `registry.invalid/raditi/opencode@sha256:${'a'.repeat(64)}`,
        },
        select: { id: true },
      })
      return { taskId: task.id, turnId: turn.id }
    }
    const rows = async (taskId: string) =>
      db.taskEvent.findMany({
        where: {
          taskId,
          type: { in: ['feed.repo_changes', 'feed.repo_left', 'feed.repo_proposal'] },
        },
        orderBy: { id: 'asc' },
        select: { type: true, payload: true, turnId: true, clientVisible: true },
      })

    it('tells the card of the branch once, keeps the diff and the commits of the turn', async () => {
      const { taskId, turnId } = await chatWithTurn()
      const outcome = { baseSha: base, headSha: head, patch, buildPaths: ['.gitlab-ci.yml'] }
      await changes.apply(taskId, 1, outcome, plan)
      await changes.apply(taskId, 1, outcome, plan)
      const told = await rows(taskId)
      expect(told).toHaveLength(1)
      expect(told[0]).toMatchObject({ type: 'feed.repo_changes', turnId, clientVisible: true })
      const own = await db.projectRepoBranch.findUniqueOrThrow({ where: { taskId } })
      // The branch of the chat: its row by the chat, its name by the chat's title (ПР13).
      expect(own).toMatchObject({
        projectRepositoryId,
        branch: `raditi/zimnee-menyu-${taskId.replaceAll('-', '').slice(-8)}`,
        baseSha: base,
        mirrorSha: null,
        remoteSha: null,
        state: 'local',
      })
      expect(told[0]!.payload).toMatchObject({
        v: 1,
        branch: own.branch,
        baseSha: base,
        headSha: head,
        files: 2,
        additions: 3,
        deletions: 1,
        ciTouched: true,
        pushed: false,
        mergeRequest: null,
        list: [
          { path: 'index.js', additions: 2, deletions: 1 },
          { path: '.gitlab-ci.yml', additions: 1, deletions: 0 },
        ],
      })
      expect(readFeedRow('feed.repo_changes', told[0]!.payload)).toMatchObject({
        type: 'feed.repo_changes',
        files: 2,
      })
      expect(puts.filter((put) => put.key === repoDiffKey(taskId, 1))).toHaveLength(1)
      expect(await db.taskTurn.findUnique({ where: { id: turnId } })).toMatchObject({
        baseSha: base,
        headSha: head,
      })
    })

    it('tells why changes were not kept, without a path or a value', async () => {
      const { taskId } = await chatWithTurn()
      await changes.apply(
        taskId,
        1,
        {
          baseSha: base,
          headSha: null,
          patch: new Uint8Array(),
          buildPaths: [],
          refusal: 'secret_found',
        },
        plan,
      )
      expect((await rows(taskId)).map((row) => [row.type, row.payload])).toEqual([
        ['feed.repo_left', { v: 1, reason: 'secret_found' }],
      ])
    })

    it('shows the proposal of a merge request after the card and never presses for the client', async () => {
      const { taskId } = await chatWithTurn()
      await reserveRepoProposal(db, {
        workspaceId,
        taskId,
        turnNo: 1,
        proposal: { title: 'Зимнее меню', description: 'Цены по прайсу', draft: false },
      })
      await changes.apply(taskId, 1, { baseSha: base, headSha: head, patch, buildPaths: [] }, plan)
      const told = await rows(taskId)
      expect(told.map((row) => row.type)).toEqual(['feed.repo_changes', 'feed.repo_proposal'])
      expect(told[1]!.payload).toMatchObject({ v: 1, title: 'Зимнее меню', draft: false })
      expect(await db.repoReservation.findMany({ where: { taskId } })).toMatchObject([
        { outcome: 'done', reason: 'shown' },
      ])
      // RepoChanges never writes a press (ПР13): every push is a button of the client.
      expect(await db.repoAction.count({ where: { taskId } })).toBe(0)
    })

    it('refuses a proposal of a read-only repository or with nothing to send', async () => {
      const { taskId } = await chatWithTurn()
      await reserveRepoProposal(db, {
        workspaceId,
        taskId,
        turnNo: 1,
        proposal: { title: 'Меню', description: '', draft: true },
      })
      await changes.apply(
        taskId,
        1,
        { baseSha: base, headSha: head, patch, buildPaths: [] },
        { ...plan, mode: 'read' },
      )
      expect((await rows(taskId)).map((row) => row.type)).toEqual(['feed.repo_changes'])
      expect(await db.repoReservation.findMany({ where: { taskId } })).toMatchObject([
        { outcome: 'refused', reason: 'nothing' },
      ])
    })

    it('follows /undo with the ref of the mirror, and starts from a branch sent (ПР25, ПР13)', async () => {
      const { taskId } = await chatWithTurn()
      const h1 = 'd'.repeat(40)
      const h2 = 'e'.repeat(40)
      const remote = 'f'.repeat(40)
      await db.taskTurn.update({
        where: { taskId_turnNo: { taskId, turnNo: 1 } },
        data: { headSha: h1, baseSha: base },
      })
      await db.taskTurn.create({
        data: {
          taskId,
          turnNo: 2,
          status: 'completed',
          driverId: 'opencode',
          image: `registry.invalid/raditi/opencode@sha256:${'a'.repeat(64)}`,
          headSha: h2,
          baseSha: h1,
          undoneAt: new Date(),
        },
      })
      let ref: string | null = h2
      const moves: [string | null, string | null][] = []
      const fetches: (string | null)[] = []
      const bundles: string[] = []
      const preparer = new RepoTurnPreparer({
        db,
        git: {
          fetchForTurn: async (_id: string, chatBranch: string | null = null) => {
            fetches.push(chatBranch)
            return { sha: base, label: 'GitLab', chatHead: chatBranch ? remote : null }
          },
        },
        workspace: {
          readChatRef: async () => ref,
          moveChatRef: async (
            _id: string,
            _chat: string,
            from: string | null,
            to: string | null,
          ) => {
            moves.push([from, to])
            if (from !== ref) return false
            ref = to
            return true
          },
          hiddenFiles: async () => [],
          buildBaseBundle: async (input: { baseSha: string; branch: string }) => {
            bundles.push(input.baseSha)
            return {
              sandboxBaseSha: '1'.repeat(40),
              sha256: '2'.repeat(64),
              sizeBytes: 10,
            } as never
          },
        },
      })
      const row = {
        projectId: randomUUID(),
        projectRepositoryId,
        provider: 'gitlab' as const,
        path: 'kolos/site',
        defaultBranch: 'main',
        mode: 'write' as const,
        secretsFound: [],
      }
      // The second turn was taken back: its commit leaves the ref, the next turn starts from h1.
      const undone = await preparer.prepare(taskId, row)
      expect(moves).toEqual([[h2, h1]])
      expect(undone).toMatchObject({ baseSha: h1, expectedRef: h1 })
      expect(undone.branch).toBe(`raditi/zimnee-menyu-${taskId.replaceAll('-', '').slice(-8)}`)
      // Sent with h1, and not changed in Радити since: the branch at the client is the base.
      await db.projectRepoBranch.create({
        data: {
          taskId,
          projectRepositoryId,
          branch: 'raditi/zimnee-menyu-sent',
          baseSha: base,
          mirrorSha: h1,
          remoteSha: h1,
          state: 'pushed',
        },
      })
      const sent = await preparer.prepare(taskId, row)
      expect(fetches.at(-1)).toBe('raditi/zimnee-menyu-sent')
      expect(sent).toMatchObject({ baseSha: remote, branch: 'raditi/zimnee-menyu-sent' })
      expect(bundles).toEqual([h1, remote])
    })

    it('tells nothing of a turn that changed nothing', async () => {
      const { taskId } = await chatWithTurn()
      await changes.apply(
        taskId,
        1,
        { baseSha: base, headSha: null, patch: new Uint8Array(), buildPaths: [] },
        plan,
      )
      expect(await rows(taskId)).toEqual([])
    })
  },
)
