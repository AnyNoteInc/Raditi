import { createPrismaClient, type PrismaClient } from '@repo/db'
import { readFeedRow } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { diffStat, repoDiffKey, RepoChanges } from './repo-turns.ts'

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
    const puts: { key: string; bytes: Uint8Array }[] = []
    const storage = {
      put: vi.fn(async (_bucket: string, key: string, bytes: Uint8Array) => {
        puts.push({ key, bytes })
      }),
    }
    let changes: RepoChanges

    beforeAll(async () => {
      db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
      workspaceId = (
        await db.workspace.create({ data: { name: 'Synthetic repo', dataClass: 'synthetic' } })
      ).id
      changes = new RepoChanges({ db, storage: storage as never, logger: quiet })
    })
    afterAll(async () => {
      if (!db) return
      await db.taskEvent.deleteMany({ where: { task: { workspaceId } } })
      await db.taskTurn.deleteMany({ where: { task: { workspaceId } } })
      await db.task.deleteMany({ where: { workspaceId } })
      await db.workspace.delete({ where: { id: workspaceId } })
      await db.$disconnect()
    })

    const chatWithTurn = async () => {
      const task = await db.task.create({ data: { workspaceId }, select: { id: true } })
      const turn = await db.taskTurn.create({
        data: {
          taskId: task.id,
          turnNo: 1,
          driverId: 'opencode',
          image: `registry.invalid/raditi/opencode@sha256:${'a'.repeat(64)}`,
        },
        select: { id: true },
      })
      return { taskId: task.id, turnId: turn.id }
    }
    const rows = async (taskId: string) =>
      db.taskEvent.findMany({
        where: { taskId, type: { in: ['feed.repo_changes', 'feed.repo_left'] } },
        orderBy: { id: 'asc' },
        select: { type: true, payload: true, turnId: true, clientVisible: true },
      })

    it('tells the card of the branch once, keeps the diff and the commits of the turn', async () => {
      const { taskId, turnId } = await chatWithTurn()
      const outcome = { baseSha: base, headSha: head, patch, buildPaths: ['.gitlab-ci.yml'] }
      await changes.apply(taskId, 1, outcome, branch)
      await changes.apply(taskId, 1, outcome, branch)
      const told = await rows(taskId)
      expect(told).toHaveLength(1)
      expect(told[0]).toMatchObject({ type: 'feed.repo_changes', turnId, clientVisible: true })
      expect(told[0]!.payload).toMatchObject({
        v: 1,
        branch,
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
        branch,
      )
      expect((await rows(taskId)).map((row) => [row.type, row.payload])).toEqual([
        ['feed.repo_left', { v: 1, reason: 'secret_found' }],
      ])
    })

    it('tells nothing of a turn that changed nothing', async () => {
      const { taskId } = await chatWithTurn()
      await changes.apply(
        taskId,
        1,
        { baseSha: base, headSha: null, patch: new Uint8Array(), buildPaths: [] },
        branch,
      )
      expect(await rows(taskId)).toEqual([])
    })
  },
)
