#!/usr/bin/node
// Telegram from the single server (README.md, «Telegram»): api.telegram.org does not answer from
// this network, and the owner asked for a free proxy (08.11.2026). Free public HTTP proxies live for
// hours, so core never names one: it uses TELEGRAM_PROXY_URL=http://10.10.0.10:3129, this process.
// It accepts only `CONNECT api.telegram.org:443`, and chains it through a pool of public proxies
// it checked itself (a CONNECT that answered 200), refreshed every 20 minutes and when it runs low;
// a proxy that fails is dropped and the next one tried. TLS stays end to end between core and
// Telegram: a public proxy sees the host name only, never the bot's token or a lead.
import { connect } from 'node:net'
import { createServer } from 'node:http'
import process from 'node:process'

const LISTEN = { host: process.env.TELEGRAM_PROXY_HOST ?? '10.10.0.10', port: 3129 }
const TARGET = 'api.telegram.org:443'
const LIST =
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text&timeout=5000'
const POOL_SIZE = 8
const REFRESH_MS = 20 * 60_000
const log = (message) => console.log(`telegram-proxy: ${message}`)

let pool = []
let refreshing = null

/** A CONNECT through `proxy` to Telegram; resolves the socket once it answered 200. */
function tunnel(proxy, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const [host, port] = proxy.split(':')
    const socket = connect({ host, port: Number(port) })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('timeout'))
    }, timeoutMs)
    let head = Buffer.alloc(0)
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end < 0)
        return head.length > 8192 ? (socket.destroy(), reject(new Error('header'))) : undefined
      clearTimeout(timer)
      socket.off('data', onData)
      if (!/^HTTP\/1\.[01] 200/.test(head.subarray(0, end).toString('latin1'))) {
        socket.destroy()
        return reject(new Error('refused'))
      }
      resolve({ socket, rest: head.subarray(end + 4) })
    }
    socket.on('data', onData)
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.once('connect', () =>
      socket.write(`CONNECT ${TARGET} HTTP/1.1\r\nHost: ${TARGET}\r\n\r\n`),
    )
  })
}

async function refresh() {
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      const response = await fetch(LIST, { signal: AbortSignal.timeout(20_000) })
      const candidates = (await response.text())
        .split(/\s+/)
        .filter((line) => /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(line) && !pool.includes(line))
      const good = [...pool]
      // A few at a time: the list is long and most of it is dead
      for (let index = 0; index < candidates.length && good.length < POOL_SIZE; index += 20) {
        const batch = candidates.slice(index, index + 20)
        const results = await Promise.allSettled(batch.map((proxy) => tunnel(proxy)))
        results.forEach((result, at) => {
          if (result.status !== 'fulfilled') return
          result.value.socket.destroy()
          if (good.length < POOL_SIZE) good.push(batch[at])
        })
      }
      pool = good
      log(`pool of ${pool.length}`)
    } catch (error) {
      log(`refresh failed: ${error.message}`)
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

const server = createServer((_, response) => {
  response.writeHead(405).end()
})
server.on('connect', async (request, client, head) => {
  if (request.url !== TARGET) {
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }
  client.on('error', () => {})
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (pool.length === 0) await refresh()
    const proxy = pool[0]
    if (!proxy) break
    try {
      const { socket, rest } = await tunnel(proxy)
      client.write('HTTP/1.1 200 Connection established\r\n\r\n')
      if (rest.length) client.write(rest)
      if (head.length) socket.write(head)
      socket.pipe(client).pipe(socket)
      socket.on('error', () => client.destroy())
      client.on('close', () => socket.destroy())
      return
    } catch {
      pool = pool.filter((each) => each !== proxy)
      log(`dropped ${proxy}, ${pool.length} left`)
      if (pool.length < 2) refresh()
    }
  }
  client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
})

await refresh()
setInterval(refresh, REFRESH_MS).unref()
server.listen(LISTEN.port, LISTEN.host, () => log(`listening on ${LISTEN.host}:${LISTEN.port}`))
