import { describe, expect, it } from 'vitest'
import { agentEventParser, createAgentDriverRegistry, createAgentDrivers } from './registry.ts'

const drivers = createAgentDrivers({ image: `raditi/sbx-wordpress@sha256:${'a'.repeat(64)}` })

describe('createAgentDrivers', () => {
  it('uses the same pinned stack image for every driver', () => {
    expect(new Set(drivers.map((driver) => driver.image))).toEqual(
      new Set([`raditi/sbx-wordpress@sha256:${'a'.repeat(64)}`]),
    )
  })

  it('builds the four drivers of the PoC', () => {
    expect(drivers.map((d) => d.id)).toEqual(['codex', 'kimi', 'qwen', 'opencode'])
  })
})

describe('agentEventParser', () => {
  it('gives every implemented driver its own parser without a configuration', () => {
    for (const driver of drivers)
      expect(agentEventParser(driver.id).parseEvent).toBe(driver.parseEvent)
  })

  it('refuses an unknown id from an untyped caller', () => {
    // @ts-expect-error Runtime input may bypass the typed driver registry.
    expect(() => agentEventParser('unsupported')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    )
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
    const registry = createAgentDriverRegistry(drivers.filter((driver) => driver.id !== 'kimi'))
    expect(() => registry.get('kimi')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('refuses an enabled id without a driver and duplicate ids', () => {
    expect(() =>
      createAgentDriverRegistry(
        drivers.filter((driver) => driver.id !== 'kimi'),
        new Set(['kimi'] as const),
      ),
    ).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }))
    expect(() => createAgentDriverRegistry([...drivers, drivers[0]!])).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    )
  })

  it('allows disabling every driver', () => {
    expect(createAgentDriverRegistry(drivers, new Set()).list()).toEqual([])
  })
})
