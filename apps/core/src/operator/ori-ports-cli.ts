import { createPrismaClient, dbConfigFromEnv, recordOriFactPorts, type OriEdgePort } from '@repo/db'
import type { Env } from '@repo/domain'
import { z } from 'zod'

// The collector of the ports of the facts of the ORI (Government Decree № 1526, p. 3;
// docs/plan/88-artifacts.md, slice 88.16а-2). The host's timer pipes the new access lines of the
// edge from journald into it (infra/server/host/ori-ports.sh):
//
//   journalctl … -o json | docker compose exec -T core node --env-file=/run/raditi/app.env \
//     scripts/ori-ports.mjs
//
// Docker splits a line over 16 KB into parts in journald (CONTAINER_PARTIAL_*): a client may make a
// line that long on purpose, so the parts are joined before a line is read.
//
// Only `downstream_X-Raditi-Fact` — the header web answered with — is read: a request header of
// the same name is whatever a client sent. Nothing of a line but the keys, the port and the time
// is kept or printed. Environment: DATABASE_URL.

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const lineSchema = z.object({
  'downstream_X-Raditi-Fact': z.string().max(4096),
  ClientPort: z.coerce.number().int().min(0).max(65535),
  StartUTC: z.string().min(1).max(64),
})

const HEADER = 'downstream_X-Raditi-Fact'

/** The pairs «key → port» of one access line of the edge; null — a line with the header unread. */
function portsOfLine(line: string): OriEdgePort[] | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  const parsed = lineSchema.safeParse(value)
  if (!parsed.success) return null
  const edgeAt = new Date(parsed.data.StartUTC)
  if (Number.isNaN(edgeAt.getTime())) return null
  const ports: OriEdgePort[] = []
  for (const key of parsed.data[HEADER].split(',')) {
    const edgeKey = key.trim().toLowerCase()
    if (KEY.test(edgeKey)) ports.push({ edgeKey, port: parsed.data.ClientPort, edgeAt })
  }
  return ports
}

/** The pairs «key → port» of the access lines of the edge; any other line is skipped. */
export function parseOriEdgeLines(text: string): OriEdgePort[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.includes(HEADER))
    .flatMap((line) => portsOfLine(line) ?? [])
}

const entrySchema = z.object({
  MESSAGE: z.union([z.string(), z.array(z.number().int().min(0).max(255))]),
  CONTAINER_PARTIAL_MESSAGE: z.string().optional(),
  CONTAINER_PARTIAL_ID: z.string().max(128).optional(),
  CONTAINER_PARTIAL_ORDINAL: z.coerce.number().int().min(0).optional(),
  CONTAINER_PARTIAL_LAST: z.string().optional(),
})

const MAX_LINE = 1024 * 1024

/**
 * The entries of journald (`-o json`, one a line) as the edge wrote them: the parts of a long line
 * joined in their order. `unread` counts lines with the header that gave nothing — broken, or
 * parts whose end is not here — for the operator to see a loss.
 */
export function parseOriJournal(text: string): { ports: OriEdgePort[]; unread: number } {
  const messages: string[] = []
  const parts = new Map<string, { ordinal: number; text: string }[]>()
  let unread = 0
  const decoder = new TextDecoder()
  for (const raw of text.split('\n')) {
    if (!raw.trim().startsWith('{')) continue
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      if (raw.includes(HEADER)) unread += 1
      continue
    }
    const entry = entrySchema.safeParse(value)
    if (!entry.success) continue
    const message =
      typeof entry.data.MESSAGE === 'string'
        ? entry.data.MESSAGE
        : decoder.decode(Uint8Array.from(entry.data.MESSAGE))
    const id = entry.data.CONTAINER_PARTIAL_ID
    if (entry.data.CONTAINER_PARTIAL_MESSAGE !== 'true' || id === undefined) {
      messages.push(message)
      continue
    }
    const group = parts.get(id) ?? []
    group.push({ ordinal: entry.data.CONTAINER_PARTIAL_ORDINAL ?? group.length + 1, text: message })
    parts.set(id, group)
    if (entry.data.CONTAINER_PARTIAL_LAST === 'true') {
      parts.delete(id)
      const line = group
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((part) => part.text)
        .join('')
      if (line.length <= MAX_LINE) messages.push(line)
      else if (line.includes(HEADER)) unread += 1
    }
  }
  // A line whose last part is not in this read is lost: counted when it carried the header.
  for (const group of parts.values())
    if (group.some((part) => part.text.includes(HEADER))) unread += 1
  const ports: OriEdgePort[] = []
  for (const message of messages) {
    const line = message.trim()
    if (!line.startsWith('{') || !line.includes(HEADER)) continue
    const found = portsOfLine(line)
    if (found === null) unread += 1
    else ports.push(...found)
  }
  return { ports, unread }
}

const BATCH = 500

export async function runOriPorts(
  input: AsyncIterable<string | Uint8Array>,
  env: Env = process.env,
  write: (text: string) => void = (text) => void process.stdout.write(text),
): Promise<void> {
  let text = ''
  const decoder = new TextDecoder()
  for await (const chunk of input)
    text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
  text += decoder.decode()
  const { ports, unread } = parseOriJournal(text)
  let config
  try {
    config = dbConfigFromEnv(env)
  } catch (error) {
    throw new Error('Окружение задано неверно: нужен DATABASE_URL.', { cause: error })
  }
  const prisma = createPrismaClient({ ...config, log: [] })
  try {
    let kept = 0
    for (let at = 0; at < ports.length; at += BATCH)
      kept += await recordOriFactPorts(prisma, ports.slice(at, at + BATCH))
    // Counts only: no key, port or address leaves the command.
    write(`${JSON.stringify({ read: ports.length, kept, unread })}\n`)
  } catch (error) {
    throw new Error('Порты не перенесены. Проверьте доступность базы данных.', { cause: error })
  } finally {
    await prisma.$disconnect().catch(() => undefined)
  }
}
