import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { sweepOperations } from './stale-operations.ts'
import {
  assertSharedDirectory,
  BundleCache,
  KeyedLock,
  mirrorPath,
  operationsDir,
} from './mirror-store.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const sha = (n: number) => n.toString(16).padStart(40, '0')

describe('the volume of the mirrors', () => {
  it('keys a mirror by the repository of a project and refuses anything else', () => {
    const id = randomUUID()
    expect(mirrorPath('/git', id)).toBe(`/git/repos/${id}.git`)
    expect(() => mirrorPath('/git', '../x')).toThrow('Invalid repository id')
  })

  it('closes the root to other users', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'raditi-volume-')), 'git')
    roots.push(root)
    assertSharedDirectory(root)
    expect((await stat(root)).mode & 0o007).toBe(0)
  })

  it('serves a cached bundle only for the repository it was made for', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raditi-volume-'))
    roots.push(root)
    const cache = new BundleCache(root)
    const [a, b] = [randomUUID(), randomUUID()]
    await cache.put(a, sha(1), Buffer.from('bundle'))
    expect((await cache.get(a, sha(1)))?.toString()).toBe('bundle')
    expect(await cache.get(b, sha(1))).toBeNull()
    expect(await cache.get(a, 'not-a-sha')).toBeNull()
    await cache.forget(a)
    expect(await cache.get(a, sha(1))).toBeNull()
  })

  it('removes the operations a killed core left behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raditi-volume-'))
    roots.push(root)
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(join(operationsDir(root), 'abc'), { recursive: true }),
    )
    expect(await sweepOperations(root)).toBe(1)
    expect(await sweepOperations(root)).toBe(0)
  })
})

describe('KeyedLock', () => {
  it('runs one operation per key at a time, in order, past failures', async () => {
    const lock = new KeyedLock()
    const events: string[] = []
    const step =
      (name: string, fail = false) =>
      async () => {
        events.push(`${name}:start`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        events.push(`${name}:end`)
        if (fail) throw new Error(name)
        return name
      }
    const results = await Promise.allSettled([
      lock.run('a', step('a1', true)),
      lock.run('a', step('a2')),
    ])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled'])
    expect(events).toEqual(['a1:start', 'a1:end', 'a2:start', 'a2:end'])
  })
})
