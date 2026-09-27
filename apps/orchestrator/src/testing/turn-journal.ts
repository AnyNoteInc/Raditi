// In-memory turn journal for *.test.ts files with the fence rule of TaskEventTurnJournal: an
// entry is kept only while its fence owns the site (failed and recovery entries also after
// expiry or a hold), and replay reads a turn over an epoch range in the order written.
import { leaseLost, turnEvidenceSchema, type TurnEvidence, type TurnJournal } from '@repo/domain'

import type { JournaledEvidence, TurnJournalRange } from '../turns/turn-journal.ts'
import type { MemorySiteLeases } from './site-leases.ts'

export class MemoryTurnJournal implements TurnJournal {
  readonly entries: JournaledEvidence[] = []
  /** Runs after an entry was kept, before record() resolves. */
  onRecord: ((entry: JournaledEvidence) => void) | undefined

  constructor(private readonly leases: MemorySiteLeases) {}

  async record(input: TurnEvidence): Promise<void> {
    const entry = turnEvidenceSchema.parse(input)
    const { fence } = entry
    const row = this.leases.rows.get(fence.siteId)
    const ending = entry.phase === 'failed' || entry.phase === 'recovery'
    if (
      !row ||
      row.taskId !== fence.taskId ||
      row.epoch !== fence.epoch ||
      row.operation !== fence.operation ||
      (!ending && (row.held || row.expiresAt! <= Date.now()))
    )
      throw leaseLost('Turn evidence no longer owns its site lease')
    this.entries.push(structuredClone(entry))
    this.onRecord?.(entry)
  }

  async replay(range: TurnJournalRange): Promise<JournaledEvidence[]> {
    return this.entries
      .filter(
        (entry) =>
          entry.fence.siteId === range.siteId &&
          entry.fence.taskId === range.taskId &&
          entry.sessionId === range.sessionId &&
          entry.turn === range.turn &&
          entry.fence.epoch >= range.fromEpoch &&
          entry.fence.epoch <= range.toEpoch,
      )
      .map((entry) => structuredClone(entry))
  }

  phases(epoch?: number): string[] {
    return this.entries
      .filter((entry) => epoch === undefined || entry.fence.epoch === epoch)
      .map((entry) => entry.phase)
  }
}
