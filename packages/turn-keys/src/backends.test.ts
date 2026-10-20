import { fileURLToPath, pathToFileURL } from 'node:url'

import { llmBackendIds, type LlmBackend } from '@repo/domain'
import { llmBackends, zaiApiBackend, zaiCodingBackend } from '@repo/llm-backends'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { sampleBackendCapacity, sampleBackendId } from './testing.ts'
import { backendCapacities, llmGatewayBaseUrl } from './backends.ts'

const gateway = 'http://sandbox-gw:8080'

describe('what core reads of the backends', () => {
  it('knows the capacity of every backend id from its adapter', () => {
    const capacityOf = backendCapacities(llmBackends)
    expect(llmBackendIds.map((id) => [id, capacityOf(id)])).toEqual([
      ['zai-coding', 'windows'],
      ['zai-api', 'none'],
    ])
  })

  it('agrees with the capacity the tests name for the sample backend', () => {
    expect(backendCapacities(llmBackends)(sampleBackendId)).toBe(sampleBackendCapacity)
  })

  it('fails closed for an id no adapter of the process serves', () => {
    expect(() => backendCapacities([zaiCodingBackend])('zai-api')).toThrow(
      expect.objectContaining({
        code: 'CONFLICT',
        message: 'No LLM backend adapter for the turn',
      }),
    )
  })
})

describe('the base URL of a backend in the sandbox', () => {
  it('is sandbox-gw and the route without the chat completions suffix', () => {
    expect(llmGatewayBaseUrl(gateway, zaiCodingBackend)).toBe('http://sandbox-gw:8080/zai/v4')
    expect(llmGatewayBaseUrl(`${gateway}/`, zaiApiBackend)).toBe(
      'http://sandbox-gw:8080/zai/paas/v4',
    )
    // A path of its own keeps everything but the slashes it ends with.
    expect(llmGatewayBaseUrl(`${gateway}/base//`, zaiCodingBackend)).toBe(
      'http://sandbox-gw:8080/base/zai/v4',
    )
    expect(llmGatewayBaseUrl(`${gateway}/a//b///`, zaiCodingBackend)).toBe(
      'http://sandbox-gw:8080/a//b/zai/v4',
    )
  })

  it.each(llmBackends.map((backend) => [backend.id, backend] as const))(
    'leads the client of %s back to its one route',
    (_id, backend) => {
      // sandbox-gw lists each route as an exact path; sandbox-routes.contract.test.ts holds its
      // llmPaths to the routes of the registry.
      const url = new URL(`${llmGatewayBaseUrl(gateway, backend)}/chat/completions`)
      expect(url.origin).toBe(gateway)
      expect(url.pathname).toBe(backend.routes[0]!.path)
    },
  )

  it('leads the client of every backend to a path sandbox-gw passes on', async () => {
    // The file of the sandbox VM, read as sandbox-routes.contract.test.ts reads it.
    const gatewayFile = fileURLToPath(
      new URL('../../../infra/sandbox/gateway.mjs', import.meta.url),
    )
    const { llmPaths } = z
      .object({ llmPaths: z.array(z.string()).readonly() })
      .parse(await import(pathToFileURL(gatewayFile).href))
    const reached = llmBackends.map(
      (backend) => new URL(`${llmGatewayBaseUrl(gateway, backend)}/chat/completions`).pathname,
    )
    expect([...reached].sort()).toEqual([...llmPaths].sort())
  })

  it('gives two backends two different base URLs', () => {
    const urls = llmBackends.map((backend) => llmGatewayBaseUrl(gateway, backend))
    expect(new Set(urls).size).toBe(urls.length)
  })

  it.each([
    ['two routes', [zaiCodingBackend.routes[0]!, zaiApiBackend.routes[0]!]],
    ['no route', []],
    ['another method', [{ method: 'GET', path: '/zai/v4/chat/completions' }]],
    ['another suffix', [{ method: 'POST', path: '/zai/v4/responses' }]],
    ['the suffix alone', [{ method: 'POST', path: '/chat/completions' }]],
  ] satisfies [string, LlmBackend['routes']][])('refuses a backend with %s', (_name, routes) => {
    expect(() => llmGatewayBaseUrl(gateway, { routes })).toThrow(
      'The LLM backend serves no single chat completions route',
    )
  })

  it.each([
    'sandbox-gw:8080',
    'ftp://sandbox-gw',
    'http://user:secret@sandbox-gw:8080',
    'http://sandbox-gw:8080/?a=1',
    'http://sandbox-gw:8080/#x',
  ])('refuses the gateway address %s', (address) => {
    expect(() => llmGatewayBaseUrl(address, zaiCodingBackend)).toThrow(
      'The sandbox gateway needs an HTTP address',
    )
  })
})
