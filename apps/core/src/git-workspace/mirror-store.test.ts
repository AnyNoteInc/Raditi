import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BundleCache, defaultMirrorDir, KeyedLock, mirrorPath } from './mirror-store.ts'
import { CLONE_PREFIX } from './stale-clones.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const sha = (n: number) => n.toString(16).padStart(40, '0')

describe('mirror paths', () => {
  const repo = { provider: 'gitea' as const, owner: 'sites', name: 'site' }

  it('keys a mirror by the repository and its clone URL', () => {
    const a = mirrorPath('/m', repo, 'https://git.example.test/sites/site.git')
    expect(a).toMatch(/^\/m\/repos\/[a-f0-9]{40}\.git$/)
    expect(mirrorPath('/m', repo, 'https://git.example.test/sites/site.git')).toBe(a)
    expect(mirrorPath('/m', repo, 'https://other.example.test/sites/site.git')).not.toBe(a)
    expect(
      mirrorPath('/m', { ...repo, name: 'Site' }, 'https://git.example.test/sites/site.git'),
    ).not.toBe(a)
  })

  it('stays out of the sweep of stale clones', () => {
    expect(defaultMirrorDir().split('/').at(-1)!.startsWith(CLONE_PREFIX)).toBe(false)
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
      lock.run('b', step('b1')),
    ])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
    expect(events.indexOf('a1:end')).toBeLessThan(events.indexOf('a2:start'))
    // Another key does not wait.
    expect(events.indexOf('b1:start')).toBeLessThan(events.indexOf('a1:end'))
  })
})

describe('BundleCache', () => {
  it('keeps bundles by their commit and lets the oldest go beyond its limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raditi-bundle-cache-test-'))
    roots.push(root)
    const cache = new BundleCache(root)
    await expect(cache.get(sha(1))).resolves.toBeNull()
    await cache.put(sha(1), Buffer.from('one'))
    await expect(cache.get(sha(1))).resolves.toEqual(Buffer.from('one'))
    // Names that are not commits are never paths.
    await cache.put('../x', Buffer.from('x'))
    await expect(cache.get('../x')).resolves.toBeNull()
    for (let n = 2; n <= 40; n++) {
      await cache.put(sha(n), Buffer.from(String(n)))
      await utimes(join(root, 'bundles', `${sha(n)}.bundle`), n, n)
    }
    // The first one was read last: the rest went first.
    await utimes(join(root, 'bundles', `${sha(1)}.bundle`), 1000, 1000)
    await cache.put(sha(41), Buffer.from('41'))
    const kept = await readdir(join(root, 'bundles'))
    expect(kept).toHaveLength(32)
    expect(kept).toContain(`${sha(1)}.bundle`)
    expect(kept).toContain(`${sha(41)}.bundle`)
    expect(kept).not.toContain(`${sha(2)}.bundle`)
  })

  it('answers nothing for a file it cannot read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raditi-bundle-cache-test-'))
    roots.push(root)
    await writeFile(join(root, 'bundles'), 'not a directory')
    const cache = new BundleCache(root)
    await cache.put(sha(1), Buffer.from('one'))
    await expect(cache.get(sha(1))).resolves.toBeNull()
  })
})
