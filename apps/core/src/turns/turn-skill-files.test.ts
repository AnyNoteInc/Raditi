import type { PrismaClient } from '@repo/db'
import type { ObjectStorage } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { TaskSkillFiles } from './turn-skill-files.ts'

const TASK = '0199a3f2-0000-7000-8000-00000000000a'
const USER = '0199a3f2-0000-7000-8000-00000000000b'
const VERSION = '0199a3f2-0000-7000-8000-00000000000c'

function fixture(rows: unknown[] = [], author: string | null = USER) {
  const db = {
    task: { findUnique: vi.fn(async () => (author === null ? null : { createdById: author })) },
    accountSkill: { findMany: vi.fn(async () => rows) },
  } as unknown as Pick<PrismaClient, 'task' | 'accountSkill'>
  const objects = new Map<string, Uint8Array>([
    [`skills/${USER}/${VERSION}/0`, new TextEncoder().encode('---\nname: demo\n---')],
    [`skills/${USER}/${VERSION}/1`, new TextEncoder().encode('print(1)')],
  ])
  const storage = {
    get: vi.fn(async (_bucket: string, key: string) => {
      const bytes = objects.get(key)
      return bytes
        ? (async function* () {
            yield bytes
          })()
        : null
    }),
  } as unknown as Pick<ObjectStorage, 'get'>
  return { db, storage, skillFiles: new TaskSkillFiles(db, storage) }
}

const demo = {
  name: 'demo',
  version: {
    id: VERSION,
    files: [
      { path: 'SKILL.md', sizeBytes: 19, executable: false },
      { path: 'scripts/run.py', sizeBytes: 8, executable: true },
    ],
  },
}

const read = async (iterable: AsyncIterable<Uint8Array>) => {
  const chunks: Uint8Array[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return new TextDecoder().decode(Buffer.concat(chunks))
}

describe('the files of the skills of a turn (docs/plan/97-skills.md, Нв13)', () => {
  it('reads each file of an enabled skill of the author of the chat by its place', async () => {
    const f = fixture([demo])
    const files = await f.skillFiles.files(TASK, [
      '/workspace/skills/demo/SKILL.md',
      '/workspace/skills/demo/scripts/run.py',
    ])
    expect(
      files.map(({ path, sizeBytes, executable }) => ({ path, sizeBytes, executable })),
    ).toEqual([
      { path: '/workspace/skills/demo/SKILL.md', sizeBytes: 19, executable: false },
      { path: '/workspace/skills/demo/scripts/run.py', sizeBytes: 8, executable: true },
    ])
    expect(await read(files[1]!.read())).toBe('print(1)')
    // One look at the database for the whole turn.
    expect(vi.mocked(f.db.accountSkill.findMany)).toHaveBeenCalledTimes(1)
  })

  it('leaves out what the client turned off or changed since the plan, a skill whole', async () => {
    const f = fixture([demo])
    const files = await f.skillFiles.files(TASK, [
      '/workspace/skills/demo/old.md',
      '/workspace/skills/gone/SKILL.md',
    ])
    expect(files).toEqual([])
    // The plan named one file of a version of two: no file of two versions reaches the turn.
    expect(await f.skillFiles.files(TASK, ['/workspace/skills/demo/SKILL.md'])).toEqual([])
    expect(
      await fixture([demo], null).skillFiles.files(TASK, ['/workspace/skills/demo/SKILL.md']),
    ).toEqual([])
  })

  it('refuses a path that was never a file of a skill', async () => {
    const f = fixture([demo])
    await expect(f.skillFiles.files(TASK, ['/workspace/project/SKILL.md'])).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('fails the read of a file missing from the inbox', async () => {
    const f = fixture([
      {
        ...demo,
        version: {
          ...demo.version,
          files: [...demo.version.files, { path: 'x', sizeBytes: 1, executable: false }],
        },
      },
    ])
    const files = await f.skillFiles.files(TASK, [
      '/workspace/skills/demo/SKILL.md',
      '/workspace/skills/demo/scripts/run.py',
      '/workspace/skills/demo/x',
    ])
    const file = files.at(-1)
    await expect(read(file!.read())).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
