// A session manager on the fakes of testing/fakes.ts, with a clock the test moves. Only for
// *.test.ts files (excluded from the build).
import { randomUUID } from 'node:crypto'

import type { BrowserAction } from '@repo/domain'
import { getSiteAdapter } from '@repo/site-adapters'

import { AttachmentFiles } from '../attachments/attachments.ts'
import {
  SessionManager,
  sessionTimingDefaults,
  type SessionManagerSettings,
} from '../sessions/session-manager.ts'
import { countingMetrics, FakeBrowsers, FakeInbox, FakeRuntime, FakeStore } from './fakes.ts'

export { TEST_SITE } from './fakes.ts'

export function sessionHarness(settings: Partial<SessionManagerSettings> = {}) {
  const store = new FakeStore()
  const runtime = new FakeRuntime()
  const browsers = new FakeBrowsers()
  const inbox = new FakeInbox()
  const { metrics, counts } = countingMetrics()
  /** Moved on by tests: the time the manager sees runs on with the real one. */
  const clock = { skew: 0 }
  const warnings: string[] = []
  const manager = new SessionManager({
    runtime,
    browsers,
    store,
    files: new AttachmentFiles(store, inbox),
    adapters: getSiteAdapter,
    metrics,
    now: () => Date.now() + clock.skew,
    warn: (event) => warnings.push(event),
    settings: {
      ...sessionTimingDefaults,
      agentActionTimeoutMs: 100,
      idleMinutes: 30,
      maxHours: 4,
      maxSessions: 4,
      extraHosts: [],
      localSites: [],
      stream: { maxFps: 30, quality: 70 },
      ...settings,
    },
  })
  /** A session core opened, ensured on the worker. */
  const ensured = async () => {
    const row = store.open()
    const state = await manager.ensure({
      sessionId: row.id,
      taskId: row.taskId,
      siteId: row.siteId,
      takeControl: true,
    })
    const session = manager.session(row.id)
    if (!session) throw new Error('not held')
    return { row, state, session, browser: browsers.last }
  }
  const act = (row: { id: string; taskId: string }, action: BrowserAction) =>
    manager.act(row.id, { taskId: row.taskId, assignmentId: randomUUID(), action })
  return {
    store,
    runtime,
    browsers,
    inbox,
    manager,
    clock,
    counts,
    metrics,
    warnings,
    ensured,
    act,
  }
}
