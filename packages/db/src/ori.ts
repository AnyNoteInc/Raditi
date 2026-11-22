import type { Prisma, PrismaClient } from './generated/prisma/client.ts'

// The storage of an organiser of distribution of information (149-FZ, art. 10.1;
// docs/plan/88-artifacts.md, Ар56, slice 88.16а-1). Facts are kept 3 years after the action ends
// (Government Decree № 1526, p. 15), the messages of shared artifacts in full 6 months (Decree
// № 256, p. 3). Both journals are append only — a trigger refuses UPDATE and DELETE but the
// collector's — and are written in the transaction of the action. The content of a message is
// never in a fact (Decree № 1526, p. 4).

type Tx = Prisma.TransactionClient
const DAY_MS = 24 * 60 * 60 * 1000
export const oriTerms = { factsDays: 3 * 365 + 1, messagesDays: 183 } as const

export type OriFactKind =
  | 'register'
  | 'sign_in'
  | 'email_change'
  | 'account_deleted'
  | 'payment'
  | 'access_open'
  | 'access_grant'
  | 'artifact_write'
  | 'artifact_comment'

/** Where the request came from, as the edge told it; the port comes from the edge (88.16а-2). */
export interface OriOrigin {
  ip: string | null
  port?: number | null
}

const ipOf = (ip: string | null | undefined) => (ip && /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : null)

export async function recordOriFact(
  tx: Pick<Tx, '$executeRaw'>,
  input: {
    kind: OriFactKind
    userId: string | null
    origin?: OriOrigin | null
    artifactId?: string | null
    addressees?: readonly string[]
    detail?: Record<string, string | number | boolean>
    now?: Date
  },
): Promise<void> {
  const now = input.now ?? new Date()
  const keepUntil = new Date(now.getTime() + oriTerms.factsDays * DAY_MS)
  await tx.$executeRaw`
    INSERT INTO ori_facts (kind, user_id, ip, port, artifact_id, addressees, detail, keep_until)
    VALUES (${input.kind}, ${input.userId}::uuid, ${ipOf(input.origin?.ip)}::inet,
            ${input.origin?.port ?? null}::int, ${input.artifactId ?? null}::uuid,
            ${[...(input.addressees ?? [])]}::uuid[], ${JSON.stringify(input.detail ?? {})}::jsonb,
            ${keepUntil})`
}

/**
 * Who an artifact is shared with now: its owner and every holder of a live grant. Empty of others
 * — not shared, and its writes are no messages between users.
 */
export async function artifactAddressees(
  tx: Pick<Tx, '$queryRaw'>,
  artifactId: string,
): Promise<{ owner: string | null; others: string[] }> {
  const rows = await tx.$queryRaw<{ owner: string | null; others: string[] | null }[]>`
    SELECT d.owner_user_id AS owner,
           (SELECT array_agg(DISTINCT g.user_id) FROM artifact_grants g
            LEFT JOIN artifact_links l ON l.id = g.link_id
            WHERE g.artifact_id = d.id
              AND (g.source = 'invite'
                OR (l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()))))
             AS others
    FROM chat_documents d WHERE d.id = ${artifactId}::uuid`
  return { owner: rows[0]?.owner ?? null, others: rows[0]?.others ?? [] }
}

/**
 * The writes of one batch in an artifact opened to others: each operation in full as a message,
 * and one fact with the addressees — everyone with access but the writer. Nothing when the
 * artifact is not shared.
 */
export async function recordOriWrites(
  tx: Pick<Tx, '$executeRaw' | '$queryRaw'>,
  input: {
    artifactId: string
    userId: string | null
    taskId?: string | null
    origin?: OriOrigin | null
    ops: readonly { op: string; block?: string }[]
    now?: Date
  },
): Promise<void> {
  if (input.ops.length === 0) return
  const { owner, others } = await artifactAddressees(tx, input.artifactId)
  if (others.length === 0) return
  const now = input.now ?? new Date()
  const addressees = [...new Set([owner, ...others])].filter(
    (id): id is string => id !== null && id !== input.userId,
  )
  const keepUntil = new Date(now.getTime() + oriTerms.messagesDays * DAY_MS)
  for (const op of input.ops)
    await tx.$executeRaw`
      INSERT INTO ori_messages (artifact_id, user_id, task_id, block_key, kind, content, addressees, keep_until)
      VALUES (${input.artifactId}::uuid, ${input.userId}::uuid, ${input.taskId ?? null}::uuid,
              ${op.block ?? null}, ${op.op === 'delete' ? 'delete' : 'write'}, ${JSON.stringify(op)},
              ${addressees}::uuid[], ${keepUntil})`
  await recordOriFact(tx, {
    kind: 'artifact_write',
    userId: input.userId,
    origin: input.origin ?? null,
    artifactId: input.artifactId,
    addressees,
    detail: { operations: input.ops.length, ...(input.taskId ? { agent: true } : {}) },
    now,
  })
}

/**
 * Before an artifact goes for good: if it was ever opened to others, its last content stays
 * hidden 6 months as one message (Decree № 256) — nobody sees it in the product.
 */
export async function retainPurgedArtifacts(
  tx: Pick<Tx, '$executeRaw'>,
  artifactIds: readonly string[],
  now: Date = new Date(),
): Promise<number> {
  if (artifactIds.length === 0) return 0
  const keepUntil = new Date(now.getTime() + oriTerms.messagesDays * DAY_MS)
  return tx.$executeRaw`
    INSERT INTO ori_messages (artifact_id, user_id, kind, content, keep_until)
    SELECT d.id, d.owner_user_id, 'purge',
           (SELECT jsonb_agg(jsonb_build_object('block', s.section_key, 'kind', s.block_kind,
                   'content', COALESCE(s.content, s.markdown)) ORDER BY s.rank, s.section_key)::text
            FROM chat_document_sections s WHERE s.document_id = d.id AND s.deleted_rev IS NULL),
           ${keepUntil}
    FROM chat_documents d
    WHERE d.id = ANY(${[...artifactIds]}::uuid[])
      AND (EXISTS (SELECT 1 FROM artifact_grants g WHERE g.artifact_id = d.id)
        OR EXISTS (SELECT 1 FROM artifact_links l WHERE l.artifact_id = d.id))`
}

/** The collector: rows past their term go — the only DELETE the trigger lets through. */
export async function sweepOriJournals(
  db: Pick<PrismaClient, '$transaction'>,
  now: Date = new Date(),
): Promise<{ facts: number; messages: number }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('raditi.ori_sweep', 'on', true)`
    const facts = await tx.$executeRaw`DELETE FROM ori_facts WHERE keep_until < ${now}`
    const messages = await tx.$executeRaw`DELETE FROM ori_messages WHERE keep_until < ${now}`
    return { facts, messages }
  })
}

/** The operator's export of one user over a period (Decree № 1526, p. 3; plan 88, 88.16а-3). */
export async function exportOriJournals(
  db: Pick<PrismaClient, 'oriFact' | 'oriMessage'>,
  input: { userId: string; from: Date; to: Date; messages: boolean },
) {
  const where = { userId: input.userId, at: { gte: input.from, lt: input.to } }
  const facts = await db.oriFact.findMany({ where, orderBy: { at: 'asc' } })
  const messages = input.messages
    ? await db.oriMessage.findMany({ where, orderBy: { at: 'asc' } })
    : []
  return {
    facts: facts.map((fact) => ({ ...fact, id: String(fact.id), at: fact.at.toISOString() })),
    messages: messages.map((m) => ({ ...m, id: String(m.id), at: m.at.toISOString() })),
  }
}
