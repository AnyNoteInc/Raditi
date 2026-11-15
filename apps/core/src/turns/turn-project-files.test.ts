import { Buffer } from 'node:buffer'

import { projectFileKey, turnProjectPath } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { TaskProjectFiles } from './turn-project-files.ts'

// The files of the project of a chat in its turn (docs/plan/84-projects.md, ПР8; slice 84.9): each
// path is checked again against the project the chat is in now, before a byte is read.

const taskId = '0199a3f2-0000-7000-8000-0000000000a1'
const workspaceId = '0199a3f2-0000-7000-8000-0000000000b1'
const id = '0199a3f2-0000-7000-8000-0000000000f1'
const brief = Buffer.from('%PDF-1.7 synthetic brief')

/** The task as chatProjectFile() reads it: its project and the file at the asked path. */
const taskRow = (
  change: { deleted?: boolean; file?: Record<string, unknown> | null; project?: boolean } = {},
) => ({
  project:
    change.project === false
      ? null
      : {
          deletedAt: change.deleted ? new Date() : null,
          files:
            change.file === null
              ? []
              : [
                  {
                    id,
                    workspaceId,
                    s3Key: projectFileKey(workspaceId, id),
                    sizeBytes: brief.byteLength,
                    name: 'Фото/Бриф.pdf',
                    ...change.file,
                  },
                ],
        },
})

function fixture(found: unknown = taskRow(), stored: Uint8Array | null = brief) {
  const findUnique = vi.fn(async (_query: unknown) => found)
  const get = vi.fn(async (_bucket: string, _key: string) =>
    stored === null
      ? null
      : (async function* () {
          yield stored
        })(),
  )
  const files = new TaskProjectFiles({ task: { findUnique } } as never, { get } as never)
  return { files, findUnique, get }
}

const read = async (body: AsyncIterable<Uint8Array>) => {
  const chunks: Uint8Array[] = []
  for await (const chunk of body) chunks.push(chunk)
  return Buffer.concat(chunks)
}

describe('TaskProjectFiles', () => {
  const path = turnProjectPath('Фото/Бриф.pdf')!

  it('gives a ready file of the chat’s project at its path, read only when taken', async () => {
    const f = fixture()
    const [file] = await f.files.files(taskId, [path])
    expect(file).toMatchObject({ path, sizeBytes: brief.byteLength })
    expect(f.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: taskId } }))
    const query = f.findUnique.mock.calls[0]![0] as {
      select: { project: { select: { files: { where: unknown } } } }
    }
    expect(query.select.project.select.files.where).toEqual({
      name: 'Фото/Бриф.pdf',
      status: 'ready',
    })
    expect(f.get).not.toHaveBeenCalled()
    expect(await read(file!.read())).toEqual(brief)
    expect(f.get).toHaveBeenCalledExactlyOnceWith('inbox', projectFileKey(workspaceId, id))
  })

  it.each([
    ['of a chat without a project now', taskRow({ project: false })],
    ['of a project in the trash', taskRow({ deleted: true })],
    ['not in the project', taskRow({ file: null })],
    ['stored under another key', taskRow({ file: { s3Key: `inbox/${workspaceId}/${id}` } })],
    ['larger than a file may be', taskRow({ file: { sizeBytes: 20 * 1024 * 1024 + 1 } })],
  ])('refuses a file %s, reading nothing', async (_label, found) => {
    const f = fixture(found)
    await expect(f.files.files(taskId, [path])).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'A file of the turn is not a file of the project of its chat',
    })
    expect(f.get).not.toHaveBeenCalled()
  })

  it('refuses a path outside the project without asking the database', async () => {
    const f = fixture()
    for (const other of ['/workspace/inbox/a.pdf', '/workspace/project/../a.pdf'])
      await expect(f.files.files(taskId, [other])).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.findUnique).not.toHaveBeenCalled()
  })

  it('fails the read of an object gone from the inbox', async () => {
    const f = fixture(taskRow(), null)
    const [file] = await f.files.files(taskId, [path])
    await expect(read(file!.read())).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
