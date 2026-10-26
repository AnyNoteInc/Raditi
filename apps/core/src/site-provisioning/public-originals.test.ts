import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { publicOriginalsOf, type FetchOriginal } from './public-originals.ts'
import type { TakenFile } from './tree-walk.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function filesOf(contents: Record<string, string>): Promise<TakenFile[]> {
  const root = await mkdtemp(join(tmpdir(), 'public-originals-'))
  roots.push(root)
  return Promise.all(
    Object.entries(contents).map(async ([path, text], index) => {
      const blob = join(root, String(index))
      await writeFile(blob, text)
      return { path, blob, bytes: Buffer.byteLength(text) }
    }),
  )
}

const signal = new AbortController().signal

describe('publicOriginalsOf', () => {
  it('takes a flagged file whose published original is the same bytes, and no other', async () => {
    const files = await filesOf({
      'plugin/main.php': 'Version: 1.0',
      'plugin/forms.php': "'api_key' => 'abcdef1234567890'",
      'plugin/changed.php': "'token' => 'mine-and-secret-123'",
    })
    const rules = {
      publicOriginals: vi.fn(async (paths: readonly string[], read) => {
        // The adapter reads the version from the site's own files.
        expect(new TextDecoder().decode((await read('plugin/main.php')) ?? undefined)).toBe('Version: 1.0')
        return new Map(paths.map((path) => [path, `https://example.test/${path}`]))
      }),
    }
    const fetch: FetchOriginal = vi.fn(async (url: string) =>
      url.endsWith('forms.php')
        ? new TextEncoder().encode("'api_key' => 'abcdef1234567890'")
        : new TextEncoder().encode("'token' => 'published-value-xx'"),
    )
    const vouched = await publicOriginalsOf({ rules, files, flagged: new Set([1, 2]), signal, fetch })
    expect([...vouched]).toEqual([1])
    expect(rules.publicOriginals).toHaveBeenCalledWith(['plugin/forms.php', 'plugin/changed.php'], expect.any(Function))
  })

  it('takes nothing when the stack names no originals, the adapter fails or a download fails', async () => {
    const files = await filesOf({ 'a.php': 'x' })
    const flagged = new Set([0])
    const fetch: FetchOriginal = vi.fn(async () => new TextEncoder().encode('x'))
    expect((await publicOriginalsOf({ rules: {}, files, flagged, signal, fetch })).size).toBe(0)
    const failing = { publicOriginals: vi.fn(async () => Promise.reject(new Error('boom'))) }
    expect((await publicOriginalsOf({ rules: failing, files, flagged, signal, fetch })).size).toBe(0)
    const named = { publicOriginals: vi.fn(async () => new Map([['a.php', 'https://example.test/a.php']])) }
    const broken: FetchOriginal = vi.fn(async () => Promise.reject(new Error('offline')))
    expect((await publicOriginalsOf({ rules: named, files, flagged, signal, fetch: broken })).size).toBe(0)
    const missing: FetchOriginal = vi.fn(async () => null)
    expect((await publicOriginalsOf({ rules: named, files, flagged, signal, fetch: missing })).size).toBe(0)
  })

  it('asks nothing when nothing was flagged', async () => {
    const files = await filesOf({ 'a.php': 'x' })
    const rules = { publicOriginals: vi.fn() }
    const fetch: FetchOriginal = vi.fn()
    expect((await publicOriginalsOf({ rules, files, flagged: new Set(), signal, fetch })).size).toBe(0)
    expect(rules.publicOriginals).not.toHaveBeenCalled()
  })
})
