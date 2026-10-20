import { randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { billingFixtures } from '@repo/billing/testing'
import { createPrismaClient, insertFeedEvent, type PrismaClient } from '@repo/db'
import { llmBackends } from '@repo/llm-backends'
import { getSiteAdapter } from '@repo/site-adapters'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { sampleDriverId } from '../testing/ids.ts'
import { readPassFacts } from './pass-facts.ts'

// What a pass reads of the client's variables of its site (docs/plan/53-chat-preview-release.md,
// Р13): the hosts the agent's commands may reach, never a value; and of the turns of its task.
// Reads only: any database.
const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('the egress of a pass with PostgreSQL', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(async () => {
    await fixtures.cleanup()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function dialog() {
    const { userId } = await fixtures.user()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
    )
    const { taskId } = await fixtures.task(workspace.id, { status: 'queued' })
    // No reserve to read: the class ceiling stands for the budget.
    const task = await db.task.update({ where: { id: taskId }, data: { billable: false } })
    const requestEventId = await insertFeedEvent(db, {
      taskId,
      row: {
        type: 'feed.request',
        payload: {
          v: 1,
          kind: 'first',
          authorId: userId,
          requestId: randomUUID(),
          text: 'Подключите оплату',
        },
      },
    })
    const facts = () =>
      readPassFacts(
        { db, adapter: getSiteAdapter, backends: llmBackends, previews: null },
        {
          taskId,
          attempt: 1,
          turnNo: 0,
          requestEventId: String(requestEventId),
          now: new Date(),
        },
      )
    return { task, workspaceId: workspace.id, facts }
  }

  it('takes the hosts of the variables the agent gets, each once, and none for client data', async () => {
    const { task, workspaceId, facts } = await dialog()
    const consented = { toAgent: true, agentConsentAt: new Date() }
    await db.siteEnvVar.createMany({
      data: [
        {
          siteId: task.siteId,
          name: 'PAYMENT_KEY',
          hosts: ['pay.example.ru:443', 'api.example.ru:443'],
          ...consented,
        },
        { siteId: task.siteId, name: 'HOOK_TOKEN', hosts: ['api.example.ru:443'], ...consented },
        // The preview's alone: the agent never reaches its host.
        { siteId: task.siteId, name: 'PREVIEW_ONLY', hosts: ['preview.example.ru:443'] },
      ],
    })
    const read = await facts()
    expect(read?.egress).toEqual(['api.example.ru:443', 'pay.example.ru:443'])
    expect(read?.variables).toEqual(['HOOK_TOKEN', 'PAYMENT_KEY'])
    // What the agent is told of the database is the adapter's word for the site's stack.
    expect(read?.databaseGuide).toContain('/wp/v2/pages')
    // Until the gate of 152-FZ nothing of a workspace of client data reaches the agent.
    await db.workspace.update({ where: { id: workspaceId }, data: { dataClass: 'client' } })
    const closed = await facts()
    expect(closed?.egress).toEqual([])
    expect(closed?.variables).toEqual([])
  })

  // docs/plan/53, «Попробовать ещё (18.10)»: a turn whose pass ended in a failure is replaced.
  it('reads which turns the platform refused, and still the head they wrote', async () => {
    const { task, facts } = await dialog()
    const turn = (turnNo: number, headSha: string, rejectedAt: Date | null) => ({
      taskId: task.id,
      turnNo,
      status: 'completed' as const,
      driverId: sampleDriverId,
      image: `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`,
      headSha,
      rejectedAt,
    })
    await db.taskTurn.createMany({
      data: [turn(1, 'b'.repeat(40), null), turn(2, 'd'.repeat(40), new Date())],
    })
    const read = await facts()
    expect([read?.turns.get(1)?.rejected, read?.turns.get(2)?.rejected]).toEqual([false, true])
    // The branch holds what the refused turn published: the next push is leased on it.
    expect(read?.writtenHead).toBe('d'.repeat(40))
  })
})
