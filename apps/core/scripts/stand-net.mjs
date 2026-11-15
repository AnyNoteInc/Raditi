// Network helpers of the stands of this app: a free loopback port and the gateway of a bridge.
import assert from 'node:assert/strict'
import { createServer as createTcpServer, isIP } from 'node:net'

const LOOPBACK = '127.0.0.1'

/** A port nobody listens on at this moment, on loopback. */
export async function freePort() {
  const server = createTcpServer()
  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/**
 * The address the containers of a stand reach the host by on a native Linux engine: the gateway
 * of the default bridge. Docker Desktop forwards that name to the host's loopback instead.
 */
export function bridgeGatewayAddress(inspected) {
  const address = String(inspected).trim()
  const octets = address.split('.').map(Number)
  assert(
    isIP(address) === 4 &&
      (octets[0] === 10 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168)),
    'The Docker bridge gateway must be a private IPv4 address',
  )
  return address
}
