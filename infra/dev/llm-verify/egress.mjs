// Test-only destination wiring. The production proxy still checks host, port and mutual TLS.
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'

import { createEgressProxy, parseClientPins } from '../../egress/llm-egress.mjs'

const directory = process.argv[2]
if (!directory) throw new Error('Test proxy TLS directory is required')
const read = (name) => readFileSync(join(directory, name))
const server = createEgressProxy({
  tls: {
    key: read('server-key.pem'),
    cert: read('server.pem'),
    root: read('root.pem'),
    clientCa: read('client-ca.pem'),
  },
  allow: new Set(['api.z.ai:443']),
  clientCns: new Set(['b13-llm']),
  clientPins: parseClientPins(read('client-pins.txt').toString().trim()),
  // An injected public address passes the same production DNS policy, while the injected
  // dial has one fixed destination on an internal Docker network. No external socket exists.
  lookup: async () => ['104.18.32.47'],
  dial: () => connect(443, 'fake-subscriptions'),
  log: (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
})
server.listen(8443, '0.0.0.0')
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => server.close(() => process.exit(0)))
