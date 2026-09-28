// A TCP server that speaks just enough RESP for ioredis and BullMQ to become ready. Every
// other command is left without an answer, like a Redis that is hanging or going away.
// Only for *.test.ts files (excluded from the build).
import { createServer, type Socket } from 'node:net'

const INFO = '# Server\r\nredis_version:7.4.0\r\nloading:0\r\nmaxmemory_policy:noeviction\r\n'

/** One RESP array of bulk strings from the start of `buffer`; undefined until it is complete. */
function parseCommand(buffer: string): { args: string[]; length: number } | undefined {
  let end = buffer.indexOf('\r\n')
  if (!buffer.startsWith('*') || end < 0) return undefined
  const count = Number(buffer.slice(1, end))
  let pos = end + 2
  const args: string[] = []
  for (let i = 0; i < count; i++) {
    end = buffer.indexOf('\r\n', pos)
    if (end < 0) return undefined
    const start = end + 2
    const size = Number(buffer.slice(pos + 1, end))
    if (buffer.length < start + size + 2) return undefined
    args.push(buffer.slice(start, start + size))
    pos = start + size + 2
  }
  return { args, length: pos }
}

function reply(command: string): string | undefined {
  switch (command.toLowerCase()) {
    case 'info':
      return `$${INFO.length}\r\n${INFO}\r\n`
    case 'ping':
      return '+PONG\r\n'
    case 'client':
    case 'select':
      return '+OK\r\n'
    case 'hset':
      return ':1\r\n'
    case 'hello':
      // ioredis 6 negotiates RESP3; simple replies below are valid in both protocols.
      return '%3\r\n+server\r\n+redis\r\n+version\r\n+7.4.0\r\n+proto\r\n:3\r\n'
    default:
      return undefined
  }
}

export interface FakeRedis {
  url: string
  /** Commands received so far, by name. */
  commands: string[]
  /** Drops every connection and stops listening: Redis is gone. */
  stop(): Promise<void>
}

export async function startFakeRedis(): Promise<FakeRedis> {
  const sockets = new Set<Socket>()
  const commands: string[] = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    // latin1 keeps one character per byte, so RESP lengths match string lengths.
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      for (let parsed = parseCommand(buffer); parsed; parsed = parseCommand(buffer)) {
        buffer = buffer.slice(parsed.length)
        const name = parsed.args[0] ?? ''
        commands.push(name.toLowerCase())
        const answer = reply(name)
        if (answer !== undefined) socket.write(answer)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no TCP address')
  return {
    url: `redis://127.0.0.1:${address.port}`,
    commands,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
