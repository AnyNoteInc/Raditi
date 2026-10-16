import { isNestedSiteRoot, siteStacks } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { connectableStacks, getSiteAdapter, getSiteContentAdapter } from './registry.ts'

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
    expect(() => getSiteAdapter('joomla' as never)).toThrow(/Unknown site stack/)
    expect(() => getSiteAdapter('constructor' as never)).toThrow(/Unknown site stack/)
  })
})

describe('connectableStacks', () => {
  it('lists WordPress and not Bitrix, which has an adapter and no way into the product yet', () => {
    expect(connectableStacks).toContain('wordpress')
    expect(connectableStacks).not.toContain('bitrix')
    expect(getSiteAdapter('bitrix').stack).toBe('bitrix')
  })

  it('names only stacks that have an adapter with markers of a root folder', () => {
    expect(new Set(connectableStacks).size).toBe(connectableStacks.length)
    for (const stack of connectableStacks) {
      expect(siteStacks).toContain(stack)
      const adapter = getSiteAdapter(stack)
      expect(adapter.stack).toBe(stack)
      // Without a marker the wizard would accept any folder as the site.
      expect(adapter.rootMarkers().length).toBeGreaterThan(0)
    }
  })

  it('keeps Bitrix out while its markers also fit a folder of component namespaces', () => {
    // /local/components/ and the components folder of a template hold `bitrix` next to the
    // namespaces of the site: the import would leave such a folder out as a nested installation.
    const markers = getSiteAdapter('bitrix').rootMarkers()
    const namespacesFit = isNestedSiteRoot(['bitrix', 'shop'], markers)
    expect(connectableStacks.includes('bitrix') && namespacesFit).toBe(false)
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
    expect(() => getSiteContentAdapter('joomla' as never)).toThrow(/Unknown site stack/)
    expect(() => getSiteContentAdapter('constructor' as never)).toThrow(/Unknown site stack/)
  })
})
