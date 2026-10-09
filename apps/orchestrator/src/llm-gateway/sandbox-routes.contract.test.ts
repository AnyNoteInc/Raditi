import { fileURLToPath, pathToFileURL } from 'node:url'

import { llmJsonLimits } from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

// The sandbox reaches the role llm through sandbox-gw alone, and sandbox-gw is a file of the
// sandbox VM (infra/sandbox/gateway.mjs) that imports nothing of the platform: its list of LLM
// paths is written by hand. This is the one place that holds the two sides to each other. The
// request headers are compared once a single shell is left (G8 of the pivot plan): the list of
// sandbox-gw is still the union of what three CLIs send, and one of them goes by a prefix rule.
const gatewayFile = fileURLToPath(new URL('../../../../infra/sandbox/gateway.mjs', import.meta.url))
const gatewaySchema = z.object({
  llmPaths: z.array(z.string()).readonly(),
  gatewayLimits: z.object({ requestBytes: z.number(), llmMs: z.number() }),
})

describe('the LLM surface of sandbox-gw and the routes of the role llm', () => {
  const routes = llmBackends.flatMap((backend) => backend.routes)

  it('lists exactly the paths the backends serve, each once', async () => {
    // Not a static import: the file belongs to another VM and has no declarations.
    const gateway = gatewaySchema.parse(await import(pathToFileURL(gatewayFile).href))
    expect([...gateway.llmPaths].sort()).toEqual(routes.map((route) => route.path).sort())
    expect(new Set(gateway.llmPaths).size).toBe(gateway.llmPaths.length)
    expect(Object.isFrozen(gateway.llmPaths)).toBe(true)
  })

  it('forwards the one method every route of a backend takes', () => {
    // sandbox-gw passes POST alone on its LLM paths; a route of another method would be dead.
    expect(routes.map((route) => route.method)).toEqual(routes.map(() => 'POST'))
    // An exact path, as sandbox-gw compares it: no query, no fragment, nothing to normalize.
    for (const { path } of routes) expect(path).toMatch(/^(?:\/[a-z0-9]+)+$/)
  })

  it('refuses a body the role would refuse, and gives the role time to end a request itself', async () => {
    const { gatewayLimits } = gatewaySchema.parse(await import(pathToFileURL(gatewayFile).href))
    expect(gatewayLimits.requestBytes).toBe(llmJsonLimits.bytes)
    // The role ends a request at ten minutes; the backstop of sandbox-gw must come later.
    expect(gatewayLimits.llmMs).toBeGreaterThan(10 * 60_000)
  })
})
