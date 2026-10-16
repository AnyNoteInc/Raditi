import type { AgentDriver, AgentDriverId } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { agentEventParser, createAgentDriverRegistry, createAgentDrivers } from './registry.ts'

const drivers = createAgentDrivers({ image: `raditi/sbx-wordpress@sha256:${'a'.repeat(64)}` })
const opencode = drivers[0]!
/** The package has one driver; the rules of the registry are about several, so two stand in. */
const standIn = (id: string): AgentDriver => ({ ...opencode, id: id as AgentDriverId })
const second = standIn('second-driver')
const third = standIn('third-driver')
const several = [opencode, second, third]

describe('createAgentDrivers', () => {
  it('uses the same pinned stack image for every driver', () => {
    expect(new Set(drivers.map((driver) => driver.image))).toEqual(
      new Set([`raditi/sbx-wordpress@sha256:${'a'.repeat(64)}`]),
    )
  })

  it('builds the one driver of the product', () => {
    expect(drivers.map((d) => d.id)).toEqual(['opencode'])
  })
})

describe('agentEventParser', () => {
  it('gives every implemented driver its own parser without a configuration', () => {
    for (const driver of drivers)
      expect(agentEventParser(driver.id).parseEvent).toBe(driver.parseEvent)
  })

  it('refuses an id the package has no driver for', () => {
    for (const id of ['unsupported', second.id])
      expect(() => agentEventParser(id as AgentDriverId)).toThrow(
        expect.objectContaining({ code: 'NOT_FOUND' }),
      )
  })
})

describe('createAgentDriverRegistry', () => {
  it('returns every registered driver when nothing is filtered', () => {
    const registry = createAgentDriverRegistry(several)
    expect(registry.list()).toEqual(several)
    expect(registry.get(second.id)).toBe(second)
    expect(registry.has(third.id)).toBe(true)
  })

  it('keeps only the enabled drivers', () => {
    const registry = createAgentDriverRegistry(several, new Set([third.id, opencode.id]))
    expect(registry.list()).toEqual([opencode, third])
    expect(registry.has(second.id)).toBe(false)
    expect(() => registry.get(second.id)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('throws NOT_FOUND for a driver that is not registered', () => {
    const registry = createAgentDriverRegistry([opencode, third])
    expect(() => registry.get(second.id)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('refuses an enabled id without a driver and duplicate ids', () => {
    expect(() => createAgentDriverRegistry([opencode, third], new Set([second.id]))).toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    )
    expect(() => createAgentDriverRegistry([...several, { ...second }])).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    )
  })

  it('allows disabling every driver', () => {
    expect(createAgentDriverRegistry(several, new Set()).list()).toEqual([])
  })
})
