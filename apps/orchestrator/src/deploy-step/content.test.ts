import type { DbContentUpdate } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { dbOperationValue, sealDbOperationValue } from '../releases/release-db-values.ts'
import { contentState, MemoryContentGateway } from '../testing/deploy-step.ts'
import {
  CONTENT_WRITE_WINDOW_MS,
  contentCallId,
  fieldsOf,
  openOperationValue,
  stateHashWith,
  writeExact,
  type ExactWrite,
} from './content.ts'
import { sealDeployEnvelope } from './envelope.ts'

const releaseId = '0196abcd-0000-7000-8000-00000000000a'
const siteId = '0196abcd-0000-7000-8000-0000000000aa'
const key = Buffer.alloc(32, 7)
const before = contentState('post:7', { title: 'Акция', content: '<p>Скидка 10%</p>' })
const after = contentState('post:7', {
  title: 'Акция',
  content: '<p>Скидка 20%</p>',
  excerpt: 'Кратко',
})
const operation: DbContentUpdate = {
  kind: 'content_update',
  objectRef: 'post:7',
  fields: ['content', 'excerpt'],
  beforeHash: before.stateHash,
  afterHash: after.stateHash,
  before: { key: 'tasks/t/db/c/before.json', sha256: 'a'.repeat(64), sizeBytes: 10 },
  after: { key: 'tasks/t/db/c/after.json', sha256: 'b'.repeat(64), sizeBytes: 10 },
}

describe('the value of a database operation', () => {
  it('opens what core sealed for this release: exactly the fields of the operation', () => {
    const sealed = sealDbOperationValue({ after, before: null }, operation, releaseId, key)
    const { fields } = openOperationValue(sealed, key, releaseId, operation)
    expect(fields).toEqual({ content: '<p>Скидка 20%</p>', excerpt: 'Кратко' })
    expect(stateHashWith(before, fields)).toBe(operation.afterHash)
  })

  it('does not open for another release, object, state or key', () => {
    const sealed = sealDbOperationValue({ after, before: null }, operation, releaseId, key)
    expect(() =>
      openOperationValue(sealed, key, '0196abcd-0000-7000-8000-00000000000b', operation),
    ).toThrow()
    expect(() =>
      openOperationValue(sealed, key, releaseId, { ...operation, objectRef: 'post:8' }),
    ).toThrow()
    expect(() =>
      openOperationValue(sealed, key, releaseId, { ...operation, afterHash: 'f'.repeat(64) }),
    ).toThrow()
    expect(() => openOperationValue(sealed, Buffer.alloc(32, 8), releaseId, operation)).toThrow()
  })

  it('refuses a value with other fields than the operation names', () => {
    const aad = `raditi-release-value-v1|${releaseId}|post:7|${operation.afterHash}`
    for (const fields of [{ content: 'x' }, { content: 'x', excerpt: 'y', title: 'z' }]) {
      const sealed = sealDeployEnvelope(Buffer.from(JSON.stringify({ v: 1, fields })), key, aad)
      expect(() => openOperationValue(sealed, key, releaseId, operation)).toThrow(
        'Invalid value of a database operation',
      )
    }
    // What core puts in: the fields in the order of the plan.
    expect(JSON.parse(dbOperationValue({ after, before: null }, operation).toString())).toEqual({
      v: 1,
      fields: { content: '<p>Скидка 20%</p>', excerpt: 'Кратко' },
    })
  })

  it('names the fields of an operation as a state holds them: what the inverse writes back', () => {
    expect(fieldsOf(before, operation)).toEqual({ content: '<p>Скидка 10%</p>', excerpt: '' })
  })
})

describe('the call id of a write', () => {
  it('is the same for a repeat of the same write and a UUID of version 8', () => {
    const id = contentCallId(releaseId, 1, 'post:7', 'apply')
    expect(id).toBe(contentCallId(releaseId.toUpperCase(), 1, 'post:7', 'apply'))
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const others = [
      contentCallId(releaseId, 1, 'post:7', 'undo'),
      contentCallId(releaseId, 2, 'post:7', 'apply'),
      contentCallId(releaseId, 1, 'post:8', 'apply'),
    ]
    expect(new Set([id, ...others]).size).toBe(4)
  })
})

describe('a write of exact bytes', () => {
  const write: ExactWrite = {
    releaseId,
    deployAttempt: 1,
    siteId,
    epoch: 3,
    objectRef: 'post:7',
    direction: 'apply',
    expectedStateHash: before.stateHash,
    fields: { content: '<p>Скидка 20%</p>', excerpt: 'Кратко' },
  }
  const clock = () => {
    let now = 1_800_000_000_000
    return {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms
      },
    }
  }

  it('commits under its precondition in the mode `release` and returns the receipt’s state', async () => {
    const gateway = new MemoryContentGateway(siteId, [before])
    const result = await writeExact(gateway, write, clock())
    expect(result).toEqual({ kind: 'committed', stateHash: after.stateHash })
    expect(gateway.log).toEqual(['release post:7'])
    // Its inverse puts back the exact bytes the site held: the mode `restore`.
    const undo = new MemoryContentGateway(siteId, [after])
    await writeExact(
      undo,
      {
        ...write,
        direction: 'undo',
        expectedStateHash: after.stateHash,
        fields: { content: before.content, excerpt: before.excerpt },
      },
      clock(),
    )
    expect(undo.log).toEqual(['restore post:7'])
  })

  it('is refused when the record is not at its base or the fence moved past it', async () => {
    const gateway = new MemoryContentGateway(siteId, [after])
    expect(await writeExact(gateway, write, clock())).toEqual({ kind: 'refused', code: 'conflict' })
    const fenced = new MemoryContentGateway(siteId, [before])
    fenced.epoch = 4
    expect(await writeExact(fenced, write, clock())).toEqual({ kind: 'refused', code: 'fenced' })
  })

  it('asks again with the same identity after a lost answer and gets the receipt', async () => {
    const gateway = new MemoryContentGateway(siteId, [before])
    gateway.loseAnswers = 2
    expect(await writeExact(gateway, write, clock())).toEqual({
      kind: 'committed',
      stateHash: after.stateHash,
    })
    expect(gateway.log).toEqual(['release post:7'])
  })

  it('waits out the deadline and reconciles: a proof either way, or unknown', async () => {
    const committed = new MemoryContentGateway(siteId, [before])
    committed.loseAnswers = 3
    const time = clock()
    const start = time.now()
    expect(await writeExact(committed, write, time)).toEqual({
      kind: 'committed',
      stateHash: after.stateHash,
    })
    expect(time.now() - start).toBeGreaterThan(CONTENT_WRITE_WINDOW_MS)

    const never = new MemoryContentGateway(siteId, [before])
    never.failWrites = 3
    expect(await writeExact(never, write, clock())).toEqual({
      kind: 'refused',
      code: 'unavailable',
    })

    const silent = new MemoryContentGateway(siteId, [before])
    silent.failWrites = 3
    silent.reconcileOperation = async () => {
      throw new Error('no answer')
    }
    expect(await writeExact(silent, write, clock())).toEqual({ kind: 'unknown' })
  })
})
