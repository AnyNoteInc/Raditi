import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createLlmTestCertificates } from '../testing/llm-certificates.ts'

// The production role llm takes one extra CA, the CA of Vault, in NODE_EXTRA_CA_CERTS
// (PRODUCTION_VAULT_CA_FILE, config/llm-config.ts). That is harmless to provider TLS only while
// the transport verifies a provider against the bundled roots and nothing else. Node reads the
// variable when a process starts, so the transport is tried in a process of its own.
const probe = fileURLToPath(new URL('../testing/provider-trust-probe.ts', import.meta.url))
const networkGuard = new URL('../testing/network-guard.ts', import.meta.url).href

let certificates: ReturnType<typeof createLlmTestCertificates>
beforeAll(() => {
  certificates = createLlmTestCertificates()
})
afterAll(() => certificates?.close())

/** A loopback TLS server whose certificate only the synthetic CA of the test vouches for. */
async function server() {
  let requests = 0
  const provider = createServer(
    { cert: readFileSync(certificates.certFile), key: readFileSync(certificates.keyFile) },
    (req, res) => {
      requests += 1
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    },
  )
  provider.on('tlsClientError', () => undefined)
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  return {
    port: (provider.address() as AddressInfo).port,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        provider.closeAllConnections()
        provider.close(() => resolve())
      }),
  }
}

/** The probe as a process under the network guard, with nothing but the given trust variable. */
function run(port: number, extraCaFile?: string) {
  return new Promise<{ result: Record<string, unknown>; refusals: string }>((resolve, reject) => {
    const refusals = join(tmpdir(), `raditi-guard-${randomUUID()}`)
    const guard = `${networkGuard}?report=${encodeURIComponent(refusals)}`
    const child = spawn(
      process.execPath,
      ['--import', guard, probe, String(port), certificates.certFile],
      {
        env: {
          PATH: process.env.PATH,
          ...(extraCaFile === undefined ? {} : { NODE_EXTRA_CA_CERTS: extraCaFile }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.once('error', reject)
    child.once('close', (code) => {
      const refused = existsSync(refusals) ? readFileSync(refusals, 'utf8') : ''
      rmSync(refusals, { force: true })
      if (code !== 0) return reject(new Error(`The probe exited with ${code}: ${stderr.trim()}`))
      resolve({ result: JSON.parse(stdout) as Record<string, unknown>, refusals: refused })
    })
  })
}

describe('provider TLS and the extra CA of a process', () => {
  // Two processes of Node are started; on a loaded machine one start alone takes seconds.
  it('refuses a provider that only NODE_EXTRA_CA_CERTS vouches for, while the default store of Node accepts it', async () => {
    const provider = await server()
    try {
      const { result, refusals } = await run(provider.port, certificates.certFile)
      expect(refusals).toBe('')
      expect(result).toEqual({
        // The control: the variable is read, and this very server passes Node's own trust.
        defaultStore: 'connected',
        transport: 'refused EgressNotSentError',
        // The control of the request: with the stand's CA named the same request is answered.
        standTransport: 'answered 200',
      })
      // The refused attempt ended in the handshake: the one request the server got is the
      // control's.
      expect(provider.requests()).toBe(1)
    } finally {
      await provider.close()
    }
  }, 30_000)

  it('refuses the same provider without the variable, where nothing vouches for it', async () => {
    const provider = await server()
    try {
      const { result, refusals } = await run(provider.port)
      expect(refusals).toBe('')
      expect(result).toEqual({
        defaultStore: 'refused',
        transport: 'refused EgressNotSentError',
        standTransport: 'answered 200',
      })
      expect(provider.requests()).toBe(1)
    } finally {
      await provider.close()
    }
  }, 30_000)
})
