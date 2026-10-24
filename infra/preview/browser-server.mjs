/* global console, process, setTimeout */
import { constants } from 'node:fs'
import { open, rename, writeFile } from 'node:fs/promises'
import { isIPv4 } from 'node:net'

// The agent's browser of a preview (docs/plan/53-chat-preview-release.md, Р21): Chromium behind
// Playwright's launchServer, its control socket on the browser's own network only, its path a
// secret the runtime writes into a tmpfs after start (Vault `kv/previews/<previewId>/browser`
// keeps it for the mcp role). No remote debugging port: Playwright talks to Chromium over a pipe.
// Every request of a page goes to the relay as an HTTP proxy, loopback names included; WebRTC
// sends nothing around it. The proxy is Playwright's launch option, not a bare Chromium flag, so
// requests of a context's own request API (the trusted read of a task's browser,
// docs/plan/57-browser-tasks.md, Б22) take the same way out as its pages.

export const STATE_DIR = '/run/raditi/browser'
export const SECRET_FILE = `${STATE_DIR}/ws-path`
export const READY_FILE = `${STATE_DIR}/ready`
export const WS_PATH = /^\/[A-Za-z0-9_-]{43,128}$/
const PROXY = /^http:\/\/(\d{1,3}(?:\.\d{1,3}){3}):([1-9]\d{0,4})$/

const valuePort = (text) => {
  const value = /^[1-9]\d{0,4}$/.test(text ?? '') ? Number(text) : 0
  return value <= 65_535 ? value : 0
}

/** `--host=<IPv4> --port=<n> --proxy=http://<IPv4>:<n>`, each once; null for anything else. */
export function parseArgs(argv) {
  const values = {}
  for (const arg of argv) {
    const [, name, value] = /^--(host|port|proxy)=(.+)$/.exec(arg) ?? []
    if (!name || values[name] !== undefined) return null
    values[name] = value
  }
  const proxy = PROXY.exec(values.proxy ?? '')
  const port = valuePort(values.port)
  if (!isIPv4(values.host ?? '') || !port || !proxy || !isIPv4(proxy[1]) || !valuePort(proxy[2]))
    return null
  return { host: values.host, port, proxy: values.proxy }
}

/**
 * The proxy as Playwright takes it: Chromium gets `--proxy-server` and `--proxy-bypass-list` from
 * it, and a context's request API sends through it too (a bare flag reaches Chromium alone).
 */
export function proxyOption(proxy) {
  // `<-loopback>`: without it Chromium sends *.localhost and 127.0.0.1 around the proxy, to
  // itself; the request API bypasses nothing it names.
  return { server: proxy, bypass: '<-loopback>' }
}

/** Chromium's other flags: no WebRTC around the proxy, nothing in the background. */
export function chromiumArgs() {
  return [
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--no-pings',
    '--disable-dev-shm-usage',
  ]
}

/** The secret path, once the runtime wrote it; never from an argument or the environment. */
export async function readSecret(path = SECRET_FILE) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 256) throw new Error('Invalid browser secret')
    const value = (await handle.readFile('utf8')).trim()
    if (!WS_PATH.test(value)) throw new Error('Invalid browser secret')
    return value
  } finally {
    await handle.close()
  }
}

async function waitForSecret(timeoutMs) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      return await readSecret()
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('No browser secret')
}

if (process.argv[1]?.endsWith('/server.mjs')) {
  const options = parseArgs(process.argv.slice(2))
  if (!options) {
    console.error('Usage: server.mjs --host=<IPv4> --port=<n> --proxy=http://<IPv4>:<n>')
    process.exit(2)
  }
  try {
    const wsPath = await waitForSecret(60_000)
    const { chromium } = await import('playwright-core')
    const server = await chromium.launchServer({
      host: options.host,
      port: options.port,
      wsPath,
      headless: true,
      proxy: proxyOption(options.proxy),
      args: chromiumArgs(),
      timeout: 60_000,
    })
    server.on('close', () => process.exit(0))
    await writeFile(`${READY_FILE}.tmp`, 'ready\n', { mode: 0o600 })
    await rename(`${READY_FILE}.tmp`, READY_FILE)
  } catch {
    // The message may carry the path: never print it.
    console.error('Preview browser could not start')
    process.exit(1)
  }
}
