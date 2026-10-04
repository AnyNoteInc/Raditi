import type { AgentDriver, AgentDriverId } from '@repo/domain'
import { badRequest, conflict, notFound } from '@repo/domain'
import type { AgentDriverConfig } from './config.ts'
import { parseCodexEvent } from './codex-events.ts'
import { createCodexDriver } from './codex.ts'
import { parseKimiEvent } from './kimi-events.ts'
import { createKimiDriver } from './kimi.ts'
import { parseOpencodeEvent } from './opencode-events.ts'
import { createOpencodeDriver } from './opencode.ts'
import { parseQwenEvent } from './qwen-events.ts'
import { createQwenDriver } from './qwen.ts'

export interface AgentDriverRegistry {
  /** Throws NOT_FOUND when the driver is unknown or not enabled. */
  get(id: AgentDriverId): AgentDriver
  has(id: AgentDriverId): boolean
  /** Enabled drivers in registration order. */
  list(): AgentDriver[]
}

/** Every implemented driver; qwen and opencode remain disabled in the application. */
export function createAgentDrivers(config: AgentDriverConfig): AgentDriver[] {
  return [
    createCodexDriver(config),
    createKimiDriver(config),
    createQwenDriver(config),
    createOpencodeDriver(config),
  ]
}

const eventParsers: Partial<Record<AgentDriverId, AgentDriver['parseEvent']>> = {
  codex: parseCodexEvent,
  kimi: parseKimiEvent,
  qwen: parseQwenEvent,
  opencode: parseOpencodeEvent,
}

/**
 * The stateless event parser of a driver, without its configuration: a runner VM only reads
 * the agent's output (spec §8). NOT_FOUND for a driver this package does not implement.
 */
export function agentEventParser(id: AgentDriverId): Pick<AgentDriver, 'parseEvent'> {
  const parseEvent = eventParsers[id]
  if (!parseEvent) throw notFound(`Agent driver "${id}" is not available`)
  return { parseEvent }
}

/**
 * `enabled` narrows the drivers the router may pick, e.g. codex and kimi in the MVP (spec §8);
 * without it every registered driver is enabled.
 */
export function createAgentDriverRegistry(
  drivers: readonly AgentDriver[],
  enabled?: ReadonlySet<AgentDriverId>,
): AgentDriverRegistry {
  const all = new Map<AgentDriverId, AgentDriver>()
  for (const driver of drivers) {
    if (all.has(driver.id)) throw conflict(`Agent driver "${driver.id}" is registered twice`)
    all.set(driver.id, driver)
  }
  for (const id of enabled ?? []) {
    if (!all.has(id)) throw badRequest(`Enabled agent driver "${id}" is not registered`)
  }

  const active = new Map([...all].filter(([id]) => !enabled || enabled.has(id)))
  return {
    get(id) {
      const driver = active.get(id)
      if (!driver) throw notFound(`Agent driver "${id}" is not available`)
      return driver
    },
    has(id) {
      return active.has(id)
    },
    list() {
      return [...active.values()]
    },
  }
}
