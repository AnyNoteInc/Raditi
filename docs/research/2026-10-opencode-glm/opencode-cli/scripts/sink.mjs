// Runs inside a helper container on the internal network. It is the only thing the CLI container can reach:
//   UDP/TCP 53  answers every A query with its own address and logs the name (so every wanted host shows up)
//   TCP 443     logs the SNI of the TLS ClientHello and closes
//   TCP 80      logs the request line and Host, answers 403
//   TCP 8080    forwards to the recording proxy on the host (host.docker.internal:<PROXY_PORT>)
// It holds no secret. Log lines go to stdout as JSON.
import dgram from 'node:dgram'
import net from 'node:net'

const SELF = process.env.SINK_IP
const PROXY_HOST = process.env.PROXY_HOST || 'host.docker.internal'
const PROXY_PORT = Number(process.env.PROXY_PORT)
const out = (record) => console.log(JSON.stringify({ at: new Date().toISOString(), ...record }))

function parseQuestion(message) {
  let offset = 12
  const labels = []
  while (offset < message.length) {
    const length = message[offset]
    if (length === 0) {
      offset += 1
      break
    }
    labels.push(message.subarray(offset + 1, offset + 1 + length).toString('latin1'))
    offset += 1 + length
  }
  const type = message.readUInt16BE(offset)
  return { name: labels.join('.'), type, end: offset + 4 }
}
function answer(message) {
  const question = parseQuestion(message)
  const header = Buffer.from(message.subarray(0, 12))
  header[2] = 0x81
  header[3] = 0x80 // response, recursion available, NOERROR
  header.writeUInt16BE(1, 4)
  const body = message.subarray(12, question.end)
  let answers = Buffer.alloc(0)
  if (question.type === 1) {
    answers = Buffer.concat([
      Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 5, 0, 4]),
      Buffer.from(SELF.split('.').map(Number)),
    ])
    header.writeUInt16BE(1, 6)
  } else header.writeUInt16BE(0, 6)
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(0, 10)
  return { question, reply: Buffer.concat([header, body, answers]) }
}
const udp = dgram.createSocket('udp4')
udp.on('message', (message, remote) => {
  try {
    const { question, reply } = answer(message)
    out({ kind: 'dns', name: question.name, type: question.type, from: remote.address })
    udp.send(reply, remote.port, remote.address)
  } catch (error) {
    out({ kind: 'dns-error', error: String(error?.message) })
  }
})
udp.bind(53, '0.0.0.0')
net
  .createServer((socket) => {
    socket.once('data', (data) => {
      try {
        const { question, reply } = answer(data.subarray(2))
        out({
          kind: 'dns-tcp',
          name: question.name,
          type: question.type,
          from: socket.remoteAddress,
        })
        const length = Buffer.alloc(2)
        length.writeUInt16BE(reply.length)
        socket.end(Buffer.concat([length, reply]))
      } catch {
        socket.destroy()
      }
    })
    socket.on('error', () => {})
  })
  .listen(53, '0.0.0.0')

function sni(data) {
  try {
    if (data[0] !== 0x16) return undefined
    let offset = 5 + 4 + 2 + 32
    offset += 1 + data[offset] // session id
    offset += 2 + data.readUInt16BE(offset) // cipher suites
    offset += 1 + data[offset] // compression
    const end = offset + 2 + data.readUInt16BE(offset)
    offset += 2
    while (offset + 4 <= end) {
      const type = data.readUInt16BE(offset)
      const length = data.readUInt16BE(offset + 2)
      if (type === 0)
        return data
          .subarray(offset + 9, offset + 9 + data.readUInt16BE(offset + 7))
          .toString('latin1')
      offset += 4 + length
    }
  } catch {
    /* not a ClientHello */
  }
  return undefined
}
net
  .createServer((socket) => {
    socket.once('data', (data) => {
      out({ kind: 'tls', port: 443, sni: sni(data) ?? '(none)', from: socket.remoteAddress })
      socket.destroy()
    })
    socket.on('error', () => {})
  })
  .listen(443, '0.0.0.0')
net
  .createServer((socket) => {
    socket.once('data', (data) => {
      const head = data.toString('latin1').split('\r\n')
      out({
        kind: 'http',
        port: 80,
        line: head[0]?.slice(0, 200),
        host: head
          .find((line) => /^host:/i.test(line))
          ?.slice(5)
          .trim(),
        from: socket.remoteAddress,
      })
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    })
    socket.on('error', () => {})
  })
  .listen(80, '0.0.0.0')
net
  .createServer((client) => {
    const upstream = net.connect(PROXY_PORT, PROXY_HOST)
    client.pipe(upstream)
    upstream.pipe(client)
    const close = () => {
      client.destroy()
      upstream.destroy()
    }
    client.on('error', close)
    upstream.on('error', close)
    client.on('close', close)
    upstream.on('close', close)
  })
  .listen(8080, '0.0.0.0')
out({ kind: 'ready', self: SELF, proxy: `${PROXY_HOST}:${PROXY_PORT}` })
