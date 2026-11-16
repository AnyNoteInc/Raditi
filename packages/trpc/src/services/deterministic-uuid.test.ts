import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { deterministicUuidV7 } from './deterministic-uuid.ts'
import { updateUuid } from './telegram/intake.ts'

const v7 = z.uuid({ version: 'v7' })

describe('deterministicUuidV7', () => {
  it('gives the same id for the same thing, another for another', () => {
    const at = new Date(Date.UTC(2026, 10, 16, 9, 0))
    const id = deterministicUuidV7('schedule', 'run-1', at)
    expect(deterministicUuidV7('schedule', 'run-1', at)).toBe(id)
    expect(deterministicUuidV7('schedule', 'run-2', at)).not.toBe(id)
    expect(deterministicUuidV7('telegram', 'run-1', at)).not.toBe(id)
    expect(deterministicUuidV7('schedule', 'run-1', new Date(at.getTime() + 1))).not.toBe(id)
  })

  it('is a UUID of version 7 with the moment in its first 48 bits', () => {
    const at = new Date(Date.UTC(2026, 10, 16, 9, 0))
    const id = deterministicUuidV7('schedule', 'run-1', at)
    expect(v7.safeParse(id).success).toBe(true)
    expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(at.getTime())
    // A moment out of the 48 bits is clamped, never wrapped into another one.
    expect(deterministicUuidV7('schedule', 'x', new Date(-5)).slice(0, 13)).toBe('00000000-0000')
    expect(v7.safeParse(deterministicUuidV7('schedule', 'x', new Date(2 ** 50))).success).toBe(true)
  })

  it('keeps the ids of Telegram exactly as they were before it was shared', () => {
    // Frozen from the former `updateUuid` of services/telegram/intake.ts: a chat an update made
    // must be found again by the id the update gives.
    expect(updateUuid('task:7', new Date(1_700_000_000_000))).toBe(
      '018bcfe5-6800-7057-95fd-ece1ba695947',
    )
    expect(updateUuid('request:12345', new Date(Date.UTC(2026, 10, 15, 9, 0)))).toBe(
      '01a1de6f-5280-73a9-8373-70a274986ba4',
    )
    expect(updateUuid('press:99', new Date(Date.UTC(2026, 10, 1)))).toBe(
      '01a19467-e800-75c9-9c9e-ac993beee87d',
    )
  })
})
