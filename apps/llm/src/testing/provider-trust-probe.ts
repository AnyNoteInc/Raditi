// A process of its own, started by egress-trust.test.ts: Node reads NODE_EXTRA_CA_CERTS once,
// when a process starts. It tries one loopback TLS server three ways and prints what came of
// each, as one line of JSON. Erasable syntax only: Node loads this file as it is.
import process from 'node:process'
import { connect } from 'node:tls'

import { zaiCodingBackend } from '@repo/llm-backends'

import { createEgressTransport } from '../egress/egress.ts'

const port = Number(process.argv[2])
const standCaFile = process.argv[3]!
const { origin, requests } = zaiCodingBackend.egress[0]!
// A request the adapter declares: the transport sends no other.
const [method, url] = requests.find((request) => request.startsWith('GET '))!.split(' ') as [
  'GET',
  string,
]

/** Node's own trust: the default store of this process, the extra CA included. */
const defaultStore = await new Promise<string>((resolve) => {
  const socket = connect({ host: '127.0.0.1', port, servername: 'localhost' })
  socket.setTimeout(5000, () => {
    resolve('timeout')
    socket.destroy()
  })
  socket.once('secureConnect', () => {
    resolve('connected')
    socket.destroy()
  })
  socket.once('error', () => resolve('refused'))
})

/** The role's transport on its own connection to the origin, pointed at the loopback server. */
async function transport(upstreamCaFile: string | null): Promise<string> {
  const egress = createEgressTransport(
    {
      proxyUrl: null,
      upstreamCaFile,
      backendOrigins: new Map([[origin, `https://localhost:${port}`]]),
    },
    [zaiCodingBackend],
    { connectTimeoutMs: 5000 },
  )
  try {
    const answer = await egress.request(
      { url, method, headers: new Headers() },
      { signal: AbortSignal.timeout(10_000) },
    )
    answer.close()
    return `answered ${answer.status}`
  } catch (error) {
    return `refused ${error instanceof Error ? error.name : 'unknown'}`
  }
}

process.stdout.write(
  `${JSON.stringify({
    // Whether the extra CA of this process took effect is told by this control alone.
    defaultStore,
    // No CA of a stand: the provider's certificate is verified as in production.
    transport: await transport(null),
    // The same request with the stand's CA named: the request itself is one the server answers.
    standTransport: await transport(standCaFile),
  })}\n`,
)
process.exit(0)
