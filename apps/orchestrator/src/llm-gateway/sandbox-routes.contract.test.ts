import { fileURLToPath, pathToFileURL } from 'node:url'

import { gatewayRefusalSchema, llmJsonLimits } from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { neutralRequestHeaders, neutralResponseHeaders } from './server.ts'

// The sandbox reaches the role llm through sandbox-gw alone, and sandbox-gw is a file of the
// sandbox VM (infra/sandbox/gateway.mjs) that imports nothing of the platform: its lists of LLM
// paths and headers are written by hand. This is the one place that holds the two sides to each
// other: the paths, and with one shell left the request and response headers too.
const gatewayFile = fileURLToPath(new URL('../../../../infra/sandbox/gateway.mjs', import.meta.url))
const names = z.array(z.string()).readonly()
const gatewaySchema = z.object({
  llmPaths: names,
  llmRequestHeaders: names,
  llmResponseHeaders: names,
  gatewayLimits: z.object({ requestBytes: z.number(), llmMs: z.number() }),
})
const sorted = (list: readonly string[]) => [...list].sort()

describe('the LLM surface of sandbox-gw and the routes of the role llm', () => {
  const routes = llmBackends.flatMap((backend) => backend.routes)
  // Not a static import: the file belongs to another VM and has no declarations.
  const load = async () => gatewaySchema.parse(await import(pathToFileURL(gatewayFile).href))

  it('lists exactly the paths the backends serve, each once', async () => {
    const gateway = await load()
    expect(sorted(gateway.llmPaths)).toEqual(sorted(routes.map((route) => route.path)))
    expect(new Set(gateway.llmPaths).size).toBe(gateway.llmPaths.length)
    expect(Object.isFrozen(gateway.llmPaths)).toBe(true)
  })

  it('forwards the one method every route of a backend takes', () => {
    // sandbox-gw passes POST alone on its LLM paths; a route of another method would be dead.
    expect(routes.map((route) => route.method)).toEqual(routes.map(() => 'POST'))
    // An exact path, as sandbox-gw compares it: no query, no fragment, nothing to normalize.
    for (const { path } of routes) expect(path).toMatch(/^(?:\/[a-z0-9]+)+$/)
  })

  it('forwards exactly the request headers the role reads and its backends declare', async () => {
    const gateway = await load()
    // A header sandbox-gw dropped would never reach the adapter that validates it, and one it
    // passed beside these would stop at the role unread: either way the two lists are one.
    const declared = new Set([
      ...neutralRequestHeaders,
      ...llmBackends.flatMap((backend) => backend.clientHeaders),
    ])
    expect(sorted(gateway.llmRequestHeaders)).toEqual(sorted([...declared]))
    expect(new Set(gateway.llmRequestHeaders).size).toBe(gateway.llmRequestHeaders.length)
    expect(Object.isFrozen(gateway.llmRequestHeaders)).toBe(true)
    for (const name of gateway.llmRequestHeaders) expect(name).toBe(name.toLowerCase())
  })

  it('passes back the headers of an answer and the pause of a refusal, nothing else', async () => {
    const gateway = await load()
    // Of a successful answer the role passes its own neutral headers and what the backend of
    // the route declares; `retry-after` stands only in a refusal the platform builds itself.
    const answered = new Set([
      ...neutralResponseHeaders,
      ...llmBackends.flatMap((backend) => backend.responseHeaders),
      'retry-after',
    ])
    expect(sorted(gateway.llmResponseHeaders)).toEqual(sorted([...answered]))
    expect(Object.isFrozen(gateway.llmResponseHeaders)).toBe(true)
    // Every header of a refusal an adapter builds for its CLI comes through.
    for (const backend of llmBackends)
      for (const kind of gatewayRefusalSchema.options)
        for (const name of backend.refusal(kind, 30_000).headers.keys())
          expect(gateway.llmResponseHeaders, `${backend.id} ${kind}`).toContain(name)
  })

  it('refuses a body the role would refuse, and gives the role time to end a request itself', async () => {
    const { gatewayLimits } = await load()
    expect(gatewayLimits.requestBytes).toBe(llmJsonLimits.bytes)
    // The role ends a request at ten minutes; the backstop of sandbox-gw must come later.
    expect(gatewayLimits.llmMs).toBeGreaterThan(10 * 60_000)
  })
})
