import { createHash, randomUUID } from 'node:crypto'

import { publishedContentHashMaterial, type PublishedContentState } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { memoryStorage, memoryTransit } from '@repo/snapshots/testing'
import {
  PreviewDbValueStorage,
  previewDbValueKey,
  type PreviewDbValueRef,
} from '@repo/site-content'

const stateOf = (title: string): PublishedContentState => {
  const fields = {
    version: 1 as const,
    objectRef: 'page:42',
    kind: 'page' as const,
    title,
    content: '<p>Текст</p>',
    excerpt: '',
  }
  return {
    ...fields,
    stateHash: createHash('sha256').update(publishedContentHashMaterial(fields)).digest('hex'),
  }
}

function fixture() {
  const memory = memoryStorage()
  const transit = memoryTransit()
  const ref: PreviewDbValueRef = {
    workspaceId: randomUUID(),
    taskId: randomUUID(),
    previewId: randomUUID(),
    callId: randomUUID(),
    side: 'after',
    objectRef: 'page:42',
  }
  return {
    memory,
    transit,
    ref,
    values: new PreviewDbValueStorage(memory.storage, transit.secrets),
  }
}

describe('values of the database plan of a dialog', () => {
  it('seals a state under the key of its write and opens it only for the same write', async () => {
    const { memory, transit, ref, values } = fixture()
    const state = stateOf('После')
    const value = await values.save(ref, state)
    expect(value.key).toBe(`tasks/${ref.taskId}/db/${ref.callId}/after.json`)
    expect(value.key).toBe(previewDbValueKey(ref))
    const stored = Buffer.from(memory.objects.get(value.key)!).toString('utf8')
    // Sealed with the data key of the workspace: no text of the object is stored in the clear.
    expect(stored).not.toContain('После')
    expect(stored).not.toContain('Текст')
    expect(await values.load(ref, value)).toEqual(state)
    for (const other of [
      { ...ref, side: 'before' as const },
      { ...ref, previewId: randomUUID() },
      { ...ref, workspaceId: randomUUID() },
    ])
      await expect(values.load(other, value)).rejects.toMatchObject({
        code: 'PREVIEW_DB_VALUE_INVALID',
      })
    await expect(values.load(ref, { ...value, sha256: 'f'.repeat(64) })).rejects.toMatchObject({
      code: 'PREVIEW_DB_VALUE_INVALID',
    })
    expect(transit.allZeroed()).toBe(true)
  })

  it('answers a repeated save with the stored value and refuses another state for its key', async () => {
    const { ref, values } = fixture()
    const value = await values.save(ref, stateOf('После'))
    expect(await values.save(ref, stateOf('После'))).toEqual(value)
    await expect(values.save(ref, stateOf('Другое'))).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses a state of another object and a state larger than a snapshot', async () => {
    const { ref, values } = fixture()
    await expect(
      values.save({ ...ref, objectRef: 'page:43' }, stateOf('После')),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const large = { ...stateOf('После'), content: 'ж'.repeat(17_000) }
    await expect(values.save(ref, large)).rejects.toBeDefined()
  })
})
