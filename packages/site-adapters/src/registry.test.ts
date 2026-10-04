import { siteStacks } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { getSiteAdapter, getSiteContentAdapter } from './registry.ts'

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
