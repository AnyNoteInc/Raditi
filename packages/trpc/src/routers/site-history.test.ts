import { randomUUID } from 'node:crypto'

import type { PrismaClient, User } from '@repo/db'
import { legalDocuments } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { createCaller } from '../router.ts'
import type { Context } from '../trpc.ts'

const now = new Date('2026-10-25T12:00:00Z')
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000)
const user: User = {
  id: randomUUID(),
  name: 'Анна',
  lastName: 'Иванова',
  email: 'site-history-test@example.ru',
  emailVerified: true,
  image: null,
  createdAt: now,
  updatedAt: now,
}
const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)
const siteId = randomUUID()
const [first, second, undo] = [randomUUID(), randomUUID(), randomUUID()]
const [taskA, taskB] = [randomUUID(), randomUUID()]

const release = (overrides: Record<string, unknown>) => ({
  kind: 'release',
  tag: 'v',
  step: null,
  mainPushedAt: at(1),
  undoesReleaseId: null,
  deployAttempt: 1,
  backupVerifiedAt: null,
  backupBytes: null,
  approver: { name: 'Анна', lastName: 'Иванова' },
  deployment: null,
  ...overrides,
})

/** The import, an installed release, one that was rolled back, and an undo of the first. */
const history = {
  id: siteId,
  installedReleaseId: undo,
  installedVersion: '0.1.1',
  installedAt: at(40),
  initialVersion: {
    tag: 'v0.0.0',
    importedAt: at(5),
    files: 8000,
    bytes: 400_000_000,
    backupObjectKey: null,
    backupBytes: null,
  },
  provisioningStages: [
    {
      status: 'succeeded',
      step: null,
      summary: { files: 8000, bytes: 400_000_000 },
      startedAt: at(0),
      finishedAt: at(5),
      createdAt: at(0),
    },
  ],
  releases: [
    release({
      id: first,
      taskId: taskA,
      version: '0.1.0',
      tag: 'v0.1.0',
      status: 'installed',
      approvedAt: at(10),
      updatedAt: at(12),
      backupVerifiedAt: at(11),
      backupBytes: 2048n,
      task: { title: 'Поменять цену капучино' },
      deployment: { finishedAt: at(12) },
    }),
    release({
      id: second,
      taskId: taskB,
      version: '0.2.0',
      tag: 'v0.2.0',
      status: 'rolled_back',
      approvedAt: at(20),
      updatedAt: at(23),
      task: { title: 'Баннер на главной' },
    }),
    release({
      id: undo,
      kind: 'undo',
      taskId: taskA,
      version: '0.1.1',
      tag: 'v0.1.1',
      status: 'installed',
      undoesReleaseId: first,
      approvedAt: at(30),
      updatedAt: at(40),
      task: { title: 'Поменять цену капучино' },
    }),
  ],
}

function setup() {
  const db = {
    userConsent: { findMany: vi.fn().mockResolvedValue(requiredConsents) },
    site: { findFirst: vi.fn<(args: unknown) => Promise<unknown>>().mockResolvedValue(history) },
    releaseStep: { findMany: vi.fn<(args: unknown) => Promise<unknown>>().mockResolvedValue([]) },
  }
  const context: Context = {
    prisma: db as unknown as PrismaClient,
    headers: new Headers(),
    user,
    session: {
      id: randomUUID(),
      userId: user.id,
      token: 'site-history-test-session',
      expiresAt: new Date('2030-01-01'),
      createdAt: now,
      updatedAt: now,
    },
    billing: null,
  }
  return { db, caller: createCaller(context) }
}

describe('siteHistory', () => {
  it('looks for the site among those of the user, and answers NOT_FOUND for another', async () => {
    const { db, caller } = setup()
    db.site.findFirst.mockResolvedValue(null)
    await expect(caller.siteHistory.runs({ siteId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(db.site.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: siteId, deletedAt: null, workspace: { members: { some: { userId: user.id } } } },
    })
  })

  it('numbers the runs from the import on and lists the newest first', async () => {
    const { caller } = setup()
    const runs = await caller.siteHistory.runs({ siteId })
    expect(runs.map(({ number, kind, state, version }) => [number, kind, state, version])).toEqual([
      [4, 'undo', 'installed', '0.1.1'],
      [3, 'release', 'rolled_back', '0.2.0'],
      [2, 'release', 'installed', '0.1.0'],
      [1, 'import', 'installed', 'v0.0.0'],
    ])
    expect(runs[2]).toMatchObject({
      title: 'Поменять цену капучино',
      approvedBy: 'Анна Иванова',
      finishedAt: at(12),
    })
  })

  it('gathers the reports of a release into steps and lines of its journal', async () => {
    const { db, caller } = setup()
    db.releaseStep.findMany.mockResolvedValue([
      { step: 'conflicts', state: 'started', createdAt: at(20) },
      { step: 'conflicts', state: 'succeeded', createdAt: at(20.1) },
      { step: 'verify', state: 'started', createdAt: at(21) },
      { step: 'verify', state: 'failed', createdAt: at(21.2) },
      { step: 'rollback', state: 'started', createdAt: at(22) },
      { step: 'rollback', state: 'succeeded', createdAt: at(22.5) },
      // A step the platform does not know is never shown.
      { step: 'shell', state: 'started', createdAt: at(22.6) },
    ])
    const run = await caller.siteHistory.run({ siteId, runId: second })
    expect(db.releaseStep.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { releaseId: second, deployAttempt: 1 },
    })
    expect(run.steps.map(({ step, state }) => `${step}:${state}`)).toEqual([
      'conflicts:succeeded',
      'verify:failed',
      'rollback:succeeded',
    ])
    expect(run.steps[1]).toMatchObject({ startedAt: at(21), finishedAt: at(21.2) })
    expect(run.lines).toHaveLength(6)
  })

  it('tells the import as its own run, with the files it saved', async () => {
    const { caller } = setup()
    const run = await caller.siteHistory.run({ siteId, runId: 'import' })
    expect(run.steps).toEqual([
      { step: 'import', state: 'succeeded', startedAt: at(0), finishedAt: at(5) },
    ])
    expect(run.lines.map((line) => line.event)).toEqual(['started', 'files', 'succeeded'])
    expect(run.lines[1]).toMatchObject({ files: 8000, bytes: 400_000_000 })
  })

  it('answers NOT_FOUND for a run that is not of the site', async () => {
    const { caller } = setup()
    await expect(caller.siteHistory.run({ siteId, runId: randomUUID() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('lists the installed versions, marks the one on the site and the undone one', async () => {
    const { caller } = setup()
    const versions = await caller.siteHistory.versions({ siteId })
    expect(
      versions.map(({ id, current, undone, undoes }) => [id, current, undone, undoes]),
    ).toEqual([
      [undo, true, false, '0.1.0'],
      [first, false, true, null],
      ['initial', false, false, null],
    ])
    expect(versions[1]).toMatchObject({ run: 2, backupAt: at(11), installedAt: at(12) })
  })

  it('takes the version of the import for the one on the site before any release', async () => {
    const { db, caller } = setup()
    db.site.findFirst.mockResolvedValue({ ...history, installedReleaseId: null, releases: [] })
    const versions = await caller.siteHistory.versions({ siteId })
    expect(versions).toEqual([expect.objectContaining({ id: 'initial', current: true, run: 1 })])
  })

  it('lists the copies the platform made, the newest first', async () => {
    const { caller } = setup()
    expect(await caller.siteHistory.backups({ siteId })).toEqual([
      { id: first, kind: 'release', at: at(11), bytes: 2048, version: '0.1.0', download: 'none' },
      {
        id: 'initial',
        kind: 'initial',
        at: at(5),
        bytes: 400_000_000,
        version: 'v0.0.0',
        download: 'pending',
      },
    ])
  })

  it('offers the copy of the import once core put it in the bucket, with its own size', async () => {
    const { db, caller } = setup()
    db.site.findFirst.mockResolvedValue({
      ...history,
      releases: [],
      initialVersion: {
        ...history.initialVersion,
        backupObjectKey: `sites/${siteId}/initial/${'a'.repeat(40)}.tar.gz`,
        backupBytes: 123_456n,
      },
    })
    expect(await caller.siteHistory.backups({ siteId })).toEqual([
      {
        id: 'initial',
        kind: 'initial',
        at: at(5),
        bytes: 123_456,
        version: 'v0.0.0',
        download: 'ready',
      },
    ])
  })

  it('names where the files and the database are, never an address', async () => {
    const { db, caller } = setup()
    db.site.findFirst.mockResolvedValue({
      codeSource: { kind: 'ftp', tls: 'unverified' },
      database: null,
    })
    expect(await caller.siteHistory.connections({ siteId })).toEqual({
      source: { kind: 'ftp', tls: 'unverified' },
      database: null,
    })
    expect(db.site.findFirst.mock.calls[0]?.[0]).toMatchObject({
      select: { codeSource: { select: { kind: true, tls: true } } },
    })
  })
})
