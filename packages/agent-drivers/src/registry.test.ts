import { describe, expect, it } from 'vitest'
import { createAgentDriverRegistry, createAgentDrivers } from './registry.ts'

const drivers = createAgentDrivers({ imagePrefix: 'raditi/agent' })

describe('createAgentDrivers', () => {
  it('builds the four drivers of the PoC', () => {
    expect(drivers.map((d) => d.id)).toEqual(['codex', 'kimi', 'qwen', 'opencode'])
  })
})

describe('createAgentDriverRegistry', () => {
  it('returns every registered driver when nothing is filtered', () => {
    const registry = createAgentDriverRegistry(drivers)
    expect(registry.list().map((d) => d.id)).toEqual(['codex', 'kimi', 'qwen', 'opencode'])
    expect(registry.get('kimi').id).toBe('kimi')
    expect(registry.has('opencode')).toBe(true)
  })

  it('keeps only the enabled drivers', () => {
    const registry = createAgentDriverRegistry(drivers, new Set(['kimi', 'codex'] as const))
    expect(registry.list().map((d) => d.id)).toEqual(['codex', 'kimi'])
    expect(registry.has('qwen')).toBe(false)
    expect(() => registry.get('qwen')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('throws NOT_FOUND for a driver that is not registered', () => {
    const registry = createAgentDriverRegistry(drivers)
    expect(() => registry.get('gigacode')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('refuses an enabled id without a driver and duplicate ids', () => {
    expect(() => createAgentDriverRegistry(drivers, new Set(['sourcecraft'] as const))).toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    )
    expect(() => createAgentDriverRegistry([...drivers, drivers[0]!])).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    )
  })

  it('allows disabling every driver', () => {
    expect(createAgentDriverRegistry(drivers, new Set()).list()).toEqual([])
  })
})
