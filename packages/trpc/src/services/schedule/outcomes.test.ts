import { describe, expect, it } from 'vitest'

import { runStateOf, type RunChatState, type RunRow } from './outcomes.ts'

const started: RunRow = {
  status: 'started',
  reason: null,
  missedCount: 0,
  missedUntil: null,
  taskId: 'chat',
}

const chat = (patch: Partial<RunChatState> = {}): RunChatState => ({
  status: 'awaiting_user',
  deleted: false,
  answered: false,
  failed: false,
  stopped: null,
  ...patch,
})

describe('the state of a run of a scheduled task (docs/plan/82, Зп5)', () => {
  it('tells a run that did not start by its reason', () => {
    expect(runStateOf({ ...started, status: 'pending', taskId: null }, undefined)).toEqual({
      kind: 'pending',
    })
    expect(
      runStateOf({ ...started, status: 'refused', reason: 'no_credits', taskId: null }, undefined),
    ).toEqual({ kind: 'refused', reason: 'no_credits' })
    const until = new Date('2026-11-16T11:00:00Z')
    expect(
      runStateOf(
        { ...started, status: 'skipped', reason: 'missed', missedCount: 4, missedUntil: until },
        undefined,
      ),
    ).toEqual({ kind: 'skipped', reason: 'missed', missedCount: 4, missedUntil: until })
    // A row written before the end was kept says none; another reason never has one.
    expect(
      runStateOf({ ...started, status: 'skipped', reason: 'missed', missedCount: 4 }, undefined),
    ).toEqual({ kind: 'skipped', reason: 'missed', missedCount: 4, missedUntil: null })
    expect(
      runStateOf(
        { ...started, status: 'skipped', reason: 'previous_running', missedUntil: until },
        undefined,
      ),
    ).toEqual({ kind: 'skipped', reason: 'previous_running', missedCount: 0, missedUntil: null })
    // A reason this code does not know is told as a fault of the platform, never guessed.
    expect(
      runStateOf({ ...started, status: 'refused', reason: 'newer', taskId: null }, undefined),
    ).toEqual({ kind: 'refused', reason: 'platform' })
  })

  it('tells a run that started by the state of its chat, as the list of chats does', () => {
    // A status of a release no chat reaches any more is told as the nearest (Зп47).
    for (const status of ['queued', 'preparing', 'running', 'deploying', 'verifying'] as const)
      expect(runStateOf(started, chat({ status }))).toEqual({ kind: 'running' })
    expect(runStateOf(started, chat({ status: 'done' }))).toEqual({ kind: 'done' })
    for (const status of ['failed', 'rolled_back', 'cancelled'] as const)
      expect(runStateOf(started, chat({ status }))).toEqual({ kind: 'failed' })
    expect(runStateOf(started, chat({ answered: true }))).toEqual({ kind: 'done' })
    expect(runStateOf(started, chat())).toEqual({ kind: 'waiting' })
    expect(runStateOf(started, chat({ status: 'awaiting_approval' }))).toEqual({ kind: 'waiting' })
    expect(runStateOf(started, chat({ status: 'awaiting_approval', answered: true }))).toEqual({
      kind: 'done',
    })
    expect(runStateOf(started, chat({ failed: true }))).toEqual({ kind: 'failed' })
    expect(runStateOf(started, chat({ status: 'awaiting_approval', failed: true }))).toEqual({
      kind: 'failed',
    })
  })

  it('tells a chat that stopped at a limit before a failure of it', () => {
    expect(runStateOf(started, chat({ stopped: 'credits', failed: true }))).toEqual({
      kind: 'stopped',
      cause: 'credits',
    })
    expect(runStateOf(started, chat({ stopped: 'weekly_limit', failed: true }))).toEqual({
      kind: 'stopped',
      cause: 'weekly_limit',
    })
    expect(runStateOf(started, chat({ stopped: 'limit' }))).toEqual({
      kind: 'stopped',
      cause: null,
    })
  })

  it('says «Чат удалён» of a deleted chat, or one that is gone', () => {
    expect(runStateOf(started, chat({ deleted: true, answered: true }))).toEqual({
      kind: 'chat_deleted',
    })
    expect(runStateOf(started, undefined)).toEqual({ kind: 'chat_deleted' })
  })
})
