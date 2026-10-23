import type * as McpNest from '@rekog/mcp-nest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../app.module.ts'
import { testMcpConfig } from '../testing/fakes.ts'
import { assertMcpNestToolAuthorization, createMcpRuntime } from './mcp-runtime.ts'

/** Stands in for an mcp-nest that keeps its tool authorization service elsewhere. */
const mcpNest = vi.hoisted(() => ({ withoutAuthorization: false }))

vi.mock('@rekog/mcp-nest', async (importOriginal) => {
  const original = await importOriginal<typeof McpNest>()
  class McpStrategy extends original.McpStrategy {
    constructor(...args: ConstructorParameters<typeof original.McpStrategy>) {
      super(...args)
      if (mcpNest.withoutAuthorization) Reflect.deleteProperty(this, 'authService')
    }
  }
  return { ...original, McpStrategy }
})

const moved = 'mcp-nest: the tool authorization service is not where it was'

describe('createMcpRuntime', () => {
  afterEach(() => {
    mcpNest.withoutAuthorization = false
  })

  it('finds the tool authorization service of the installed mcp-nest', () => {
    expect(() => assertMcpNestToolAuthorization()).not.toThrow()
    const security = { allowedHosts: ['localhost'], allowLocalOrigin: true }
    expect(() => createMcpRuntime(security)).not.toThrow()
  })

  it('refuses the role in AppModule.forRoot, before Nest exists, when mcp-nest moved the service', () => {
    mcpNest.withoutAuthorization = true
    expect(() => assertMcpNestToolAuthorization()).toThrow(moved)
    expect(() => AppModule.forRoot(testMcpConfig())).toThrow(moved)
    // The refusals of the composition come first, as when the runtime was made there.
    expect(() =>
      AppModule.forRoot({ ...testMcpConfig(), contentProfile: 'local-site', storage: null }),
    ).toThrow('MCP content profile needs its S3 settings')
  })
})
