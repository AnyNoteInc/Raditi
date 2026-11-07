import type { ConnectionWay, SiteStack, StackSwitch } from '@repo/domain'
import { appEnvs, connectionWays, isNestedSiteRoot, siteStacks, stackAxisOpen } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import {
  connectableStacks,
  getSiteAdapter,
  getSiteContentAdapter,
  siteAdapters,
  stacksOpenBy,
} from './registry.ts'

describe('getSiteAdapter', () => {
  it('returns the adapter for WordPress and Bitrix', () => {
    expect(getSiteAdapter('wordpress').stack).toBe('wordpress')
    expect(getSiteAdapter('bitrix').stack).toBe('bitrix')
  })

  it('reports the stage of every other known stack', () => {
    expect(() => getSiteAdapter('static')).toThrow('(stage 2)')
    for (const stack of siteStacks.filter((s) => s !== 'wordpress' && s !== 'bitrix')) {
      expect(() => getSiteAdapter(stack)).toThrow(/NOT_IMPLEMENTED|not implemented/)
    }
  })

  it('rejects unknown stacks, including prototype keys', () => {
    expect(() => getSiteAdapter('drupal' as never)).toThrow(/Unknown site stack/)
    expect(() => getSiteAdapter('constructor' as never)).toThrow(/Unknown site stack/)
  })
})

describe('connectableStacks', () => {
  it('lists WordPress and not Bitrix, which has an adapter and no way into the product yet', () => {
    for (const way of connectionWays) {
      expect(connectableStacks('production', way)).toContain('wordpress')
      expect(connectableStacks('production', way)).not.toContain('bitrix')
    }
    expect(getSiteAdapter('bitrix').stack).toBe('bitrix')
  })

  it('lists none of the planned stacks, which have no adapter', () => {
    const withAdapter = new Set(siteAdapters().map((adapter) => adapter.stack))
    const planned = siteStacks.filter((stack) => !withAdapter.has(stack))
    expect(planned.length).toBeGreaterThan(0)
    for (const env of appEnvs)
      for (const way of connectionWays)
        for (const stack of planned) expect(connectableStacks(env, way)).not.toContain(stack)
  })

  it('takes into production by the files only a stack it takes by the browser too (Т2)', () => {
    // A system whose panel is closed does not pass the wizard in production.
    const browser = connectableStacks('production', 'browser')
    for (const stack of connectableStacks('production', 'files')) expect(browser).toContain(stack)
  })

  it('opens a stack of the registry exactly when its support opens that axis in that environment', () => {
    for (const env of appEnvs)
      for (const way of connectionWays) {
        const stacks = connectableStacks(env, way)
        for (const adapter of siteAdapters())
          expect(stacks.includes(adapter.stack)).toBe(stackAxisOpen(adapter.support[way], env))
      }
  })

  it('names only stacks that have an adapter with markers of a root folder', () => {
    for (const env of appEnvs) {
      for (const way of connectionWays) {
        const stacks = connectableStacks(env, way)
        expect(new Set(stacks).size).toBe(stacks.length)
        for (const stack of stacks) {
          expect(siteStacks).toContain(stack)
          const adapter = getSiteAdapter(stack)
          expect(adapter.stack).toBe(stack)
          // Without a marker the wizard would accept any folder as the site.
          expect(adapter.rootMarkers().length).toBeGreaterThan(0)
        }
      }
    }
  })

  it('keeps a folder of component namespaces apart from a root of Bitrix (Т15)', () => {
    // /local/components/ and the components folder of a template hold `bitrix` next to the
    // namespaces of the site: the import must not leave such a folder out as a nested installation.
    expect(isNestedSiteRoot(['bitrix', 'shop'], getSiteAdapter('bitrix').rootMarkers())).toBe(false)
  })
})

describe('stacksOpenBy', () => {
  // Synthetic supports: the registry holds no stack with a `dev` axis or with one way only yet.
  const base = getSiteAdapter('wordpress').support
  const stub = (stack: SiteStack, files: StackSwitch, browser: StackSwitch) => ({
    stack,
    support: { ...base, files, browser },
  })
  const filesInDev = stub('joomla', 'dev', 'on')
  const browserOnly = stub('opencart', 'off', 'on')
  const browserInDev = stub('modx', 'on', 'dev')
  const all = [filesInDev, browserOnly, browserInDev]
  const open = (env: (typeof appEnvs)[number], way: ConnectionWay) => stacksOpenBy(all, env, way)

  it('opens an axis at dev outside production and keeps it closed in production (Т4)', () => {
    for (const env of ['development', 'test'] as const) {
      expect(open(env, 'files')).toEqual(['joomla', 'modx'])
      expect(open(env, 'browser')).toEqual(['joomla', 'opencart', 'modx'])
    }
    expect(open('production', 'files')).toEqual(['modx'])
    expect(open('production', 'browser')).toEqual(['joomla', 'opencart'])
  })

  it('reads the axis of the way asked: a stack open by the browser only is not taken by the files', () => {
    for (const env of appEnvs) {
      expect(open(env, 'browser')).toContain('opencart')
      expect(open(env, 'files')).not.toContain('opencart')
    }
  })

  it('keeps the order of the adapters it is given', () => {
    expect(stacksOpenBy([browserInDev, filesInDev], 'development', 'browser')).toEqual([
      'modx',
      'joomla',
    ])
  })
})

describe('getSiteContentAdapter', () => {
  it('returns the published-content adapter of WordPress', () => {
    const adapter = getSiteContentAdapter('wordpress')
    expect(adapter.stack).toBe('wordpress')
    expect(adapter.accessKind).toBe('wp')
  })

  it('says that a known stack has no published content yet', () => {
    for (const stack of siteStacks.filter((s) => s !== 'wordpress'))
      expect(() => getSiteContentAdapter(stack)).toThrow(/NOT_IMPLEMENTED|not implemented/)
  })

  it('rejects unknown stacks, including prototype keys', () => {
    expect(() => getSiteContentAdapter('drupal' as never)).toThrow(/Unknown site stack/)
    expect(() => getSiteContentAdapter('constructor' as never)).toThrow(/Unknown site stack/)
  })
})
