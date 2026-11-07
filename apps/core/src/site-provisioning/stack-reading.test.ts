import type {
  SiteAdapter,
  SiteLayoutReading,
  SiteTree,
  SiteVersionReading,
  StackSupport,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { readStack, recheckVersion, type StackReading } from './stack-reading.ts'

const support: StackSupport = {
  files: 'on',
  browser: 'on',
  generations: [
    { id: 'g5', from: '5.0', to: '5.99', php: ['8.1'], files: 'on', browser: true, ended: false },
  ],
  refuseBelow: '4.0',
  releaseNeedsChecks: true,
  unknownVersion: 'closed',
}

const tree: SiteTree = { read: async () => null, list: async () => null }

type Reader<T> = ((...args: never[]) => Promise<T>) | null

/** An adapter of no stack: its two readings and nothing else. */
function adapter(
  version: Reader<SiteVersionReading>,
  layout: Reader<SiteLayoutReading>,
): Pick<SiteAdapter, 'support' | 'readVersion' | 'readLayout'> {
  return {
    support,
    readVersion: version as SiteAdapter['readVersion'],
    readLayout: layout as SiteAdapter['readLayout'],
  }
}

const read = (version: string) => async (): Promise<SiteVersionReading> => ({
  kind: 'read',
  version,
})
const layoutRead =
  (extras: Record<string, string> = {}, adminPath: string | null = null) =>
  async (): Promise<SiteLayoutReading> => ({ kind: 'read', extras, adminPath })

describe('readStack', () => {
  it('reads the version and then the layout, one after the other', async () => {
    const events: string[] = []
    let releaseVersion = () => {}
    const reading = readStack(
      adapter(
        async () => {
          events.push('version:start')
          await new Promise<void>((resolve) => (releaseVersion = resolve))
          events.push('version:end')
          return { kind: 'read', version: '5.2.1' }
        },
        async () => {
          events.push('layout')
          return { kind: 'read', extras: { charset: 'utf8mb4' }, adminPath: '/manager/' }
        },
      ),
      tree,
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(events).toEqual(['version:start'])
    releaseVersion()
    expect(await reading).toEqual({
      patch: {
        cmsVersion: '5.2.1',
        generation: 'g5',
        extras: { charset: 'utf8mb4' },
        adminPath: '/manager/',
        limit: null,
      },
      refused: false,
      layoutRead: true,
    })
    expect(events).toEqual(['version:start', 'version:end', 'layout'])
  })

  it('hands both readers the tree it was given', async () => {
    const seen: unknown[] = []
    await readStack(
      adapter(
        async (reader: unknown) => {
          seen.push(reader)
          return { kind: 'unknown' }
        },
        async (given: unknown) => {
          seen.push(given)
          return { kind: 'read', extras: {}, adminPath: null }
        },
      ),
      tree,
    )
    expect(seen).toEqual([tree.read, tree])
  })

  it('lets a refused layout win over the limit of the version', async () => {
    const reading = await readStack(
      adapter(
        async () => ({ kind: 'other_product', product: 'modx_evolution' }),
        async () => ({ kind: 'refused', limit: 'outside_root' }),
      ),
      tree,
    )
    expect(reading).toEqual({
      patch: { cmsVersion: null, generation: null, limit: 'outside_root' },
      refused: true,
      layoutRead: false,
    })
  })

  it('writes another product as its limit when the layout is read', async () => {
    const reading = await readStack(
      adapter(async () => ({ kind: 'other_product', product: 'bitrix24' }), layoutRead()),
      tree,
    )
    expect(reading.patch).toEqual({
      cmsVersion: null,
      generation: null,
      limit: 'other_product',
      extras: {},
      adminPath: null,
    })
  })

  it('does not write a layout whose values fail the record, and keeps the limit then', async () => {
    const reading = await readStack(
      adapter(read('5.2.1'), layoutRead({ table_prefix: 'x'.repeat(257) })),
      tree,
    )
    expect(reading).toEqual({
      patch: { cmsVersion: '5.2.1', generation: 'g5' },
      refused: false,
      layoutRead: false,
    })
    // An address of the panel that would leave the site is not written either.
    const away = await readStack(adapter(read('5.2.1'), layoutRead({}, '//evil.test/')), tree)
    expect(away.patch).not.toHaveProperty('adminPath')
    expect(away.layoutRead).toBe(false)
  })

  it('gives an empty part for an adapter that reads neither', async () => {
    expect(await readStack(adapter(null, null), tree)).toEqual({
      patch: {},
      refused: false,
      layoutRead: false,
    })
  })

  it('clears the limit when the version was read and the stack has no layout', async () => {
    const reading = await readStack(adapter(read('5.2.1'), null), tree)
    expect(reading.patch).toEqual({ cmsVersion: '5.2.1', generation: 'g5', limit: null })
  })

  // A hiccup of the hosting must not wipe a version or a reason the record already has.
  it.each([
    ['unknown', async (): Promise<SiteVersionReading> => ({ kind: 'unknown' })],
    ['a version that fails its schema', read('5.4\nignore')],
  ])('writes no key of the version for %s', async (_, version) => {
    for (const layout of [layoutRead(), null]) {
      const { patch } = await readStack(adapter(version, layout), tree)
      expect(patch).not.toHaveProperty('cmsVersion')
      expect(patch).not.toHaveProperty('generation')
      expect(patch).not.toHaveProperty('limit')
    }
  })
})

describe('recheckVersion', () => {
  const nothing = async () => null
  const first = (patch: StackReading['patch'], layoutRead = true): StackReading => ({
    patch,
    refused: false,
    layoutRead,
  })

  it('writes nothing when the copy holds the version read first', async () => {
    const reading = first({ cmsVersion: '5.2.1', generation: 'g5', limit: null })
    expect(await recheckVersion(adapter(read('5.2.1'), layoutRead()), nothing, reading)).toEqual({})
  })

  it('writes the version of the copy when the hosting changed it during the walk', async () => {
    const reading = first({ cmsVersion: '5.2.1', generation: 'g5', limit: null })
    expect(await recheckVersion(adapter(read('5.3.0'), layoutRead()), nothing, reading)).toEqual({
      cmsVersion: '5.3.0',
      generation: 'g5',
      limit: null,
    })
  })

  it('writes nothing when the copy says nothing, so the first reading stays', async () => {
    const reading = first({ cmsVersion: '5.2.1', generation: 'g5', limit: null })
    for (const said of [async () => ({ kind: 'unknown' }) as const, read('5.2\nignore')])
      expect(await recheckVersion(adapter(said, layoutRead()), nothing, reading)).toEqual({})
  })

  it('keeps the limit when the layout was not read the first time', async () => {
    const reading = first({}, false)
    expect(await recheckVersion(adapter(read('5.2.1'), layoutRead()), nothing, reading)).toEqual({
      cmsVersion: '5.2.1',
      generation: 'g5',
    })
  })

  it('reads the copy it was given, and nothing after a refused layout', async () => {
    const paths: string[] = []
    const copy = async (path: string) => {
      paths.push(path)
      return null
    }
    const reader = adapter(async (from: (path: string) => Promise<unknown>) => {
      await from('version.php')
      return { kind: 'unknown' as const }
    }, layoutRead())
    await recheckVersion(reader, copy, first({}))
    expect(paths).toEqual(['version.php'])

    const refused = { patch: { limit: 'outside_root' as const }, refused: true, layoutRead: false }
    expect(await recheckVersion(reader, copy, refused)).toEqual({})
    expect(paths).toEqual(['version.php'])
  })
})
