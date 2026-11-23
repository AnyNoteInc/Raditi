import { artifactRole, type PrismaClient } from '@repo/db'
import {
  artifactAgentLabel,
  artifactNotFound,
  artifactSignalLimits,
  type ArtifactPresenceMark,
  type ArtifactSignal,
} from '@repo/domain/artifacts'

// The live channel of artifacts (docs/plan/88-artifacts.md, Ар20, §7.4; slice 88.5): web listens
// to Redis, core relays there what PostgreSQL said once a batch of operations committed; a signal
// says «read from your seq now». Presence lives in Redis alone, from web: a page marks itself every
// 15 s, a mark is gone after 30, nobody writes PostgreSQL for it. The agents a page shows are not
// marks but what PostgreSQL holds — a write waiting for its check, a claim (Ар17, Ар19).

/** Where the signals and the marks of artifacts live: Redis of web. */
export interface ArtifactSignals {
  /** Calls `listener` with every signal of the artifact and every `resync`, until unsubscribed. */
  subscribe(artifactId: string, listener: (signal: ArtifactSignal) => void): () => void
  /**
   * Marks the person present until `mark.until`; says `presence` on the artifact's channel when
   * the mark is new or names another block, so that a page that only renews itself stays quiet.
   */
  mark(artifactId: string, userId: string, mark: ArtifactPresenceMark): Promise<void>
  /** Removes the person's mark and says `presence`. */
  leave(artifactId: string, userId: string): Promise<void>
  /** The marks of the artifact, expired ones too: the reader drops those past `until`. */
  marks(artifactId: string): Promise<Map<string, ArtifactPresenceMark>>
}

type Db = Pick<PrismaClient, '$queryRaw' | 'user' | 'artifactBlock' | 'task'>

/** The ids the user may read now, in the order asked; refuses when there is none. */
async function readable(db: Db, userId: string, artifactIds: readonly string[]) {
  const allowed: string[] = []
  for (const artifactId of artifactIds)
    if ((await artifactRole(db, { artifactId, userId })) !== null) allowed.push(artifactId)
  return allowed
}

/**
 * `artifact.signals`: the signals of the artifacts one page watches (its tabs), for a reader who
 * may read them, from the moment of the request. The first one is `resync` — the page reads what
 * it missed while it connected. Every `recheckMs` the role is read again: an artifact the reader
 * lost — moved to the trash, taken down, its owner left the workspace — is no longer watched, and
 * the stream ends once none is left; the page goes on by its polls, which are refused.
 */
export async function* readArtifactSignals(
  db: Db,
  signals: ArtifactSignals,
  input: {
    userId: string
    artifactIds: readonly string[]
    signal?: AbortSignal
    recheckMs?: number
  },
): AsyncGenerator<{ artifactId: string | null; signal: ArtifactSignal }> {
  const asked = [...new Set(input.artifactIds.map((id) => id.toLowerCase()))]
  let watched = await readable(db, input.userId, asked)
  if (watched.length === 0) throw artifactNotFound()
  const recheckMs = input.recheckMs ?? artifactSignalLimits.recheckMs
  const queue: { artifactId: string | null; signal: ArtifactSignal }[] = []
  let wake: (() => void) | null = null
  const push = (artifactId: string | null, signal: ArtifactSignal) => {
    const key = signal === 'resync' ? null : artifactId
    if (!queue.some((each) => each.artifactId === key && each.signal === signal))
      queue.push({ artifactId: key, signal })
    wake?.()
  }
  const unsubscribes = new Map(
    watched.map((artifactId) => [
      artifactId,
      signals.subscribe(artifactId, (signal) => push(artifactId, signal)),
    ]),
  )
  const stop = () => wake?.()
  input.signal?.addEventListener('abort', stop)
  let checkedAt = Date.now()
  try {
    yield { artifactId: null, signal: 'resync' }
    while (!input.signal?.aborted) {
      if (queue.length === 0) {
        const left = Math.max(0, checkedAt + recheckMs - Date.now())
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left)
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
        wake = null
      }
      if (input.signal?.aborted) return
      if (Date.now() - checkedAt >= recheckMs) {
        const still = new Set(await readable(db, input.userId, watched))
        for (const artifactId of watched)
          if (!still.has(artifactId)) {
            unsubscribes.get(artifactId)?.()
            unsubscribes.delete(artifactId)
          }
        watched = watched.filter((artifactId) => still.has(artifactId))
        if (watched.length === 0) return
        checkedAt = Date.now()
      }
      while (queue.length > 0) {
        const next = queue.shift()!
        if (next.artifactId === null || unsubscribes.has(next.artifactId)) yield next
      }
    }
  } finally {
    for (const unsubscribe of unsubscribes.values()) unsubscribe()
    input.signal?.removeEventListener('abort', stop)
  }
}

export interface ArtifactPresence {
  people: { userId: string; name: string; block: string | null; self: boolean }[]
  /** People past the first `presencePeople`. */
  morePeople: number
  /**
   * The agents at work in it, by chat: the blocks they write or hold. Another person's chat is
   * never named (Ар21); an intent shows only once core checked it (Ар19).
   */
  agents: { label: string; own: boolean; blocks: { key: string; intent: string | null }[] }[]
}

/** Who has the artifact open now and which agents write in it, for a reader who may read it. */
export async function artifactPresence(
  db: Db,
  signals: ArtifactSignals,
  input: { userId: string; artifactId: string; now?: Date },
): Promise<ArtifactPresence> {
  const now = (input.now ?? new Date()).getTime()
  if ((await artifactRole(db, { artifactId: input.artifactId, userId: input.userId })) === null)
    throw artifactNotFound()
  const marks = [...(await signals.marks(input.artifactId))].filter(([, mark]) => mark.until > now)
  const users = await db.user.findMany({
    where: { id: { in: marks.map(([userId]) => userId) } },
    select: { id: true, name: true },
  })
  const names = new Map(users.map((user) => [user.id, user.name]))
  // A mark of someone who has no row any longer is nobody.
  const people = marks
    .filter(([userId]) => names.has(userId))
    .map(([userId, mark]) => ({
      userId,
      name: names.get(userId) ?? '',
      block: mark.block,
      self: userId === input.userId,
    }))
    .sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name, 'ru'))
  const limit = artifactSignalLimits.presencePeople
  const blocks = await db.artifactBlock.findMany({
    where: {
      documentId: input.artifactId,
      deletedRev: null,
      OR: [
        { pendingTaskId: { not: null } },
        { leaseHolder: 'agent', leaseUntil: { gt: new Date(now) } },
      ],
    },
    select: {
      sectionKey: true,
      pendingTaskId: true,
      leaseHolder: true,
      leaseTaskId: true,
      leaseIntent: true,
      leaseIntentChecked: true,
    },
    orderBy: { sectionKey: 'asc' },
  })
  const byChat = new Map<string, { key: string; intent: string | null }[]>()
  for (const block of blocks) {
    const taskId = block.pendingTaskId ?? block.leaseTaskId
    if (taskId === null) continue
    const intent =
      block.leaseHolder === 'agent' && block.leaseIntentChecked ? block.leaseIntent : null
    byChat.set(taskId, [...(byChat.get(taskId) ?? []), { key: block.sectionKey, intent }])
  }
  const chats = await db.task.findMany({
    where: { id: { in: [...byChat.keys()] } },
    select: { id: true, title: true, createdById: true, createdBy: { select: { name: true } } },
  })
  const agents = chats
    .map((chat) => {
      const own = chat.createdById === input.userId
      return {
        label: own && chat.title ? chat.title : artifactAgentLabel(chat.createdBy?.name ?? ''),
        own,
        blocks: byChat.get(chat.id) ?? [],
      }
    })
    .sort((a, b) => Number(b.own) - Number(a.own) || a.label.localeCompare(b.label, 'ru'))
  return { people: people.slice(0, limit), morePeople: Math.max(0, people.length - limit), agents }
}

/**
 * The page is here (`artifact.here`, every 15 s): its mark lasts `presenceTtlMs`, and it reads who
 * else is, so that a departure nobody signals is seen at the next mark.
 */
export async function markArtifactPresence(
  db: Db,
  signals: ArtifactSignals,
  input: { userId: string; artifactId: string; block: string | null; now?: Date },
): Promise<ArtifactPresence> {
  const now = input.now ?? new Date()
  if ((await artifactRole(db, { artifactId: input.artifactId, userId: input.userId })) === null)
    throw artifactNotFound()
  await signals.mark(input.artifactId, input.userId, {
    block: input.block,
    until: now.getTime() + artifactSignalLimits.presenceTtlMs,
  })
  return artifactPresence(db, signals, { ...input, now })
}

/** The page is closed (`artifact.leave`): its mark goes now, for a reader who may read it. */
export async function leaveArtifact(
  db: Db,
  signals: ArtifactSignals,
  input: { userId: string; artifactId: string },
): Promise<void> {
  if ((await artifactRole(db, { artifactId: input.artifactId, userId: input.userId })) === null)
    throw artifactNotFound()
  await signals.leave(input.artifactId, input.userId)
}
