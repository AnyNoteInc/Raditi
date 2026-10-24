import { describe, expect, it, vi } from 'vitest'

import { collectExpiredAttachments, type ExpiredAttachmentStore } from './attachment-collector.ts'

// docs/plan/57-browser-tasks.md, Б26: files nobody sent leave raditi-inbox, then the database.
describe('collectExpiredAttachments', () => {
  const file = (n: number) => ({
    id: `0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a9${n}`,
    key: `inbox/ws/0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a9${n}`,
  })

  /** Expired files in memory; `steps` records the order of the removals. */
  function store(files: Array<{ id: string; key: string }>) {
    const steps: string[] = []
    const rows = new Map(files.map((one) => [one.id, 'ready']))
    const fake: ExpiredAttachmentStore = {
      list: vi.fn(async (limit: number) =>
        files.filter((one) => rows.get(one.id) === 'ready').slice(0, limit),
      ),
      markDeleted: vi.fn(async (id: string) => {
        steps.push(`row ${id}`)
        if (rows.get(id) !== 'ready') return false
        rows.set(id, 'deleted')
        return true
      }),
    }
    return { fake, rows, steps }
  }

  it('deletes the object before the row, a batch at a time', async () => {
    const files = [file(1), file(2), file(3)]
    const { fake, rows, steps } = store(files)
    const storage = {
      delete: vi.fn(async (bucket: string, key: string) => {
        steps.push(`object ${bucket} ${key}`)
      }),
    }

    expect(await collectExpiredAttachments({ files: fake, storage, limit: 2 })).toBe(2)
    expect(fake.list).toHaveBeenCalledWith(2)
    expect(steps).toEqual([
      `object inbox ${files[0]!.key}`,
      `row ${files[0]!.id}`,
      `object inbox ${files[1]!.key}`,
      `row ${files[1]!.id}`,
    ])
    expect(await collectExpiredAttachments({ files: fake, storage, limit: 2 })).toBe(1)
    expect([...rows.values()]).toEqual(['deleted', 'deleted', 'deleted'])
    expect(await collectExpiredAttachments({ files: fake, storage, limit: 2 })).toBe(0)
  })

  it('keeps the row of an object it could not delete for the next call, and goes on', async () => {
    const files = [file(1), file(2)]
    const { fake, rows } = store(files)
    const refused = new Error('S3 is down')
    const storage = {
      delete: vi.fn(async (_bucket: string, key: string) => {
        if (key === files[0]!.key) throw refused
      }),
    }
    const onFailure = vi.fn()

    expect(await collectExpiredAttachments({ files: fake, storage, limit: 10, onFailure })).toBe(1)
    expect(onFailure).toHaveBeenCalledWith(files[0]!.id, refused)
    expect(fake.markDeleted).not.toHaveBeenCalledWith(files[0]!.id)
    expect(rows.get(files[0]!.id)).toBe('ready')
    expect(rows.get(files[1]!.id)).toBe('deleted')

    storage.delete.mockResolvedValue(undefined)
    expect(await collectExpiredAttachments({ files: fake, storage, limit: 10, onFailure })).toBe(1)
    expect(rows.get(files[0]!.id)).toBe('deleted')
  })

  it('counts only the rows it marked: another collector may have taken one first', async () => {
    const files = [file(1)]
    const { fake } = store(files)
    vi.mocked(fake.markDeleted).mockResolvedValueOnce(false)
    const storage = { delete: vi.fn(async () => {}) }
    expect(await collectExpiredAttachments({ files: fake, storage, limit: 10 })).toBe(0)
    expect(storage.delete).toHaveBeenCalledTimes(1)
  })
})
