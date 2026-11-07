import { describe, expect, it, vi } from 'vitest'

import type { SiteRead, SiteVersionReading } from '../ports/site-adapter.ts'
import { SiteConnectionError } from '../site-connection/ports.ts'
import {
  inspectSiteRoot,
  siteRootInspectionSchema,
  versionFactsOf,
  type SiteRootInspector,
} from './inspect.ts'
import type { SiteLimit, SiteStack } from './stacks.ts'
import type { StackGeneration, StackSupport } from './support.ts'

// The adapters below are shapes of the port: each test of one stack names it itself (rule 8). The
// markers of WordPress and Bitrix are theirs; the versions and hints are what the test needs.

const utf8 = new TextEncoder()

function adapter(
  stack: SiteStack,
  markers: readonly string[],
  more: {
    readVersion?: SiteRootInspector['readVersion']
    rootHint?: (names: readonly string[]) => SiteLimit | null
  } = {},
): SiteRootInspector & { rootHint: ReturnType<typeof vi.fn> } {
  const rootHint = vi.fn(more.rootHint ?? (() => null))
  return {
    stack,
    rootMarkers: () => [...markers],
    readVersion: more.readVersion ?? null,
    recognition: {
      publicPaths: [],
      fingerprint: () => 'unknown',
      publicGeneration: () => null,
      needsOwnYes: false,
      rootHint,
      coreFolder: null,
    },
    rootHint,
  }
}

/** `$wp_version` of `wp-includes/version.php`, as the adapter of WordPress reads it. */
async function wordpressVersion(read: SiteRead): Promise<SiteVersionReading> {
  const bytes = await read('wp-includes/version.php')
  const version = bytes && /\$wp_version = '([^']+)'/.exec(new TextDecoder().decode(bytes))?.[1]
  return version ? { kind: 'read', version } : { kind: 'unknown' }
}

function files(tree: Record<string, string>) {
  const read = vi.fn<SiteRead>(async (path) => (path in tree ? utf8.encode(tree[path]) : null))
  return read
}

const wordpress = () =>
  adapter('wordpress', ['wp-content', 'wp-includes'], { readVersion: wordpressVersion })
const bitrix = () => adapter('bitrix', ['bitrix', '.access.php'])

const wordpressRoot = ['index.php', 'wp-admin', 'wp-content', 'wp-includes', 'wp-config.php']

describe('inspectSiteRoot', () => {
  it('finds WordPress by its markers and reads its version in the session it is given', async () => {
    const read = files({ 'wp-includes/version.php': "<?php $wp_version = '6.9.1';" })
    const inspection = await inspectSiteRoot([wordpress(), bitrix()], wordpressRoot, read)
    expect(inspection).toEqual({
      foundStack: 'wordpress',
      version: { kind: 'read', version: '6.9.1' },
      hint: null,
      hasIndexPhp: true,
    })
    expect(siteRootInspectionSchema.parse(inspection)).toEqual(inspection)
    expect(read).toHaveBeenCalledExactlyOnceWith('wp-includes/version.php')
  })

  it('finds Bitrix on its own tree, and reads nothing of a stack whose files are closed', async () => {
    const read = files({})
    const inspection = await inspectSiteRoot(
      [wordpress(), bitrix()],
      ['bitrix', 'upload', '.access.php', 'index.php'],
      read,
    )
    expect(inspection).toEqual({
      foundStack: 'bitrix',
      version: { kind: 'unknown' },
      hint: null,
      hasIndexPhp: true,
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('takes the stack of the first hint where no markers pass, and reads nothing', async () => {
    const read = files({})
    const a = adapter('modx', ['core', 'assets', 'config.core.php'], {
      readVersion: async () => ({ kind: 'read', version: '3.0.4' }),
      rootHint: (names) => (names.includes('config.core.php') ? 'renamed_folder' : null),
    })
    const names = ['config.core.php', 'core', 'media']
    expect(await inspectSiteRoot([wordpress(), a], names, read)).toEqual({
      foundStack: 'modx',
      version: { kind: 'unknown' },
      hint: 'renamed_folder',
      hasIndexPhp: false,
    })
    expect(read).not.toHaveBeenCalled()

    // Without a hint there is no stack at all.
    expect(await inspectSiteRoot([wordpress(), a], ['media', 'readme.txt'], read)).toEqual({
      foundStack: null,
      version: { kind: 'unknown' },
      hint: null,
      hasIndexPhp: false,
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('reads the hint of the found stack beside its version, and no hint of another', async () => {
    const read = files({})
    const a = adapter('modx', ['core', 'config.core.php'], {
      readVersion: async () => ({ kind: 'read', version: '3.0.4' }),
      rootHint: () => 'renamed_folder',
    })
    const other = adapter('joomla', ['administrator'], { rootHint: () => 'outside_root' })
    const inspection = await inspectSiteRoot(
      [a, other],
      ['core', 'config.core.php', 'index.php'],
      read,
    )
    expect(inspection).toEqual({
      foundStack: 'modx',
      version: { kind: 'read', version: '3.0.4' },
      hint: 'renamed_folder',
      hasIndexPhp: true,
    })
    expect(other.rootHint).not.toHaveBeenCalled()
  })

  it('answers unknown to an exception of the adapter and to a version outside the schema', async () => {
    const throwing = adapter('wordpress', ['wp-content'], {
      readVersion: () => Promise.reject(new Error('the adapter broke')),
    })
    expect((await inspectSiteRoot([throwing], ['wp-content'], files({}))).version).toEqual({
      kind: 'unknown',
    })
    const lying = adapter('wordpress', ['wp-content'], {
      readVersion: async () => ({ kind: 'read', version: '5.4\nignore' }),
    })
    expect((await inspectSiteRoot([lying], ['wp-content'], files({}))).version).toEqual({
      kind: 'unknown',
    })
    const foreign = adapter('wordpress', ['wp-content'], {
      readVersion: async () => ({ kind: 'other_product', product: 'joomla' }) as never,
    })
    expect((await inspectSiteRoot([foreign], ['wp-content'], files({}))).version).toEqual({
      kind: 'unknown',
    })
  })

  it('lets a broken read through, whether the adapter passed it on or caught it', async () => {
    const broken: SiteRead = () => Promise.reject(new SiteConnectionError('transfer_failed'))
    const passing = adapter('wordpress', ['wp-content'], { readVersion: wordpressVersion })
    await expect(inspectSiteRoot([passing], ['wp-content'], broken)).rejects.toMatchObject({
      name: 'SiteConnectionError',
      reason: 'transfer_failed',
    })
    // A plain `catch` around `readVersion` would take this cut for an unknown version.
    const catching = adapter('wordpress', ['wp-content'], {
      async readVersion(read) {
        try {
          await read('wp-includes/version.php')
        } catch {
          // The adapter swallows it.
        }
        return { kind: 'unknown' }
      },
    })
    await expect(inspectSiteRoot([catching], ['wp-content'], broken)).rejects.toMatchObject({
      name: 'SiteConnectionError',
      reason: 'transfer_failed',
    })
  })

  it('tells a root with an index.php in any case from one without', async () => {
    for (const name of ['index.php', 'INDEX.PHP'])
      expect((await inspectSiteRoot([], [name, 'css'], files({}))).hasIndexPhp).toBe(true)
    expect((await inspectSiteRoot([], ['index.html', 'php'], files({}))).hasIndexPhp).toBe(false)
  })
})

describe('versionFactsOf', () => {
  const row = (id: string, from: string, to: string): StackGeneration => ({
    id,
    from,
    to,
    php: ['8.1'],
    files: 'on',
    browser: true,
    ended: false,
  })
  const support: StackSupport = {
    files: 'on',
    browser: 'on',
    generations: [row('j4', '4.0', '4.99'), row('j5', '5.0', '5.99')],
    refuseBelow: '3.10',
    releaseNeedsChecks: true,
    unknownVersion: 'closed',
  }

  it('records a read version with its generation', () => {
    expect(versionFactsOf(support, { kind: 'read', version: '5.2.3' })).toEqual({
      cmsVersion: '5.2.3',
      generation: 'j5',
      limit: null,
    })
    expect(versionFactsOf(support, { kind: 'read', version: '3.9.28' })).toEqual({
      cmsVersion: '3.9.28',
      generation: null,
      limit: null,
    })
  })

  it('records another product as its limit, and an unknown or broken version as nothing', () => {
    expect(versionFactsOf(support, { kind: 'other_product', product: 'modx_evolution' })).toEqual({
      cmsVersion: null,
      generation: null,
      limit: 'other_product',
    })
    const nothing = { cmsVersion: null, generation: null, limit: null }
    expect(versionFactsOf(support, { kind: 'unknown' })).toEqual(nothing)
    expect(versionFactsOf(support, { kind: 'read', version: '5.4\nignore' })).toEqual(nothing)
  })
})
