import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

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
    const source = join(root, 'built.bundle')
    await writeFile(source, 'bundle')
    const stored = await cache.put(a, sha(1), source)
    expect(stored).toMatchObject({ sha256: sha256('bundle'), sizeBytes: 6 })
    const cached = await cache.get(a, sha(1))
    expect(cached?.header.toString()).toBe('bundle')
    expect(await readFile(cached!.path, 'utf8')).toBe('bundle')
    expect(await cache.get(b, sha(1))).toBeNull()
    expect(await cache.get(a, 'not-a-sha')).toBeNull()
    await cache.forget(a)
    expect(await cache.get(a, sha(1))).toBeNull()
  })

  it('keeps the hash and size of a bundle beside it and never hashes it again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raditi-volume-'))
    roots.push(root)
    const cache = new BundleCache(root)
    const id = randomUUID()
    const source = join(root, 'built.bundle')
    await writeFile(source, 'bundle bytes')
    const stored = await cache.put(id, sha(2), source)
    expect(stored?.path).toBe(join(root, 'bundles', id, `${sha(2)}.bundle`))
    const sidecar = join(root, 'bundles', id, `${sha(2)}.json`)
    expect(JSON.parse(await readFile(sidecar, 'utf8'))).toMatchObject({
      sha256: sha256('bundle bytes'),
      sizeBytes: 12,
    })
    // What the sidecar says is what get answers: the file is not read whole for it.
    const lie = { ...JSON.parse(await readFile(sidecar, 'utf8')), sha256: 'f'.repeat(64) }
    await writeFile(sidecar, JSON.stringify(lie))
    expect((await cache.get(id, sha(2)))?.sha256).toBe('f'.repeat(64))
  })

  it('hashes a bundle without its sidecar once, or with one of another file, and writes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raditi-volume-'))
    roots.push(root)
    const cache = new BundleCache(root)
    const id = randomUUID()
    const dir = join(root, 'bundles', id)
    await mkdir(dir, { recursive: true })
    // A bundle of a cache written before the sidecars.
    await writeFile(join(dir, `${sha(3)}.bundle`), 'old bundle')
    expect(await cache.get(id, sha(3))).toMatchObject({
      sha256: sha256('old bundle'),
      sizeBytes: 10,
    })
    const sidecar = join(dir, `${sha(3)}.json`)
    expect(JSON.parse(await readFile(sidecar, 'utf8')).sha256).toBe(sha256('old bundle'))
    // The file put again under the same name: a new inode, the old sidecar is not its own.
    await writeFile(join(dir, 'next'), 'new bundle')
    await rename(join(dir, 'next'), join(dir, `${sha(3)}.bundle`))
    expect((await cache.get(id, sha(3)))?.sha256).toBe(sha256('new bundle'))
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
