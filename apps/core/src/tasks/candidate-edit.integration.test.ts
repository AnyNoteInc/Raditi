import { createHash, randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { billingFixtures } from '@repo/billing/testing'
import {
  createPrismaClient,
  PostgresSiteLeaseStore,
  recordCandidate,
  type CandidateRecordInput,
  type PrismaClient,
} from '@repo/db'
import {
  siteFileEditKey,
  siteIdOf,
  type CandidateFacts,
  type SiteFileEdit,
  type TaskStatus,
} from '@repo/domain'
import { getSiteAdapter } from '@repo/site-adapters'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { sampleDriverId } from '../testing/ids.ts'
import type { CandidateBuilder, CandidateContext } from './candidate-builder.ts'
import { CandidateEdit } from './candidate-edit.ts'
import type { CandidateGit } from './candidate-git.ts'

// The client's edit of a file in «Терминал» of a chat (06.11.2026) on PostgreSQL, with stand-ins
// for git and the builder of candidates: the chat's own lease, the wait for its agent, the check
// of a file changed meanwhile, the rules of the site and the next revision with its rows.

const databaseUrl = process.env.DATABASE_URL
const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const MAIN = 'c'.repeat(40)
const EDITED = 'e'.repeat(40)
const PATH = 'wp-content/themes/kadence/style.css'
const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`
const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
const facts: CandidateFacts = {
  changeType: 'code',
  risk: 'low',
  addedFiles: 0,
  modifiedFiles: 1,
  deletedFiles: 0,
  mediaFiles: 0,
  dbObjects: 0,
  newFunctionality: false,
}
const record = (
  taskId: string,
  revision: number,
  base: string,
  head: string,
): CandidateRecordInput => ({
  taskId,
  revision,
  turnNo: 1,
  baseSha: base,
  baseTree: 'f'.repeat(40),
  baseVersion: null,
  headSha: head,
  files: [{ path: PATH, change: 'modified', sizeBytes: 9, executable: false }],
  media: [],
  dbPlan: [],
  dbPlanSha256: createHash('sha256').update('[]').digest('hex'),
  proposedBump: 'patch',
  proposedVersion: 'v0.0.1',
  facts,
  checks: ['php_lint', 'preview_smoke'],
  installed: null,
})
const oidOf = (text: string) => {
  const bytes = Buffer.from(text, 'utf8')
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}

describe.skipIf(!databaseUrl)('the edit of a file of a chat with PostgreSQL', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  let leases: PostgresSiteLeaseStore

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
    leases = new PostgresSiteLeaseStore(db)
  })
  afterEach(async () => {
    await db.gitRepository.deleteMany({ where: { owner: 'sites-edit-test' } })
    const tasks = await db.task.findMany({
      where: { site: { name: 'Billing verification' }, turnNo: 1 },
      select: { id: true },
    })
    await db.siteLease.deleteMany({ where: { siteId: { in: tasks.map((task) => task.id) } } })
    await fixtures.cleanup()
    vi.clearAllMocks()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  /** A chat after its first turn; with `candidate`, it waits with changes on `agent/<id>`. */
  async function chat(options: { candidate: boolean; status?: TaskStatus }) {
    const { userId } = await fixtures.user()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
    )
    const { taskId } = await fixtures.task(workspace.id, {
      status: options.status ?? (options.candidate ? 'awaiting_approval' : 'awaiting_user'),
      turnNo: 1,
    })
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
    await db.taskTurn.create({
      data: { taskId, turnNo: 1, status: 'completed', driverId: sampleDriverId, image },
    })
    await db.gitRepository.create({
      data: {
        siteId: siteIdOf(task),
        provider: 'gitea',
        owner: 'sites-edit-test',
        name: `site-${task.siteId}`,
        url: `https://git.invalid/sites/site-${task.siteId}.git`,
      },
    })
    if (options.candidate)
      await db.$transaction((tx) => recordCandidate(tx, record(taskId, 1, BASE, HEAD)))
    return { taskId, siteId: siteIdOf(task) }
  }

  function setup(options: {
    branch?: string | null
    /** The ids of the file in each commit; absent — the file is not there. */
    files?: Record<string, string>
    edit?: Partial<SiteFileEdit>
    taskId: string
  }) {
    const editId = randomUUID()
    const edit: SiteFileEdit = {
      v: 1,
      taskId: options.taskId,
      path: PATH,
      baseSha: HEAD,
      text: 'body { color: red; }\n',
      savedAt: new Date().toISOString(),
      ...options.edit,
    }
    const objects = new Map([[siteFileEditKey(options.taskId, editId), JSON.stringify(edit)]])
    const inbox = {
      get: vi.fn(async (_bucket: string, key: string) => {
        const text = objects.get(key)
        return text === undefined
          ? null
          : (async function* () {
              yield Buffer.from(text)
            })()
      }),
      delete: vi.fn(async (_bucket: string, key: string) => {
        objects.delete(key)
      }),
    }
    const files = options.files ?? { [HEAD]: oidOf('body {}\n'), [MAIN]: oidOf('body {}\n') }
    const git = {
      readBranchHead: vi.fn(async ({ branch }: { branch: string }) =>
        branch === 'main' ? MAIN : options.branch === undefined ? HEAD : options.branch,
      ),
      treeOf: vi.fn(),
      comparesCommits: true,
      compareCommits: vi.fn(),
      rebaseCandidate: vi.fn(),
      rewindBranch: vi.fn(),
      holdUndoneCommit: vi.fn(),
      readFile: vi.fn(async ({ sha }: { sha: string }) =>
        files[sha] ? { oid: files[sha], size: 9, bytes: null } : null,
      ),
      commitFileEdit: vi.fn(async (_input: unknown, assertFence: () => Promise<void>) => {
        await assertFence()
        return { status: 'pushed' as const, sha: EDITED }
      }),
    }
    const candidates = {
      context: vi.fn(
        async (
          task: { id: string },
          standing: CandidateContext['standing'],
          revision: number,
          fallback?: string,
        ) => ({
          taskId: task.id,
          repo: { provider: 'gitea' as const, owner: 'sites-edit-test', name: 'site' },
          addOnlyPaths: [],
          base: standing?.baseSha ?? fallback ?? BASE,
          standing,
          installedVersion: null,
          releasedVersions: [],
          revision,
        }),
      ),
      build: vi.fn(
        async (context: CandidateContext, pass: { headSha: string; baseSha: string }) => ({
          kind: 'candidate' as const,
          record: record(context.taskId, context.revision, pass.baseSha, pass.headSha),
        }),
      ),
      carrier: vi.fn(),
    } as unknown as CandidateBuilder
    const queue = { enqueue: vi.fn(async () => {}) }
    const editor = new CandidateEdit({
      db,
      git: git as unknown as CandidateGit,
      candidates,
      leases,
      queue,
      inbox,
      adapter: getSiteAdapter,
      logger: quiet,
    })
    return { editor, git, queue, inbox, objects, job: { taskId: options.taskId, editId } }
  }

  const feedOf = async (taskId: string) =>
    (
      await db.taskEvent.findMany({
        where: { taskId, type: { startsWith: 'feed.' } },
        orderBy: { id: 'asc' },
      })
    ).map((row) => ({ type: row.type, payload: row.payload }))

  it('commits the file to the chat’s branch under its own lease and records the next revision', async () => {
    const dialog = await chat({ candidate: true })
    const { editor, git, objects, job } = setup({ taskId: dialog.taskId })

    expect(await editor.run(job)).toBe('saved')

    expect(git.commitFileEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: `agent/${dialog.taskId}`,
        parent: HEAD,
        expected: HEAD,
        path: PATH,
        content: Buffer.from('body { color: red; }\n'),
      }),
      expect.any(Function),
    )
    const candidates = await db.taskCandidate.findMany({
      where: { taskId: dialog.taskId },
      orderBy: { revision: 'asc' },
    })
    expect(candidates.map((row) => [row.revision, row.headSha, row.baseSha])).toEqual([
      [1, HEAD, BASE],
      [2, EDITED, BASE],
    ])
    const feed = await feedOf(dialog.taskId)
    expect(feed.map((row) => row.type)).toEqual(['feed.candidate', 'feed.edit'])
    expect(feed[1]!.payload).toEqual({
      v: 1,
      editId: job.editId,
      path: PATH,
      outcome: 'saved',
      revision: 2,
    })
    // The text leaves the inbox, and the chat's own row is free again.
    expect(objects.size).toBe(0)
    expect((await leases.inspect(dialog.taskId))?.taskId).toBeNull()
    // A job put twice answers once.
    expect(await editor.run(job)).toBe('nothing')
  })

  it('starts the changes of a chat without them on `main`, and the chat waits with them', async () => {
    const dialog = await chat({ candidate: false })
    const { editor, git, job } = setup({
      taskId: dialog.taskId,
      branch: null,
      edit: { baseSha: MAIN },
    })

    expect(await editor.run(job)).toBe('saved')

    expect(git.commitFileEdit).toHaveBeenCalledWith(
      expect.objectContaining({ parent: MAIN, expected: null }),
      expect.any(Function),
    )
    expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
      status: 'awaiting_approval',
    })
  })

  it('waits while the agent works, and gives the edit up once it waited too long', async () => {
    const dialog = await chat({ candidate: true, status: 'running' })
    const young = setup({ taskId: dialog.taskId })
    expect(await young.editor.run(young.job)).toBe('busy')
    expect(young.queue.enqueue).toHaveBeenCalledWith(
      'agent-turns',
      'candidate.edit',
      young.job,
      expect.objectContaining({ delayMs: 15_000 }),
    )
    expect(young.git.commitFileEdit).not.toHaveBeenCalled()

    const old = setup({
      taskId: dialog.taskId,
      edit: { savedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() },
    })
    expect(await old.editor.run(old.job)).toBe('failed')
    expect((await feedOf(dialog.taskId)).at(-1)?.payload).toMatchObject({ outcome: 'failed' })
  })

  it('writes nothing when the agent changed the file since the client opened it', async () => {
    const dialog = await chat({ candidate: true })
    const { editor, git, job } = setup({
      taskId: dialog.taskId,
      edit: { baseSha: BASE },
      files: { [BASE]: oidOf('body {}\n'), [HEAD]: oidOf('body { margin: 0 }\n') },
    })

    expect(await editor.run(job)).toBe('conflict')
    expect(git.commitFileEdit).not.toHaveBeenCalled()
    expect((await feedOf(dialog.taskId)).at(-1)?.payload).toMatchObject({
      outcome: 'conflict',
      revision: null,
    })
  })

  it('lets an edit of an older commit through when the file stayed as it was', async () => {
    const dialog = await chat({ candidate: true })
    const { editor, git, job } = setup({
      taskId: dialog.taskId,
      edit: { baseSha: BASE },
      files: { [BASE]: oidOf('body {}\n'), [HEAD]: oidOf('body {}\n') },
    })
    expect(await editor.run(job)).toBe('saved')
    expect(git.commitFileEdit).toHaveBeenCalledTimes(1)
  })

  it('refuses a file of the pipeline, as the changes of the agent are refused (rule 6)', async () => {
    const dialog = await chat({ candidate: true })
    const { editor, git, job } = setup({
      taskId: dialog.taskId,
      edit: { path: '.gitea/workflows/deploy.yml' },
    })
    expect(await editor.run(job)).toBe('refused')
    expect(git.commitFileEdit).not.toHaveBeenCalled()
  })

  it('records an edit a run pushed and could not record, without pushing it again', async () => {
    const dialog = await chat({ candidate: true })
    const text = 'body { color: red; }\n'
    const { editor, git, job } = setup({
      taskId: dialog.taskId,
      branch: EDITED,
      files: { [EDITED]: oidOf(text), [HEAD]: oidOf('body {}\n') },
      edit: { text },
    })
    expect(await editor.run(job)).toBe('saved')
    expect(git.commitFileEdit).not.toHaveBeenCalled()
    const latest = await db.taskCandidate.findFirst({
      where: { taskId: dialog.taskId },
      orderBy: { revision: 'desc' },
    })
    expect(latest?.headSha).toBe(EDITED)
  })
})
