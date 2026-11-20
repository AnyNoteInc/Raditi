import { createHash, randomBytes } from 'node:crypto'

import {
  assembleDocMarkdown,
  isDomainError,
  secretInContent,
  type PageRefusalReason,
} from '@repo/domain'
import {
  applyQuoteEdit,
  artifactBatchHasSecretShape,
  artifactBatchProblem,
  artifactBatchSchema,
  artifactBlockContentProblem,
  artifactBlockHeld,
  artifactBlockPlacementProblem,
  artifactCellProblem,
  artifactDataClass,
  artifactDataClassAllows,
  artifactIntentSchema,
  artifactTitleSchema,
  artifactColumnsSchema,
  artifactFindMany,
  artifactFindNone,
  artifactForbidden,
  artifactKindKnown,
  artifactKindRefused,
  artifactKindSpecOf,
  artifactKindSpecs,
  artifactLeaseLost,
  artifactLimit,
  artifactLimits,
  artifactNotFound,
  artifactOpInvalid,
  artifactOpReused,
  artifactPropsProblem,
  artifactRoleCan,
  artifactSecretShape,
  artifactStale,
  artifactTooLarge,
  type ArtifactAction,
  type ArtifactBatch,
  type ArtifactBlockKind,
  type ArtifactCells,
  type ArtifactColumn,
  type ArtifactDataClass,
  type ArtifactHoldReason,
  type ArtifactKind,
  type ArtifactOp,
  type ArtifactProps,
  type ArtifactRole,
} from '@repo/domain/artifacts'

import { isArtifactRank, rankBetween, rankForIndex } from './artifact-rank.ts'
import { Prisma, type ArtifactBlock, type PrismaClient } from './generated/prisma/client.ts'
import { artifactBlockOrder, blockCheckedText, workspaceOwnerOf } from './pages.ts'

// Artifacts in the database (docs/plan/88-artifacts.md, Ар11–Ар19, §7.1–§7.3, §7.8, slice 88.3).
// The server is the authority: a batch of operations is checked by the rules of
// `@repo/domain/artifacts` before the transaction, then applied in one short transaction that takes
// the artifact's row FOR NO KEY UPDATE (for `seq`) and touches only the blocks it names. A person's
// write is checked as it is written and shown at once; the agent's write waits in `pending_*`
// under a new revision and holds the block for its chat until core checked it (Ар16, Ар19).

type Db = Pick<PrismaClient, '$transaction'>
type Tx = Prisma.TransactionClient

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const utf8 = (text: string | null | undefined) => Buffer.byteLength(text ?? '', 'utf8')
const DAY_MS = 24 * 60 * 60 * 1000

/** JSON with the keys of every object sorted: the hash of a batch and of a block's text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// ———————————————————————————————————————— who acts

/**
 * Who writes: a person in the cabinet, or a turn of a chat — the agent acts with the role of the
 * client of its chat (Ар21, Ар23); `scheduled` — a run of a scheduled task without supervision.
 */
export type ArtifactActor =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; taskId: string; turnNo: number; scheduled?: boolean }

interface ResolvedActor {
  kind: 'user' | 'agent'
  userId: string
  taskId: string | null
  turnNo: number | null
  journal: 'user' | 'agent' | 'schedule'
  /** The workspace of the agent's chat and its class of data; null for a person. */
  workspaceId: string | null
  dataClass: ArtifactDataClass | null
}

const person = (userId: string): ResolvedActor => ({
  kind: 'user',
  userId,
  taskId: null,
  turnNo: null,
  journal: 'user',
  workspaceId: null,
  dataClass: null,
})

async function resolveActor(tx: Tx, actor: ArtifactActor): Promise<ResolvedActor> {
  if (actor.kind === 'user') return person(actor.userId)
  if (!Number.isInteger(actor.turnNo) || actor.turnNo < 1) throw artifactForbidden()
  const task = await tx.task.findUnique({
    where: { id: actor.taskId },
    select: { createdById: true, workspaceId: true, workspace: { select: { dataClass: true } } },
  })
  if (!task?.createdById) throw artifactForbidden()
  return {
    kind: 'agent',
    userId: task.createdById,
    taskId: actor.taskId,
    turnNo: actor.turnNo,
    journal: actor.scheduled ? 'schedule' : 'agent',
    workspaceId: task.workspaceId,
    dataClass: task.workspace.dataClass,
  }
}

// ———————————————————————————————————————— access (§7.8)

/**
 * The role of a user on an artifact — the one function of every path (Ар37): the procedures of
 * the cabinet, `mcp` on each call, core when it applies and opens, every serving of `/v/`.
 * `owner` — its owner, alive and a member of its workspace (of a project's artifact — the project's
 * author too); null — no access: deleted (unless `trashed` for the trash itself), taken down, or
 * left without its owner. The grants of other people come with slice 88.16 (Ар34): until then
 * only the owner has a role.
 */
export async function artifactRole(
  db: Pick<PrismaClient, '$queryRaw'>,
  input: { artifactId: string; userId: string; trashed?: boolean },
): Promise<ArtifactRole | null> {
  const rows = await db.$queryRaw<
    { owner: string | null; deleted: boolean; taken_down: boolean; member: boolean }[]
  >`
    SELECT o.owner,
           d.deleted_at IS NOT NULL AS deleted,
           d.taken_down_at IS NOT NULL AS taken_down,
           EXISTS (SELECT 1 FROM members m
                   WHERE m.workspace_id = d.workspace_id AND m.user_id = o.owner)
             AND (d.project_id IS NULL OR EXISTS (
                   SELECT 1 FROM projects p WHERE p.id = d.project_id AND p.created_by_id = o.owner))
             AS member
    FROM chat_documents d
    CROSS JOIN LATERAL (SELECT COALESCE(d.owner_user_id, (
      SELECT m.user_id FROM members m WHERE m.workspace_id = d.workspace_id AND m.role = 'owner'
      ORDER BY m.created_at, m.id LIMIT 1)) AS owner) o
    WHERE d.id = ${input.artifactId}::uuid`
  const row = rows[0]
  if (!row || row.owner === null || !row.member || row.taken_down) return null
  if (row.deleted && !input.trashed) return null
  return row.owner === input.userId ? 'owner' : null
}

/**
 * The role an actor needs, or the refusal. The agent of a chat acts with its client's role, and —
 * until the artifacts attached to a chat of slice 88.17 — only in its chat's workspace; the data
 * of a client never go to a synthetic turn (§7.8, Ар23).
 */
async function requireRole(
  tx: Tx,
  artifactId: string,
  actor: ResolvedActor,
  action: ArtifactAction,
  trashed = false,
): Promise<ArtifactRole> {
  const role = await artifactRole(tx, { artifactId, userId: actor.userId, trashed })
  // No access and «not there» are never told apart (ARTIFACT_NOT_FOUND).
  if (role === null) throw artifactNotFound()
  if (actor.kind === 'agent') {
    const artifact = await tx.artifact.findUniqueOrThrow({
      where: { id: artifactId },
      select: { workspaceId: true, workspace: { select: { dataClass: true } } },
    })
    if (artifact.workspaceId !== actor.workspaceId) throw artifactNotFound()
    if (!artifactDataClassAllows(actor.dataClass ?? 'synthetic', artifact.workspace.dataClass))
      throw artifactDataClass()
  }
  if (!artifactRoleCan(role, action)) throw artifactForbidden()
  return role
}

async function lockArtifact(tx: Tx, artifactId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM chat_documents WHERE id = ${artifactId}::uuid FOR NO KEY UPDATE`
  if (rows.length === 0) throw artifactNotFound()
  return tx.artifact.findUniqueOrThrow({ where: { id: artifactId } })
}

type LockedArtifact = Awaited<ReturnType<typeof lockArtifact>>

// ———————————————————————————————————————— blocks as an actor sees them

type Props = Record<string, string | number | boolean>

const asProps = (value: Prisma.JsonValue | null): Props =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Props) : {}

/** The checked properties, with the heading a section of the code before keeps in its column. */
function checkedProps(block: ArtifactBlock): Props {
  const props = asProps(block.props)
  return block.blockKind === 'section' && block.heading !== null && props.heading === undefined
    ? { heading: block.heading, ...props }
    : props
}

const ownsPending = (block: ArtifactBlock, actor: ResolvedActor) =>
  actor.kind === 'agent' && block.pendingTaskId !== null && block.pendingTaskId === actor.taskId

/** The checked text: the one rule of `readChatDocument` too (`blockCheckedText`). */
const checkedText = (block: ArtifactBlock): string | null => blockCheckedText(block)

/** What this actor reads of a block: its own chat's unchecked write, otherwise the checked one. */
function seenText(block: ArtifactBlock, actor: ResolvedActor): string | null {
  if (ownsPending(block, actor)) return block.pendingContent ?? checkedText(block)
  // The agent reads what its chat wrote with the tools of plan 69 before the check, too.
  if (actor.kind === 'agent' && block.writtenTaskId === actor.taskId && block.markdown !== null)
    return block.markdown
  return checkedText(block)
}

function seenProps(block: ArtifactBlock, actor: ResolvedActor): Props {
  return ownsPending(block, actor) && block.pendingProps !== null
    ? asProps(block.pendingProps)
    : checkedProps(block)
}

const live = (until: Date | null, now: Date) => until !== null && until.getTime() > now.getTime()

/** Why this actor may not write the block now; null — it may (Ар16, Ар17, §7.2). */
function holdOf(block: ArtifactBlock, actor: ResolvedActor, now: Date) {
  const key = block.sectionKey
  if (block.leaseHolder === 'human' && live(block.leaseUntil, now) && actor.kind === 'agent')
    // A person took this chat's write: its claim is lost, not merely held.
    return block.leaseTaskId === actor.taskId
      ? artifactLeaseLost(key)
      : artifactBlockHeld(key, 'human')
  if (
    block.leaseHolder === 'agent' &&
    live(block.leaseUntil, now) &&
    !(actor.kind === 'agent' && block.leaseTaskId === actor.taskId)
  )
    return artifactBlockHeld(key, 'claim')
  if (block.pendingTaskId !== null && !ownsPending(block, actor))
    return artifactBlockHeld(key, 'checking')
  return null
}

/** Who holds a block now, for a reader: a person, a write being checked, a claim; null — no one. */
export function artifactBlockHold(block: ArtifactBlock, now: Date): ArtifactHoldReason | null {
  if (block.pendingTaskId !== null) return 'checking'
  if (block.leaseHolder === 'human' && live(block.leaseUntil, now)) return 'human'
  if (block.leaseHolder === 'agent' && live(block.leaseUntil, now)) return 'claim'
  return null
}

// ———————————————————————————————————————— revisions (Ар13)

interface RevisionDraft {
  blockKey: string
  rev: number
  blockKind: string
  parentKey: string | null
  rank: string
  deleted: boolean
  content: string | null
  props: Props
  writtenByUserId: string | null
  taskId: string | null
  turnNo: number | null
}

const revisionHash = (content: string | null, props: Props) =>
  sha256(canonicalJson({ content, props }))

/**
 * The revisions as they are: the text and properties of a hash are kept once per artifact — on
 * the first revision that carried them; the others name it by `sha256`.
 */
async function writeRevisions(
  tx: Tx,
  artifactId: string,
  drafts: readonly RevisionDraft[],
): Promise<void> {
  if (drafts.length === 0) return
  const hashes = drafts.map((draft) => revisionHash(draft.content, draft.props))
  const kept = await tx.$queryRaw<{ sha256: string }[]>`
    SELECT sha256 FROM artifact_block_revisions
    WHERE artifact_id = ${artifactId}::uuid AND props IS NOT NULL AND sha256 = ANY(${[...new Set(hashes)]})`
  const held = new Set(kept.map((row) => row.sha256))
  await tx.artifactBlockRevision.createMany({
    data: drafts.map((draft, index) => {
      const hash = hashes[index]!
      const first = !held.has(hash)
      held.add(hash)
      return {
        artifactId,
        blockKey: draft.blockKey,
        rev: draft.rev,
        sha256: hash,
        blockKind: draft.blockKind,
        parentKey: draft.parentKey,
        rank: draft.rank,
        deleted: draft.deleted,
        content: first ? draft.content : null,
        props: first ? draft.props : Prisma.DbNull,
        writtenByUserId: draft.writtenByUserId,
        taskId: draft.taskId,
        turnNo: draft.turnNo,
      }
    }),
    skipDuplicates: true,
  })
}

function revisionOf(
  block: ArtifactBlock,
  author: { userId: string | null; taskId: string | null; turnNo: number | null },
): RevisionDraft {
  return {
    blockKey: block.sectionKey,
    rev: block.rev,
    blockKind: block.blockKind,
    parentKey: block.parentKey,
    rank: block.rank ?? rankForIndex(block.position),
    deleted: block.deletedRev !== null,
    content: checkedText(block),
    props: checkedProps(block),
    writtenByUserId: author.userId,
    taskId: author.taskId,
    turnNo: author.turnNo,
  }
}

// ———————————————————————————————————————— rows of the code before (Ар11)

/**
 * What the code before plan 88 leaves unfilled or stale while the new one is rolled out —
 * repeatable, as the migration did it (Ар11): the owner (the owner of the workspace); the ranks of
 * a document that only the tools of plan 69 ever wrote — it has no line of the journal — whenever
 * a rank is missing or the order of ranks is not the order of positions that code keeps; and the
 * checked text in `content` of a section that code checked. A document the operations of plan 88
 * wrote is ordered by its ranks alone. `documentId` — one document only.
 */
export async function fillArtifactRows(
  db: Pick<PrismaClient, '$executeRaw'>,
  documentId: string | null = null,
): Promise<number> {
  const owners = await db.$executeRaw`
    UPDATE chat_documents AS d
    SET owner_user_id = COALESCE(
      (SELECT m.user_id FROM members m WHERE m.workspace_id = d.workspace_id AND m.role = 'owner'
       ORDER BY m.created_at, m.id LIMIT 1),
      (SELECT w.created_by_id FROM workspaces w WHERE w.id = d.workspace_id))
    WHERE d.owner_user_id IS NULL
      AND (${documentId}::uuid IS NULL OR d.id = ${documentId}::uuid)`
  const ranks = await db.$executeRaw`
    WITH ordered AS (
      SELECT id, document_id, rank,
             row_number() OVER (PARTITION BY document_id ORDER BY position, id) AS by_position,
             row_number() OVER (PARTITION BY document_id
                                ORDER BY rank COLLATE "C" NULLS FIRST, id) AS by_rank
      FROM chat_document_sections
      WHERE (${documentId}::uuid IS NULL OR document_id = ${documentId}::uuid)
    ), stale AS (
      SELECT DISTINCT o.document_id FROM ordered o
      WHERE (o.rank IS NULL OR o.by_position <> o.by_rank)
        AND NOT EXISTS (SELECT 1 FROM artifact_ops j WHERE j.artifact_id = o.document_id)
    )
    UPDATE chat_document_sections AS s
    SET rank = substr('0123456789abcdefghijklmnopqrstuvwxyz', ((o.by_position - 1) / 1296)::int % 36 + 1, 1)
      || substr('0123456789abcdefghijklmnopqrstuvwxyz', ((o.by_position - 1) / 36)::int % 36 + 1, 1)
      || substr('0123456789abcdefghijklmnopqrstuvwxyz', (o.by_position - 1)::int % 36 + 1, 1) || 'i'
    FROM ordered o JOIN stale USING (document_id)
    WHERE o.id = s.id AND s.rank IS DISTINCT FROM
      substr('0123456789abcdefghijklmnopqrstuvwxyz', ((o.by_position - 1) / 1296)::int % 36 + 1, 1)
      || substr('0123456789abcdefghijklmnopqrstuvwxyz', ((o.by_position - 1) / 36)::int % 36 + 1, 1)
      || substr('0123456789abcdefghijklmnopqrstuvwxyz', (o.by_position - 1)::int % 36 + 1, 1) || 'i'`
  const contents = await db.$executeRaw`
    UPDATE chat_document_sections
    SET content = markdown, rev = GREATEST(rev, 1)
    WHERE state = 'written' AND checked_turn IS NOT NULL AND markdown IS NOT NULL
      AND written_by_user_id IS NULL AND pending_task_id IS NULL AND deleted_rev IS NULL
      AND content IS DISTINCT FROM markdown
      AND (${documentId}::uuid IS NULL OR document_id = ${documentId}::uuid)`
  return owners + ranks + contents
}

// ———————————————————————————————————————— create

export interface ArtifactCreate {
  workspaceId: string
  kind: string
  title: string
  projectId?: string | null
  actor: ArtifactActor
  now?: Date
}

/**
 * A new artifact in a workspace, owned by its owner. The kind must be known; whether its view has
 * shipped (`artifactReleasedKinds`) is the gate of the tool and the procedure that call this. The
 * agent's title is its text: it waits for the check under the kind's name (Ар19).
 */
export async function createArtifact(
  db: Db,
  input: ArtifactCreate,
): Promise<{ id: string; seq: number }> {
  if (!artifactKindKnown(input.kind)) throw artifactKindRefused(input.kind)
  const kind: ArtifactKind = input.kind
  return db.$transaction(async (tx) => {
    const actor = await resolveActor(tx, input.actor)
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM workspaces WHERE id = ${input.workspaceId}::uuid FOR NO KEY UPDATE`
    if (locked.length === 0) throw artifactNotFound()
    const owner = await workspaceOwnerOf(tx, input.workspaceId)
    // Until the grants of 88.16 the owner of the workspace is the one who creates in it.
    if (owner === null || owner !== actor.userId) throw artifactForbidden()
    if (actor.taskId !== null) {
      const task = await tx.task.findUnique({
        where: { id: actor.taskId },
        select: { workspaceId: true },
      })
      if (task?.workspaceId !== input.workspaceId) throw artifactForbidden()
      const creates = await tx.artifactOp.count({
        where: { taskId: actor.taskId, turnNo: actor.turnNo, kind: 'create' },
      })
      if (creates >= artifactLimits.agentCreatesPerTurn) throw artifactLimit('agentCreatesPerTurn')
    }
    if (input.projectId) {
      const project = await tx.project.findFirst({
        where: {
          id: input.projectId,
          workspaceId: input.workspaceId,
          createdById: owner,
          deletedAt: null,
        },
        select: { id: true },
      })
      if (!project) throw artifactNotFound()
    }
    const count = await tx.artifact.count({
      where: { workspaceId: input.workspaceId, deletedAt: null },
    })
    if (count >= artifactLimits.workspaceArtifacts) throw artifactLimit('workspaceArtifacts')
    const parsedTitle = artifactTitleSchema.safeParse(input.title.trim())
    if (!parsedTitle.success) throw artifactOpInvalid('the title is one line of 1–200 characters')
    const title = parsedTitle.data
    if (actor.kind === 'user' && secretInContent(title)) throw artifactSecretShape()
    const agent = actor.kind === 'agent'
    const created = await tx.artifact.create({
      data: {
        workspaceId: input.workspaceId,
        taskId: actor.taskId,
        projectId: input.projectId ?? null,
        ownerUserId: owner,
        kind,
        title: agent ? artifactKindSpecs[kind].label : title,
        ...(agent
          ? {
              pendingTitle: title,
              pendingTaskId: actor.taskId,
              pendingTurn: actor.turnNo,
              pendingTitleAt: new Date(),
            }
          : {}),
        seq: 1,
        ...(actor.taskId !== null
          ? { chats: { create: { taskId: actor.taskId, how: 'created' } } }
          : {}),
      },
      select: { id: true },
    })
    await tx.artifactOp.create({
      data: {
        artifactId: created.id,
        seq: 1,
        actor: actor.journal,
        userId: actor.userId,
        taskId: actor.taskId,
        turnNo: actor.turnNo,
        kind: 'create',
        result: agent ? 'checking' : 'applied',
      },
    })
    return { id: created.id, seq: 1 }
  })
}

// ———————————————————————————————————————— the batch (§7.2)

export interface ArtifactOpsAnswer {
  artifactId: string
  opId: string
  /** The `seq` of the artifact after the batch. */
  seq: number
  /** Each block the batch changed: its new revision; `checking` — the agent's write waits for core. */
  blocks: { key: string; rev: number; state: 'applied' | 'checking' | 'deleted' }[]
  title: 'applied' | 'checking' | null
  /** True — the same batch came again and got the answer it got the first time (Ар14). */
  repeated: boolean
}

interface Work {
  block: ArtifactBlock
  isNew: boolean
  dirty: boolean
  /** The block was not there (or a tombstone) before the batch: a refusal of the check drops it. */
  inserted: boolean
}

const serverKey = () =>
  `b${BigInt(`0x${randomBytes(8).toString('hex')}`)
    .toString(36)
    .slice(0, 11)}`

/**
 * Applies a batch of operations (Ар14–Ар19, §7.2) atomically, or refuses all of it.
 *
 * - The batch is checked by `@repo/domain/artifacts` first: its schema, its bounds by author, a
 *   person's text in the form of a secret (`ARTIFACT_SECRET_SHAPE`).
 * - The role is `edit` at least (`artifactRole`); the agent acts with its chat's client's.
 * - The same `opId` with the same SHA-256 of the canonical batch gets the stored answer; with
 *   another hash — `ARTIFACT_OP_REUSED`. A refused batch keeps nothing: its repeat is judged again.
 * - `replace`, `move` and `delete` need `ifRev` equal to the block's revision (`ARTIFACT_STALE`
 *   with the current block); `edit` replaces exactly one occurrence of a quote in the text the
 *   actor reads (`ARTIFACT_FIND_NONE`, `ARTIFACT_FIND_MANY`); `props` and `cells` win as the last.
 * - A block a person types in is held for 30 s by a lease of `human`: the agent gets
 *   `ARTIFACT_BLOCK_HELD` (`human`), or `ARTIFACT_LEASE_LOST` when that person took this chat's
 *   write. An agent's claim holds it for others (`claim`); an agent's write being checked holds it
 *   for everyone but its chat (`checking`) — a person takes it with `takeArtifactBlock`.
 * - A person's write is the block's checked content at once, with a revision. The agent's write of
 *   text goes to `pending_*` under a new revision and waits for `settleArtifactWrites`; structure
 *   and values (`move`, `delete`, `props`) carry no text and apply at once (Ар15, Ар19).
 * - Every operation is a line of the journal `artifact_ops` (without text): its insert signals
 *   `raditi_artifact`, so the batch notifies once.
 */
export async function applyArtifactOps(
  db: Db,
  input: { batch: unknown; actor: ArtifactActor; now?: Date },
): Promise<ArtifactOpsAnswer> {
  const parsed = artifactBatchSchema.safeParse(input.batch)
  if (!parsed.success)
    throw artifactOpInvalid(parsed.error.issues[0]?.message ?? 'the batch does not parse')
  const batch = parsed.data
  const author = input.actor.kind === 'user' ? 'cabinet' : 'agent'
  const problem = artifactBatchProblem(batch, author)
  if (problem !== null)
    throw problem.code === 'ARTIFACT_TOO_LARGE'
      ? artifactTooLarge(problem.problem)
      : artifactOpInvalid(problem.problem)
  if (input.actor.kind === 'user' && artifactBatchHasSecretShape(batch)) throw artifactSecretShape()
  const hash = sha256(canonicalJson(batch))
  const now = input.now ?? new Date()
  return db.$transaction(async (tx) => {
    const actor = await resolveActor(tx, input.actor)
    const artifact = await lockArtifact(tx, batch.artifactId)
    await requireRole(tx, artifact.id, actor, 'edit')
    const earlier = await tx.artifactBatch.findUnique({
      where: { artifactId_opId: { artifactId: artifact.id, opId: scopedOpId(actor, batch.opId) } },
    })
    if (earlier) {
      if (earlier.sha256 !== hash) throw artifactOpReused(batch.opId)
      return {
        ...(earlier.answer as unknown as Omit<ArtifactOpsAnswer, 'repeated'>),
        repeated: true,
      }
    }
    if (actor.kind === 'agent') await checkTurnBounds(tx, artifact.id, actor, batch.ops.length)
    return new BatchRun(tx, artifact, actor, now, batch, hash).run()
  })
}

/**
 * The key a batch is kept by: its `opId` within its author — a person or a chat — so two chats
 * whose models made up the same id never take each other's answer (Ар14).
 */
function scopedOpId(actor: ResolvedActor, opId: string): string {
  return sha256(
    `${actor.taskId === null ? `user:${actor.userId}` : `task:${actor.taskId}`}\n${opId}`,
  )
}

async function checkTurnBounds(
  tx: Tx,
  artifactId: string,
  actor: ResolvedActor,
  writes: number,
): Promise<void> {
  const [row] = await tx.$queryRaw<{ writes: bigint; artifacts: bigint; here: boolean }[]>`
    SELECT count(*) FILTER (WHERE kind <> 'create' AND result IN ('applied', 'checking')) AS writes,
           count(DISTINCT artifact_id) AS artifacts,
           bool_or(artifact_id = ${artifactId}::uuid) AS here
    FROM artifact_ops
    WHERE task_id = ${actor.taskId}::uuid AND turn_no = ${actor.turnNo} AND actor <> 'user'`
  if (Number(row?.writes ?? 0) + writes > artifactLimits.agentWritesPerTurn)
    throw artifactLimit('agentWritesPerTurn')
  if (!row?.here && Number(row?.artifacts ?? 0) >= artifactLimits.agentArtifactsPerTurn)
    throw artifactLimit('agentArtifactsPerTurn')
}

class BatchRun {
  readonly #work = new Map<string, Work>()
  readonly #siblings = new Map<string, { key: string; rank: string }[]>()
  readonly #journal: Prisma.ArtifactOpCreateManyInput[] = []
  readonly #revisions: RevisionDraft[] = []
  readonly #kind: ArtifactKind
  #columns: ArtifactColumn[] | null | undefined
  #counts: { rows: number; blocks: number } | undefined
  #bytes: bigint
  #seq: bigint
  #title: 'applied' | 'checking' | null = null
  #titleData: Prisma.ArtifactUpdateInput = {}

  private readonly tx: Tx
  private readonly artifact: LockedArtifact
  private readonly actor: ResolvedActor
  private readonly now: Date
  private readonly batch: ArtifactBatch
  private readonly hash: string

  constructor(
    tx: Tx,
    artifact: LockedArtifact,
    actor: ResolvedActor,
    now: Date,
    batch: ArtifactBatch,
    hash: string,
  ) {
    this.tx = tx
    this.artifact = artifact
    this.actor = actor
    this.now = now
    this.batch = batch
    this.hash = hash
    if (!artifactKindKnown(artifact.kind)) throw artifactKindRefused(artifact.kind)
    this.#kind = artifact.kind
    this.#bytes = artifact.bytes
    this.#seq = artifact.seq
  }

  get #agent() {
    return this.actor.kind === 'agent'
  }

  async run(): Promise<ArtifactOpsAnswer> {
    await this.#rankUnranked()
    await this.#load()
    for (const op of this.batch.ops) await this.#apply(op)
    return this.#flush()
  }

  /** A document only the tools of plan 69 wrote is put in order of its positions first (Ар11). */
  async #rankUnranked(): Promise<void> {
    await fillArtifactRows(this.tx, this.artifact.id)
  }

  async #load(): Promise<void> {
    const keys = new Set<string>()
    for (const op of this.batch.ops) {
      if ('block' in op && op.block !== undefined) keys.add(op.block)
      if ('parent' in op && op.parent !== undefined) keys.add(op.parent)
      if ('after' in op && op.after !== null) keys.add(op.after)
    }
    const rows = await this.tx.artifactBlock.findMany({
      where: { documentId: this.artifact.id, sectionKey: { in: [...keys] } },
    })
    for (const block of rows)
      this.#work.set(block.sectionKey, { block, isNew: false, dirty: false, inserted: false })
  }

  #live(key: string): Work | undefined {
    const work = this.#work.get(key)
    return work && work.block.deletedRev === null ? work : undefined
  }

  #need(key: string): Work {
    const work = this.#live(key)
    if (!work) throw artifactOpInvalid(`no block ${key}`, { block: key })
    return work
  }

  #hold(work: Work): void {
    const held = holdOf(work.block, this.actor, this.now)
    if (held) throw held
  }

  #stale(work: Work, ifRev: number): void {
    if (work.block.rev === ifRev) return
    throw artifactStale({
      block: work.block.sectionKey,
      rev: work.block.rev,
      kind: work.block.blockKind,
      content: seenText(work.block, this.actor),
      props: seenProps(work.block, this.actor),
    })
  }

  async #siblingsOf(parent: string | null): Promise<{ key: string; rank: string }[]> {
    const id = parent ?? ''
    let list = this.#siblings.get(id)
    if (!list) {
      const rows = await this.tx.artifactBlock.findMany({
        where: { documentId: this.artifact.id, parentKey: parent, deletedRev: null },
        select: { sectionKey: true, rank: true },
      })
      list = rows
        .map((row) => ({ key: row.sectionKey, rank: row.rank ?? '' }))
        .filter((row) => !this.#work.has(row.key) || this.#live(row.key) !== undefined)
      // Blocks this batch already moved or inserted under this parent are counted as they are now.
      for (const [key, work] of this.#work)
        if (
          work.block.deletedRev === null &&
          work.block.parentKey === parent &&
          !list.some((row) => row.key === key)
        )
          list.push({ key, rank: work.block.rank ?? '' })
      list = list.filter((row) => {
        const work = this.#work.get(row.key)
        return !work || (work.block.deletedRev === null && work.block.parentKey === parent)
      })
      list.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
      this.#siblings.set(id, list)
    }
    return list
  }

  /** A rank after `after` (null — first) among the children of `parent`, and the block placed there. */
  async #place(key: string, parent: string | null, after: string | null): Promise<string> {
    const list = (await this.#siblingsOf(parent)).filter((row) => row.key !== key)
    let index = 0
    if (after !== null) {
      const at = list.findIndex((row) => row.key === after)
      if (at === -1) throw artifactOpInvalid(`block ${after} is not beside it`, { block: after })
      index = at + 1
    }
    const low = index > 0 ? list[index - 1]!.rank : null
    const high = index < list.length ? list[index]!.rank : null
    const rank = rankBetween(
      low && isArtifactRank(low) ? low : null,
      high && isArtifactRank(high) ? high : null,
    )
    list.splice(index, 0, { key, rank })
    this.#siblings.set(parent ?? '', list)
    return rank
  }

  #leaveSiblings(key: string, parent: string | null): void {
    const list = this.#siblings.get(parent ?? '')
    if (list)
      this.#siblings.set(
        parent ?? '',
        list.filter((row) => row.key !== key),
      )
  }

  #parentKind(parent: string | undefined): ArtifactBlockKind | null {
    if (parent === undefined) return null
    const work = this.#need(parent)
    return work.block.blockKind as ArtifactBlockKind
  }

  async #countsOf(): Promise<{ rows: number; blocks: number }> {
    if (!this.#counts) {
      const rows = await this.tx.artifactBlock.groupBy({
        by: ['blockKind'],
        where: { documentId: this.artifact.id, deletedRev: null },
        _count: { _all: true },
      })
      const all = rows.reduce((sum, row) => sum + row._count._all, 0)
      const tableRows = rows.find((row) => row.blockKind === 'row')?._count._all ?? 0
      this.#counts = { rows: tableRows, blocks: all - tableRows }
    }
    return this.#counts
  }

  async #columnsOf(): Promise<ArtifactColumn[] | null> {
    if (this.#columns === undefined) {
      const inBatch = [...this.#work.values()].find(
        (work) => work.block.blockKind === 'columns' && work.block.deletedRev === null,
      )
      const block =
        inBatch?.block ??
        (await this.tx.artifactBlock.findFirst({
          where: { documentId: this.artifact.id, blockKind: 'columns', deletedRev: null },
        }))
      const text = block ? seenText(block, this.actor) : null
      const parsed = text === null ? null : artifactColumnsSchema.safeParse(safeJson(text))
      this.#columns = parsed?.success ? parsed.data : null
    }
    return this.#columns
  }

  /** Content of a block checked by its kind; a row's cells — by the columns of the table too. */
  async #checkContent(kind: ArtifactBlockKind, content: string): Promise<void> {
    const problem = artifactBlockContentProblem(kind, content)
    if (problem === 'too_large') throw artifactTooLarge('blockBytes')
    if (problem !== null) throw artifactOpInvalid(`the content of a ${kind}: ${problem}`)
    if (kind === 'columns') this.#columns = undefined
    if (kind === 'row') await this.#checkCells(safeJson(content) as ArtifactCells)
    if (!this.#agent && secretInContent(content)) throw artifactSecretShape()
  }

  async #checkCells(cells: ArtifactCells): Promise<void> {
    const columns = await this.#columnsOf()
    if (columns === null) throw artifactOpInvalid('the table has no columns yet')
    for (const [key, value] of Object.entries(cells)) {
      const column = columns.find((each) => each.key === key)
      if (!column) throw artifactOpInvalid(`no column ${key}`, { column: key })
      const problem = artifactCellProblem(column, value)
      if (problem !== null) throw artifactOpInvalid(`cell ${key}: ${problem}`, { column: key })
    }
  }

  #checkProps(kind: ArtifactBlockKind, props: ArtifactProps, mode: 'values' | 'texts' | 'all') {
    const problem = artifactPropsProblem(kind, props, mode)
    if (problem !== null) throw artifactOpInvalid(`the properties of a ${kind}: ${problem}`)
  }

  #journalLine(
    op: string,
    key: string | null,
    baseRev: number | null,
    newRev: number | null,
    result: 'applied' | 'checking',
    before?: Prisma.InputJsonValue,
  ): void {
    this.#seq += 1n
    this.#journal.push({
      artifactId: this.artifact.id,
      seq: this.#seq,
      actor: this.actor.journal,
      userId: this.actor.userId,
      taskId: this.actor.taskId,
      turnNo: this.actor.turnNo,
      kind: op,
      blockKey: key,
      baseRev,
      newRev,
      result,
      ...(before !== undefined ? { before } : {}),
    })
  }

  #author() {
    return this.#agent
      ? { userId: null, taskId: this.actor.taskId, turnNo: this.actor.turnNo }
      : { userId: this.actor.userId, taskId: null, turnNo: null }
  }

  /**
   * The revision of a block as others see it now. A block with the agent's write pending gets
   * none: the check writes the revision of that write (`settleArtifactWrites`).
   */
  #revision(work: Work): void {
    if (work.block.pendingTaskId !== null) return
    this.#revisions.push(revisionOf(work.block, this.#author()))
  }

  /** A person's lease while typing (Ар17): renewed by each write, the taken chat remembered. */
  #humanLease(block: ArtifactBlock): Partial<ArtifactBlock> {
    const own = block.leaseHolder === 'human' && block.leaseUserId === this.actor.userId
    return {
      leaseHolder: 'human',
      leaseUserId: this.actor.userId,
      leaseTaskId: own ? block.leaseTaskId : null,
      leaseTurn: own ? block.leaseTurn : null,
      leaseToken: null,
      leaseIntent: null,
      leaseUntil: new Date(this.now.getTime() + artifactLimits.humanLeaseSeconds * 1000),
    }
  }

  /** Writes text and properties as this actor writes them: checked at once, or pending (Ар19). */
  #writeText(work: Work, content: string, props: Props): 'applied' | 'checking' {
    const block = work.block
    if (block.blockKind === 'section' && typeof props.heading !== 'string')
      throw artifactOpInvalid(`section ${block.sectionKey} needs its heading`, {
        block: block.sectionKey,
      })
    const rev = block.rev + 1
    if (this.#agent) {
      Object.assign(block, {
        rev,
        pendingContent: content,
        pendingProps: props,
        pendingTaskId: this.actor.taskId,
        pendingTurn: this.actor.turnNo,
        pendingAt: this.now,
      } satisfies Partial<ArtifactBlock>)
      work.dirty = true
      return 'checking'
    }
    const section = block.blockKind === 'section'
    this.#bytes += BigInt(utf8(content) - utf8(checkedText(block)))
    Object.assign(block, {
      rev,
      content,
      props,
      heading: section ? (props.heading as string) : null,
      // The code before reads a section's Markdown until release 2.
      markdown: section ? content : null,
      state: 'written',
      writtenByUserId: this.actor.userId,
      writtenTaskId: null,
      writtenTurn: null,
      checkedTurn: null,
      refusal: null,
      ...this.#humanLease(block),
    } satisfies Partial<ArtifactBlock>)
    work.dirty = true
    this.#revision(work)
    return 'applied'
  }

  async #apply(op: ArtifactOp): Promise<void> {
    switch (op.op) {
      case 'insert':
        return this.#insert(op)
      case 'replace': {
        const work = this.#need(op.block)
        this.#hold(work)
        this.#stale(work, op.ifRev)
        const kind = work.block.blockKind as ArtifactBlockKind
        if (op.props) this.#checkProps(kind, op.props, 'texts')
        await this.#checkContent(kind, op.content)
        const base = work.block.rev
        const result = this.#writeText(work, op.content, {
          ...seenProps(work.block, this.actor),
          ...op.props,
        })
        this.#journalLine('replace', op.block, base, work.block.rev, result, this.#before(base))
        return
      }
      case 'edit': {
        const work = this.#need(op.block)
        this.#hold(work)
        const text = seenText(work.block, this.actor)
        if (text === null) throw artifactFindNone(op.block)
        const edited = applyQuoteEdit(text, op.find, op.replace)
        if (!edited.ok)
          throw edited.code === 'ARTIFACT_FIND_NONE'
            ? artifactFindNone(op.block)
            : artifactFindMany(op.block, edited.count)
        await this.#checkContent(work.block.blockKind as ArtifactBlockKind, edited.text)
        const base = work.block.rev
        const result = this.#writeText(work, edited.text, seenProps(work.block, this.actor))
        this.#journalLine('edit', op.block, base, work.block.rev, result, this.#before(base))
        return
      }
      case 'move': {
        const work = this.#need(op.block)
        this.#hold(work)
        this.#stale(work, op.ifRev)
        const parent = op.parent ?? null
        const problem = artifactBlockPlacementProblem(
          this.#kind,
          work.block.blockKind as ArtifactBlockKind,
          this.#parentKind(op.parent),
        )
        if (problem !== null) throw artifactOpInvalid(`block ${op.block} cannot stand there`)
        if (parent === op.block) throw artifactOpInvalid(`block ${op.block} cannot hold itself`)
        await this.#siblingsOf(work.block.parentKey)
        this.#leaveSiblings(op.block, work.block.parentKey)
        const base = work.block.rev
        work.block.parentKey = parent
        work.block.rank = await this.#place(op.block, parent, op.after)
        work.block.rev = base + 1
        work.dirty = true
        this.#revision(work)
        this.#journalLine('move', op.block, base, work.block.rev, 'applied')
        return
      }
      case 'delete': {
        const work = this.#need(op.block)
        this.#hold(work)
        this.#stale(work, op.ifRev)
        const children = await this.tx.artifactBlock.findMany({
          where: { documentId: this.artifact.id, parentKey: op.block, deletedRev: null },
        })
        for (const child of children) {
          const known = this.#work.get(child.sectionKey)
          const each = known ?? { block: child, isNew: false, dirty: false, inserted: false }
          if (!known) this.#work.set(child.sectionKey, each)
          if (each.block.deletedRev === null) this.#tombstone(each)
        }
        this.#tombstone(work)
        return
      }
      case 'props': {
        const work = this.#need(op.block)
        this.#hold(work)
        const kind = work.block.blockKind as ArtifactBlockKind
        this.#checkProps(kind, op.props, 'values')
        const base = work.block.rev
        // Values carry no text: they are checked props at once, and of a pending write too.
        work.block.props = { ...checkedProps(work.block), ...op.props }
        if (work.block.pendingProps !== null)
          work.block.pendingProps = { ...asProps(work.block.pendingProps), ...op.props }
        work.block.rev = base + 1
        work.dirty = true
        this.#revision(work)
        this.#journalLine('props', op.block, base, work.block.rev, 'applied')
        return
      }
      case 'title':
        return this.#retitle(op.title)
      case 'cells': {
        const work = this.#need(op.block)
        if (work.block.blockKind !== 'row')
          throw artifactOpInvalid(`block ${op.block} is not a row`)
        this.#hold(work)
        await this.#checkCells(op.cells)
        const cells = { ...(safeJson(seenText(work.block, this.actor) ?? '{}') as Props) }
        for (const [key, value] of Object.entries(op.cells)) {
          if (value === null) delete cells[key]
          else cells[key] = value
        }
        const content = JSON.stringify(cells)
        await this.#checkContent('row', content)
        const base = work.block.rev
        const result = this.#writeText(work, content, seenProps(work.block, this.actor))
        this.#journalLine('cells', op.block, base, work.block.rev, result, this.#before(base))
        return
      }
    }
  }

  /** The image «before» of an unchecked write of the agent: only its revision (§7.1). */
  #before(rev: number): Prisma.InputJsonValue | undefined {
    return this.#agent ? { rev } : undefined
  }

  async #insert(op: Extract<ArtifactOp, { op: 'insert' }>): Promise<void> {
    let key = op.block
    if (key === undefined) {
      do key = serverKey()
      while (this.#work.has(key))
    }
    const existing = this.#work.get(key)
    if (existing && existing.block.deletedRev === null)
      throw artifactOpInvalid(`block ${key} is there already`, { block: key })
    if (existing === undefined && op.block === undefined) {
      const taken = await this.tx.artifactBlock.findUnique({
        where: { documentId_sectionKey: { documentId: this.artifact.id, sectionKey: key } },
        select: { id: true },
      })
      if (taken) return this.#insert(op)
    }
    const parentKind = this.#parentKind(op.parent)
    if (artifactBlockPlacementProblem(this.#kind, op.kind, parentKind) !== null)
      throw artifactOpInvalid(`a ${op.kind} cannot stand there`, { block: key })
    const counts = await this.#countsOf()
    if (op.kind === 'row') {
      if (counts.rows >= artifactLimits.tableRows) throw artifactLimit('tableRows')
      counts.rows += 1
    } else {
      if (counts.blocks >= artifactLimits.blocks) throw artifactLimit('blocks')
      counts.blocks += 1
    }
    const props = op.props ?? {}
    this.#checkProps(op.kind, props, 'all')
    const content = op.content ?? (['row', 'settings', 'chart'].includes(op.kind) ? '{}' : '')
    await this.#checkContent(op.kind, content)
    const parent = op.parent ?? null
    const rank = await this.#place(key, parent, op.after)
    const rev = (existing?.block.rev ?? 0) + 1
    const block: ArtifactBlock = {
      ...(existing?.block ?? emptyBlock(this.artifact.id, key)),
      position: 0,
      rank,
      parentKey: parent,
      blockKind: op.kind,
      rev: rev - 1,
      heading: null,
      markdown: null,
      content: null,
      props: {},
      state: 'pending',
      intent: '',
      writtenTaskId: null,
      writtenTurn: null,
      writtenByUserId: null,
      checkedTurn: null,
      refusal: null,
      pendingContent: null,
      pendingProps: null,
      pendingTaskId: null,
      pendingTurn: null,
      pendingAt: null,
      leaseHolder: null,
      leaseUserId: null,
      leaseTaskId: null,
      leaseTurn: null,
      leaseToken: null,
      leaseUntil: null,
      leaseIntent: null,
      deletedRev: null,
    }
    const work: Work = { block, isNew: existing === undefined, dirty: true, inserted: true }
    this.#work.set(key, work)
    // The agent's intent is its text too: it is shown with the write, once checked (Ар19).
    if (this.#agent && op.intent !== undefined) {
      block.leaseIntent = op.intent
      block.leaseIntentChecked = false
    } else if (op.intent !== undefined) block.intent = op.intent
    const result = this.#writeText(work, content, props)
    this.#journalLine('insert', key, null, block.rev, result)
  }

  #tombstone(work: Work): void {
    const block = work.block
    const base = block.rev
    this.#bytes -= BigInt(utf8(checkedText(block)))
    if (this.#counts) {
      if (block.blockKind === 'row') this.#counts.rows -= 1
      else this.#counts.blocks -= 1
    }
    this.#leaveSiblings(block.sectionKey, block.parentKey)
    Object.assign(block, {
      rev: base + 1,
      deletedRev: base + 1,
      pendingContent: null,
      pendingProps: null,
      pendingTaskId: null,
      pendingTurn: null,
      pendingAt: null,
      leaseHolder: null,
      leaseUserId: null,
      leaseTaskId: null,
      leaseTurn: null,
      leaseToken: null,
      leaseUntil: null,
      leaseIntent: null,
      leaseIntentChecked: false,
    } satisfies Partial<ArtifactBlock>)
    work.dirty = true
    this.#revision(work)
    this.#journalLine('delete', block.sectionKey, base, block.rev, 'applied')
  }

  #retitle(title: string): void {
    const pending = this.artifact.pendingTaskId
    if (this.#agent) {
      if (pending !== null && pending !== this.actor.taskId)
        throw artifactBlockHeld('title', 'checking')
      this.#titleData = {
        pendingTitle: title,
        pendingTaskId: this.actor.taskId,
        pendingTurn: this.actor.turnNo,
        pendingTitleAt: this.now,
      }
      this.#title = 'checking'
    } else {
      // A person's title wins over the agent's unchecked one (Ар17).
      this.#titleData = {
        title,
        pendingTitle: null,
        pendingTaskId: null,
        pendingTurn: null,
        pendingTitleAt: null,
      }
      this.#title = 'applied'
    }
    this.#journalLine('title', null, null, null, this.#title)
  }

  async #flush(): Promise<ArtifactOpsAnswer> {
    const projected = [...this.#work.values()].reduce(
      (sum, work) =>
        work.block.pendingContent !== null
          ? sum +
            BigInt(Math.max(0, utf8(work.block.pendingContent) - utf8(checkedText(work.block))))
          : sum,
      this.#bytes,
    )
    if (projected > BigInt(artifactLimits.artifactBytes)) throw artifactTooLarge('artifactBytes')
    const fresh: Prisma.ArtifactBlockCreateManyInput[] = []
    for (const work of this.#work.values()) {
      if (!work.dirty) continue
      const { id, documentId, ...data } = work.block
      const row = {
        ...data,
        props: data.props as Prisma.InputJsonValue,
        pendingProps:
          data.pendingProps === null ? Prisma.DbNull : (data.pendingProps as Prisma.InputJsonValue),
      }
      if (work.isNew) fresh.push({ ...row, documentId })
      else await this.tx.artifactBlock.update({ where: { id }, data: row })
    }
    if (fresh.length > 0) await this.tx.artifactBlock.createMany({ data: fresh })
    await writeRevisions(this.tx, this.artifact.id, this.#revisions)
    const blocks = [...this.#work.values()]
      .filter((work) => work.dirty)
      .map((work) => ({
        key: work.block.sectionKey,
        rev: work.block.rev,
        state:
          work.block.deletedRev !== null
            ? ('deleted' as const)
            : work.block.pendingTaskId !== null
              ? ('checking' as const)
              : ('applied' as const),
      }))
    const answer: Omit<ArtifactOpsAnswer, 'repeated'> = {
      artifactId: this.artifact.id,
      opId: this.batch.opId,
      seq: Number(this.#seq),
      blocks,
      title: this.#title,
    }
    const saved = await this.tx.artifactBatch.create({
      data: {
        artifactId: this.artifact.id,
        opId: scopedOpId(this.actor, this.batch.opId),
        sha256: this.hash,
        answer: answer as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
    await this.tx.artifactOp.createMany({
      data: this.#journal.map((line) => ({ ...line, batchId: saved.id })),
    })
    await this.tx.artifact.update({
      where: { id: this.artifact.id },
      data: { ...this.#titleData, seq: this.#seq, bytes: this.#bytes, revision: { increment: 1 } },
    })
    if (this.actor.taskId !== null)
      await touchChat(this.tx, this.artifact.id, this.actor.taskId, 'edited')
    return { ...answer, repeated: false }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function emptyBlock(documentId: string, key: string): ArtifactBlock {
  return {
    id: '',
    documentId,
    sectionKey: key,
    position: 0,
    rank: null,
    heading: null,
    markdown: null,
    intent: '',
    state: 'pending',
    writtenTaskId: null,
    writtenTurn: null,
    checkedTurn: null,
    refusal: null,
    parentKey: null,
    blockKind: 'section',
    props: {},
    rev: 0,
    content: null,
    pendingContent: null,
    pendingProps: null,
    pendingTaskId: null,
    pendingTurn: null,
    pendingAt: null,
    leaseHolder: null,
    leaseUserId: null,
    leaseTaskId: null,
    leaseTurn: null,
    leaseToken: null,
    leaseUntil: null,
    leaseIntent: null,
    leaseIntentChecked: false,
    writtenByUserId: null,
    deletedRev: null,
  }
}

async function touchChat(
  tx: Tx,
  artifactId: string,
  taskId: string,
  how: 'created' | 'edited',
): Promise<void> {
  await tx.artifactChat.upsert({
    where: { artifactId_taskId: { artifactId, taskId } },
    create: { artifactId, taskId, how },
    update: { lastAt: new Date() },
  })
}

// ———————————————————————————————————————— leases (Ар16, Ар17)

/**
 * «Забрать правку» (Ар16, Ар17): a person takes a block the agent writes or claimed. The agent's
 * unchecked write is dropped, the block gets a person's lease that remembers the chat it was taken
 * from: that chat's next write gets `ARTIFACT_LEASE_LOST`.
 */
export async function takeArtifactBlock(
  db: Db,
  input: { artifactId: string; block: string; userId: string; now?: Date },
): Promise<{ rev: number }> {
  const now = input.now ?? new Date()
  return db.$transaction(async (tx) => {
    const artifact = await lockArtifact(tx, input.artifactId)
    await requireRole(tx, artifact.id, person(input.userId), 'edit')
    const block = await tx.artifactBlock.findUnique({
      where: { documentId_sectionKey: { documentId: artifact.id, sectionKey: input.block } },
    })
    if (!block || block.deletedRev !== null)
      throw artifactOpInvalid(`no block ${input.block}`, { block: input.block })
    const taken =
      block.pendingTaskId !== null
        ? { taskId: block.pendingTaskId, turn: block.pendingTurn }
        : block.leaseHolder === 'agent' && live(block.leaseUntil, now)
          ? { taskId: block.leaseTaskId, turn: block.leaseTurn }
          : null
    const rev = block.rev + 1
    await tx.artifactBlock.update({
      where: { id: block.id },
      data: {
        rev,
        pendingContent: null,
        pendingProps: Prisma.DbNull,
        pendingTaskId: null,
        pendingTurn: null,
        pendingAt: null,
        leaseHolder: 'human',
        leaseUserId: input.userId,
        leaseTaskId: taken?.taskId ?? null,
        leaseTurn: taken?.turn ?? null,
        leaseToken: null,
        leaseIntent: null,
        leaseIntentChecked: false,
        leaseUntil: new Date(now.getTime() + artifactLimits.humanLeaseSeconds * 1000),
      },
    })
    const after = { ...block, rev }
    await writeRevisions(tx, artifact.id, [
      revisionOf(after, { userId: input.userId, taskId: null, turnNo: null }),
    ])
    const seq = artifact.seq + 1n
    await tx.artifactOp.create({
      data: {
        artifactId: artifact.id,
        seq,
        actor: 'user',
        userId: input.userId,
        taskId: taken?.taskId ?? null,
        turnNo: taken?.taskId ? taken.turn : null,
        kind: 'take',
        blockKey: block.sectionKey,
        baseRev: block.rev,
        newRev: rev,
        result: 'taken',
      },
    })
    await tx.artifact.update({
      where: { id: artifact.id },
      data: { seq, revision: { increment: 1 } },
    })
    return { rev }
  })
}

/**
 * `artifact_claim` (Ар17): the agent holds a block for up to two minutes with what it is about to
 * write — others get `ARTIFACT_BLOCK_HELD` (`claim`). A lease is no change of the artifact: no
 * line of the journal, no signal (Ар20).
 */
export async function claimArtifactBlock(
  db: Db,
  input: {
    artifactId: string
    block: string
    actor: Extract<ArtifactActor, { kind: 'agent' }>
    intent: string
    now?: Date
  },
): Promise<{ until: Date }> {
  const now = input.now ?? new Date()
  return db.$transaction(async (tx) => {
    const actor = await resolveActor(tx, input.actor)
    const artifact = await lockArtifact(tx, input.artifactId)
    await requireRole(tx, artifact.id, actor, 'edit')
    const block = await tx.artifactBlock.findUnique({
      where: { documentId_sectionKey: { documentId: artifact.id, sectionKey: input.block } },
    })
    if (!block || block.deletedRev !== null)
      throw artifactOpInvalid(`no block ${input.block}`, { block: input.block })
    const held = holdOf(block, actor, now)
    if (held) throw held
    const intent = artifactIntentSchema.safeParse(input.intent)
    if (!intent.success) throw artifactOpInvalid('an intent is one line of up to 200 characters')
    const until = new Date(now.getTime() + artifactLimits.claimSeconds * 1000)
    await tx.artifactBlock.update({
      where: { id: block.id },
      data: {
        leaseHolder: 'agent',
        leaseUserId: null,
        leaseTaskId: actor.taskId,
        leaseTurn: actor.turnNo,
        leaseToken: randomBytes(16).toString('hex'),
        // The agent's text: others see «Пишет агент» without it until core checked it (Ар19).
        leaseIntent: intent.data,
        leaseIntentChecked: false,
        leaseUntil: until,
      },
    })
    return { until }
  })
}

// ———————————————————————————————————————— the check of core (Ар16, Ар19)

export interface ArtifactWriteVerdict {
  artifactId: string
  block: string
  /** The revision core checked: a block written again since keeps waiting. */
  rev: number
  /**
   * Null — it passed; otherwise why it is sent back (pageRefusalReasons); `dropped` — nobody
   * checks it: the turn failed or was cancelled (Ар16).
   */
  refusal: PageRefusalReason | 'dropped' | null
  /**
   * The intent of the block's lease the check read with the write (`lease_intent`): a claim may
   * name a new one meanwhile, which then waits for the next check. Absent — whatever it holds.
   */
  intent?: string | null
}

/** The check of the intent of a claim that writes nothing yet (Ар19): it is the agent's text too. */
export interface ArtifactClaimVerdict {
  artifactId: string
  block: string
  /** The intent the check read: a claim renewed with another one since is left for the next. */
  intent: string
  refusal: PageRefusalReason | null
}

export interface ArtifactSettled {
  artifactId: string
  checked: number
  refused: number
}

/**
 * What core decided about the agent's writes of one chat (Ар16, Ар19, §7.3): a write that passed
 * becomes the block's checked content under its revision; a refused one — dropped: a block the
 * write inserted becomes a tombstone, a block it rewrote keeps its checked text under a new
 * revision. A pending title passes or goes with `titles`. Claims of the chat end with `final`.
 * The check itself — what is looked for — is `ArtifactChecks` of core (slice 88.4).
 */
export async function settleArtifactWrites(
  db: Db,
  input: {
    taskId: string
    blocks: readonly ArtifactWriteVerdict[]
    titles?: readonly {
      artifactId: string
      refusal: PageRefusalReason | 'dropped' | null
      /** The title the check read: one written again since waits for the next check. */
      text?: string
    }[]
    claims?: readonly ArtifactClaimVerdict[]
    /** The end of the turn: the chat's claims end too. */
    final?: boolean
    /**
     * The collector's drop (Ар16): only writes and a title made before this, and nothing at all
     * while the chat's pass is in `preparing` or `running` — read under a lock of its row, so a
     * pass another core starts meanwhile keeps its writes and claims.
     */
    staleBefore?: Date
  },
): Promise<ArtifactSettled[]> {
  return db.$transaction(async (tx) => {
    if (input.staleBefore) {
      const task = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM tasks WHERE id = ${input.taskId}::uuid FOR SHARE`
      const status = task[0]?.status
      if (status === 'preparing' || status === 'running') return []
    }
    const stale = (at: Date | null) =>
      !input.staleBefore || at === null || at.getTime() < input.staleBefore.getTime()
    // The end of the turn ends the chat's claims also where it wrote nothing to check.
    const claimed = input.final
      ? await tx.artifactBlock.findMany({
          where: { leaseHolder: 'agent', leaseTaskId: input.taskId },
          select: { documentId: true },
          distinct: ['documentId'],
        })
      : []
    const ids = [
      ...new Set([
        ...input.blocks.map((each) => each.artifactId),
        ...(input.titles ?? []).map((each) => each.artifactId),
        ...(input.claims ?? []).map((each) => each.artifactId),
        ...claimed.map((each) => each.documentId),
      ]),
    ].sort()
    const out: ArtifactSettled[] = []
    for (const artifactId of ids) {
      const artifact = await lockArtifact(tx, artifactId)
      let seq = artifact.seq
      let bytes = artifact.bytes
      let checked = 0
      let refused = 0
      const journal: Prisma.ArtifactOpCreateManyInput[] = []
      const revisions: RevisionDraft[] = []
      const line = (
        block: ArtifactBlock | null,
        result: 'checked' | 'refused' | 'dropped',
        refusal: string | null,
        turnNo: number | null,
      ) => {
        seq += 1n
        journal.push({
          artifactId,
          seq,
          actor: 'agent',
          taskId: input.taskId,
          turnNo: turnNo ?? 1,
          kind: block ? 'check' : 'title',
          blockKey: block?.sectionKey ?? null,
          newRev: block?.rev ?? null,
          result,
          refusal,
        })
      }
      for (const verdict of input.blocks.filter((each) => each.artifactId === artifactId)) {
        const block = await tx.artifactBlock.findUnique({
          where: { documentId_sectionKey: { documentId: artifactId, sectionKey: verdict.block } },
        })
        if (!block || block.pendingTaskId !== input.taskId || block.rev !== verdict.rev) continue
        if (!stale(block.pendingAt)) continue
        const turnNo = block.pendingTurn
        // Whether this verdict covered the intent the block's lease holds now.
        const covered = verdict.intent === undefined || verdict.intent === block.leaseIntent
        if (verdict.refusal === null) {
          checked += 1
          const props = asProps(block.pendingProps ?? block.props)
          const content = block.pendingContent ?? checkedText(block) ?? ''
          const section = block.blockKind === 'section'
          bytes += BigInt(utf8(content) - utf8(checkedText(block)))
          const after: ArtifactBlock = {
            ...block,
            content,
            props,
            heading: section ? ((props.heading as string | undefined) ?? block.heading) : null,
            markdown: section ? content : block.markdown,
            state: 'written',
            writtenTaskId: input.taskId,
            writtenTurn: turnNo,
            writtenByUserId: null,
            checkedTurn: turnNo,
            refusal: null,
            intent:
              block.leaseHolder !== 'agent' && block.leaseIntent && covered
                ? block.leaseIntent
                : block.intent,
            leaseIntent: block.leaseHolder === 'agent' ? block.leaseIntent : null,
            leaseIntentChecked:
              block.leaseHolder === 'agent' && block.leaseIntent !== null && covered,
            pendingContent: null,
            pendingProps: null,
            pendingTaskId: null,
            pendingTurn: null,
            pendingAt: null,
          }
          await updateBlock(tx, after)
          revisions.push(revisionOf(after, { userId: null, taskId: input.taskId, turnNo }))
          line(after, 'checked', null, turnNo)
          continue
        }
        refused += 1
        // A block this chat inserted and nobody checked since: nothing of it was ever shown, so it
        // goes. A block with checked text, or a placeholder of plan 69, stays.
        const insertedBy = await tx.artifactOp.findFirst({
          where: { artifactId, blockKey: block.sectionKey, kind: 'insert', taskId: input.taskId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        })
        const checkedSince = insertedBy
          ? await tx.artifactOp.findFirst({
              where: {
                artifactId,
                blockKey: block.sectionKey,
                kind: { in: ['check', 'take'] },
                seq: { gt: insertedBy.seq },
              },
              select: { seq: true },
            })
          : null
        const inserted =
          insertedBy !== null &&
          checkedSince === null &&
          checkedText(block) === null &&
          block.writtenByUserId === null
        const rev = block.rev + 1
        const after: ArtifactBlock = {
          ...block,
          rev,
          deletedRev: inserted ? rev : null,
          refusal:
            block.state === 'pending' && verdict.refusal !== 'dropped' ? verdict.refusal : null,
          // What the check read and refused goes with the write; an intent named since waits.
          leaseIntent: block.leaseHolder === 'agent' && !covered ? block.leaseIntent : null,
          leaseIntentChecked: false,
          pendingContent: null,
          pendingProps: null,
          pendingTaskId: null,
          pendingTurn: null,
          pendingAt: null,
        }
        await updateBlock(tx, after)
        revisions.push(revisionOf(after, { userId: null, taskId: input.taskId, turnNo }))
        if (verdict.refusal === 'dropped') line(after, 'dropped', null, turnNo)
        else line(after, 'refused', verdict.refusal, turnNo)
      }
      // A claim is no change of the artifact: its intent is shown or forgotten, without a line.
      for (const claim of (input.claims ?? []).filter((each) => each.artifactId === artifactId))
        await tx.artifactBlock.updateMany({
          where: {
            documentId: artifactId,
            sectionKey: claim.block,
            leaseHolder: 'agent',
            leaseTaskId: input.taskId,
            leaseIntent: claim.intent,
            pendingTaskId: null,
          },
          data:
            claim.refusal === null
              ? { leaseIntentChecked: true }
              : { leaseIntent: null, leaseIntentChecked: false },
        })
      const title = input.titles?.find((each) => each.artifactId === artifactId)
      const titleData: Prisma.ArtifactUpdateInput = {}
      if (
        title &&
        artifact.pendingTaskId === input.taskId &&
        artifact.pendingTitle !== null &&
        (title.text === undefined || title.text === artifact.pendingTitle) &&
        stale(artifact.pendingTitleAt)
      ) {
        if (title.refusal === null) titleData.title = artifact.pendingTitle
        Object.assign(titleData, {
          pendingTitle: null,
          pendingTaskId: null,
          pendingTurn: null,
          pendingTitleAt: null,
        })
        line(
          null,
          title.refusal === null ? 'checked' : title.refusal === 'dropped' ? 'dropped' : 'refused',
          title.refusal === 'dropped' ? null : title.refusal,
          artifact.pendingTurn,
        )
        if (title.refusal === null) checked += 1
        else refused += 1
      }
      if (input.final)
        await tx.artifactBlock.updateMany({
          where: { documentId: artifactId, leaseHolder: 'agent', leaseTaskId: input.taskId },
          data: {
            leaseHolder: null,
            leaseTaskId: null,
            leaseTurn: null,
            leaseToken: null,
            leaseUntil: null,
            leaseIntent: null,
            leaseIntentChecked: false,
          },
        })
      if (journal.length === 0) continue
      await writeRevisions(tx, artifactId, revisions)
      await tx.artifactOp.createMany({ data: journal })
      await tx.artifact.update({
        where: { id: artifactId },
        data: { ...titleData, seq, bytes, revision: { increment: 1 } },
      })
      out.push({ artifactId, checked, refused })
    }
    return out
  })
}

async function updateBlock(tx: Tx, block: ArtifactBlock): Promise<void> {
  const { id, documentId: _documentId, ...data } = block
  await tx.artifactBlock.update({
    where: { id },
    data: {
      ...data,
      props: data.props as Prisma.InputJsonValue,
      pendingProps:
        data.pendingProps === null ? Prisma.DbNull : (data.pendingProps as Prisma.InputJsonValue),
    },
  })
}

/**
 * The writes of a chat that wait for a check, in every artifact: for core to check them while the
 * turn runs and at its end, and for a failed turn (Ар16) — each with the revision to name back.
 */
export function pendingArtifactWrites(db: Pick<PrismaClient, 'artifactBlock'>, taskId: string) {
  return db.artifactBlock.findMany({
    // A claim's intent is the agent's text too: core checks it with the writes (Ар19).
    where: {
      deletedRev: null,
      OR: [{ pendingTaskId: taskId }, { leaseHolder: 'agent', leaseTaskId: taskId }],
    },
    select: {
      documentId: true,
      sectionKey: true,
      rev: true,
      blockKind: true,
      pendingContent: true,
      pendingProps: true,
      leaseHolder: true,
      leaseTaskId: true,
      leaseIntent: true,
      leaseIntentChecked: true,
      pendingTaskId: true,
      pendingTurn: true,
      pendingAt: true,
    },
    orderBy: [{ documentId: 'asc' }, { pendingAt: 'asc' }],
  })
}

/** The titles a chat wrote that wait for the check (Ар19), with the text to name back. */
export function pendingArtifactTitles(db: Pick<PrismaClient, 'artifact'>, taskId: string) {
  return db.artifact.findMany({
    where: { pendingTaskId: taskId, pendingTitle: { not: null } },
    select: { id: true, pendingTitle: true },
    orderBy: { id: 'asc' },
  })
}

/**
 * The chats whose writes wait for a check longer than since `before` and whose pass is over — no
 * end of a turn will check them (Ар16): for the collector to drop them. By the time of the write
 * of a block (`pending_at`), not by the artifact's: a document others keep editing still holds an
 * old write. A pass in `preparing` or `running` is left to the end of its turn, or to the sweep
 * that ends it; a chat that is gone is dropped too.
 */
export async function staleArtifactWriters(
  db: Pick<PrismaClient, '$queryRaw'>,
  before: Date,
  limit = 50,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ task_id: string }[]>`
    SELECT p.task_id FROM (
      SELECT pending_task_id AS task_id FROM chat_document_sections
      WHERE pending_task_id IS NOT NULL AND pending_at < ${before}
      UNION
      SELECT pending_task_id FROM chat_documents
      WHERE pending_task_id IS NOT NULL
        AND (pending_title_at IS NULL OR pending_title_at < ${before})
    ) p
    LEFT JOIN tasks t ON t.id = p.task_id
    WHERE t.id IS NULL OR t.status::text NOT IN ('preparing', 'running')
    ORDER BY p.task_id
    LIMIT ${limit}`
  return rows.map((row) => row.task_id)
}

/**
 * The collector's drop of what a chat left (Ар16): its writes and title made before `before`, and
 * its claims — nothing while its pass is in `preparing` or `running`, read under the lock of the
 * chat's row: a newer turn's writes and claims stay.
 */
export async function dropStaleArtifactWrites(
  db: Db,
  taskId: string,
  before: Date,
): Promise<ArtifactSettled[]> {
  const pending = (await db.$transaction((tx) => pendingArtifactWrites(tx, taskId))).filter(
    (each) => each.pendingTaskId === taskId && each.pendingAt !== null && each.pendingAt < before,
  )
  const titles = await db.$transaction((tx) =>
    tx.artifact.findMany({ where: { pendingTaskId: taskId }, select: { id: true } }),
  )
  return settleArtifactWrites(db, {
    taskId,
    final: true,
    staleBefore: before,
    blocks: pending.map((each) => ({
      artifactId: each.documentId,
      block: each.sectionKey,
      rev: each.rev,
      refusal: 'dropped' as const,
    })),
    titles: titles.map((each) => ({ artifactId: each.id, refusal: 'dropped' as const })),
  })
}

/**
 * A failed or cancelled turn whose writes nobody will check (Ар16): they are dropped, its claims
 * end. Its pending title goes too.
 */
export async function dropArtifactWrites(db: Db, taskId: string): Promise<ArtifactSettled[]> {
  const pending = (await db.$transaction((tx) => pendingArtifactWrites(tx, taskId))).filter(
    (each) => each.pendingTaskId === taskId,
  )
  const titles = await db.$transaction((tx) =>
    tx.artifact.findMany({ where: { pendingTaskId: taskId }, select: { id: true } }),
  )
  return settleArtifactWrites(db, {
    taskId,
    final: true,
    blocks: pending.map((each) => ({
      artifactId: each.documentId,
      block: each.sectionKey,
      rev: each.rev,
      refusal: 'dropped' as const,
    })),
    titles: titles.map((each) => ({ artifactId: each.id, refusal: 'dropped' as const })),
  })
}

// ———————————————————————————————————————— reading

export interface ArtifactBlockView {
  key: string
  kind: string
  parent: string | null
  rank: string
  rev: number
  /** What this reader may read: the checked text, or its own chat's unchecked one. */
  content: string | null
  props: Props
  /** The agent's write waits for the check: others read the text before it (Ар19). */
  checking: boolean
  hold: ArtifactHoldReason | null
}

/** An artifact as a reader sees it (Ар19): others read only what core checked. */
export async function readArtifact(
  db: Db,
  input: { artifactId: string; actor: ArtifactActor; now?: Date },
) {
  const now = input.now ?? new Date()
  return db.$transaction(async (tx) => {
    const actor = await resolveActor(tx, input.actor)
    const role = await requireRole(tx, input.artifactId, actor, 'read')
    const artifact = await tx.artifact.findUniqueOrThrow({ where: { id: input.artifactId } })
    const blocks = await tx.artifactBlock.findMany({
      where: { documentId: artifact.id, deletedRev: null },
      orderBy: [...artifactBlockOrder],
    })
    const ownTitle = actor.kind === 'agent' && artifact.pendingTaskId === actor.taskId
    return {
      id: artifact.id,
      kind: artifact.kind,
      title: ownTitle && artifact.pendingTitle !== null ? artifact.pendingTitle : artifact.title,
      seq: Number(artifact.seq),
      role,
      version: artifact.currentVersion,
      blocks: blocks.map((block): ArtifactBlockView => ({
        key: block.sectionKey,
        kind: block.blockKind,
        parent: block.parentKey,
        rank: block.rank ?? rankForIndex(block.position),
        rev: block.rev,
        content: seenText(block, actor),
        props: seenProps(block, actor),
        checking: block.pendingTaskId !== null,
        hold: artifactBlockHold(block, now),
      })),
    }
  })
}

// ———————————————————————————————————————— versions (Ар13)

export interface ArtifactVersionSave {
  artifactId: string
  actor: ArtifactActor
  /** «Сохранить версию» with a label; a person's labelled version is named (Ар13). */
  label?: string
  /** A series of a person's manual edits: within 5 minutes it updates the last automatic version. */
  glue?: boolean
  now?: Date
}

/**
 * A version: the list of the blocks' checked revisions — what others see — with the text of each
 * kept once in the revisions. A block whose only text waits for the check is not in it. Up to
 * 2 MiB; the last 50 automatic versions are kept, and up to 100 named ones. A document keeps its
 * Markdown as before (`chat_document_contents`), when its sections assemble.
 */
export async function saveArtifactVersion(
  db: Db,
  input: ArtifactVersionSave,
): Promise<{ no: number; sha256: string; sizeBytes: number; glued: boolean }> {
  const now = input.now ?? new Date()
  return db.$transaction(async (tx) => {
    const actor = await resolveActor(tx, input.actor)
    const artifact = await lockArtifact(tx, input.artifactId)
    await requireRole(tx, artifact.id, actor, 'edit')
    // The agent's label is its text and would be seen unchecked (Ар19): until labels go through
    // the check (slice 88.6) the agent's version is an automatic one without a label.
    const label = actor.kind === 'user' ? input.label?.trim() || null : null
    if (label !== null && !versionLabelSchema.safeParse(label).success)
      throw artifactOpInvalid('a label is one line of up to 60 characters')
    if (label !== null && secretInContent(label)) throw artifactSecretShape()
    const named = label !== null
    if (named) {
      const count = await tx.artifactVersion.count({
        where: { documentId: artifact.id, named: true },
      })
      if (count >= artifactLimits.namedVersions) throw artifactLimit('namedVersions')
    }
    const blocks = await tx.artifactBlock.findMany({
      where: { documentId: artifact.id, deletedRev: null },
      orderBy: [...artifactBlockOrder],
    })
    const revs = await tx.artifactBlockRevision.groupBy({
      by: ['blockKey'],
      where: { artifactId: artifact.id, blockKey: { in: blocks.map((each) => each.sectionKey) } },
      _max: { rev: true },
    })
    const lastRev = new Map(revs.map((each) => [each.blockKey, each._max.rev]))
    const missing: RevisionDraft[] = []
    const listed: { key: string; rev: number }[] = []
    let size = 0
    for (const block of blocks) {
      const text = checkedText(block)
      if (text === null) continue
      size += utf8(text)
      let rev = block.pendingTaskId === null ? block.rev : (lastRev.get(block.sectionKey) ?? null)
      if (rev === null || rev < 1) {
        // A block the code before checked, with no revision yet: its checked text is kept now.
        rev = Math.max(1, block.pendingTaskId === null ? block.rev : block.rev - 1)
      }
      if (lastRev.get(block.sectionKey) !== rev)
        missing.push({
          ...revisionOf({ ...block, rev }, { userId: null, taskId: null, turnNo: null }),
        })
      listed.push({ key: block.sectionKey, rev })
    }
    if (size > artifactLimits.versionBytes) throw artifactTooLarge('versionBytes')
    await writeRevisions(tx, artifact.id, missing)
    // A kind exported as Markdown keeps it with its version, as the documents of plan 69 did.
    const markdown = artifactKindSpecOf(artifact.kind)?.exports.includes('md')
      ? documentMarkdown(artifact.title, blocks)
      : null
    const hash = sha256(canonicalJson({ title: artifact.title, blocks: listed }))
    const authorKind =
      actor.kind === 'user' ? 'user' : actor.journal === 'schedule' ? 'schedule' : 'turn'
    const last = await tx.artifactVersion.findFirst({
      where: { documentId: artifact.id },
      orderBy: { no: 'desc' },
    })
    const glued =
      input.glue === true &&
      !named &&
      last !== null &&
      !last.named &&
      last.authorKind === 'user' &&
      authorKind === 'user' &&
      now.getTime() - last.createdAt.getTime() <= artifactLimits.versionGlueMinutes * 60_000
    const data = {
      sizeBytes: size,
      sha256: hash,
      taskId: actor.taskId,
      turnNo: actor.turnNo,
      markdown,
      label,
      named,
      seq: artifact.seq,
      blocks: listed,
      authorKind,
    }
    const no = glued && last ? last.no : artifact.currentVersion + 1
    if (glued && last) await tx.artifactVersion.update({ where: { id: last.id }, data })
    else await tx.artifactVersion.create({ data: { ...data, documentId: artifact.id, no } })
    if (markdown !== null)
      await tx.artifactContent.upsert({
        where: { documentId: artifact.id },
        create: { documentId: artifact.id, versionNo: no, markdown },
        update: { versionNo: no, markdown },
      })
    await tx.artifact.update({
      where: { id: artifact.id },
      data: { currentVersion: no, revision: { increment: 1 } },
    })
    // The automatic ones beyond the last 50 go; never the current one.
    const surplus = await tx.artifactVersion.findMany({
      where: { documentId: artifact.id, named: false, no: { not: no } },
      orderBy: { no: 'desc' },
      skip: artifactLimits.automaticVersions - 1,
      select: { id: true },
    })
    if (surplus.length > 0)
      await tx.artifactVersion.deleteMany({ where: { id: { in: surplus.map((each) => each.id) } } })
    return { no, sha256: hash, sizeBytes: size, glued }
  })
}

const versionLabelSchema = artifactTitleSchema.max(artifactLimits.versionLabelChars)

function documentMarkdown(title: string, blocks: readonly ArtifactBlock[]): string | null {
  const sections = blocks.filter(
    (block) => block.blockKind === 'section' && checkedText(block) !== null,
  )
  try {
    return assembleDocMarkdown({
      title,
      sections: sections.map((block) => ({
        key: block.sectionKey,
        heading: (checkedProps(block).heading as string | undefined) ?? block.heading,
        markdown: checkedText(block),
        intent: block.intent,
        state: 'written',
      })),
    })
  } catch (error) {
    // A document beyond the bounds of plan 69 keeps its version without Markdown.
    if (isDomainError(error)) return null
    throw error
  }
}

/** The blocks of a version with their text, from the revisions (Ар13). */
export async function readArtifactVersion(
  db: Db,
  input: { artifactId: string; no: number; actor: ArtifactActor },
) {
  return db.$transaction(async (tx) => {
    const actor = await resolveActor(tx, input.actor)
    await requireRole(tx, input.artifactId, actor, 'read')
    const version = await tx.artifactVersion.findUnique({
      where: { documentId_no: { documentId: input.artifactId, no: input.no } },
    })
    if (!version) throw artifactNotFound()
    const listed = (version.blocks as { key: string; rev: number }[] | null) ?? []
    const rows = await tx.artifactBlockRevision.findMany({
      where: {
        artifactId: input.artifactId,
        OR: listed.map((each) => ({ blockKey: each.key, rev: each.rev })),
      },
    })
    const texts = await tx.artifactBlockRevision.findMany({
      where: {
        artifactId: input.artifactId,
        sha256: { in: rows.map((row) => row.sha256) },
        props: { not: Prisma.DbNull },
      },
      select: { sha256: true, content: true, props: true },
    })
    const textOf = new Map(texts.map((each) => [each.sha256, each]))
    const byKey = new Map(rows.map((row) => [`${row.blockKey}:${row.rev}`, row]))
    return {
      no: version.no,
      label: version.label,
      named: version.named,
      createdAt: version.createdAt,
      markdown: version.markdown,
      blocks: listed.map((each) => {
        const row = byKey.get(`${each.key}:${each.rev}`)
        const text = row ? textOf.get(row.sha256) : undefined
        return {
          key: each.key,
          rev: each.rev,
          kind: row?.blockKind ?? null,
          parent: row?.parentKey ?? null,
          rank: row?.rank ?? null,
          content: text?.content ?? null,
          props: asProps(text?.props ?? null),
        }
      }),
    }
  })
}

// ———————————————————————————————————————— the trash and the collector (Ар50, Ар52)

/** A person's change of the whole artifact as a line of the journal: open pages hear it (Ар20). */
async function journalOne(
  tx: Tx,
  artifact: LockedArtifact,
  userId: string,
  kind: 'trash' | 'restore',
): Promise<bigint> {
  const seq = artifact.seq + 1n
  await tx.artifactOp.create({
    data: { artifactId: artifact.id, seq, actor: 'user', userId, kind, result: 'applied' },
  })
  return seq
}

export type ArtifactTrashedBy = 'client' | 'agent' | 'project'

/** «В корзину» — only the owner (Ар23); 30 days, then the collector deletes it. */
export async function trashArtifact(
  db: Db,
  input: { artifactId: string; userId: string; by: ArtifactTrashedBy; now?: Date },
): Promise<{ purgeAfter: Date }> {
  const now = input.now ?? new Date()
  return db.$transaction(async (tx) => {
    const artifact = await lockArtifact(tx, input.artifactId)
    await requireRole(tx, artifact.id, person(input.userId), 'trash')
    const purgeAfter = new Date(now.getTime() + artifactLimits.trashDays * DAY_MS)
    await tx.artifact.update({
      where: { id: artifact.id },
      data: {
        deletedAt: now,
        deletedBy: input.by,
        purgeAfter,
        revision: { increment: 1 },
        seq: await journalOne(tx, artifact, input.userId, 'trash'),
      },
    })
    return { purgeAfter }
  })
}

/**
 * «Вернуть» from the trash — only the owner. `onlyBy` — the trash of a project returns only what
 * it put there (Ар42).
 */
export async function restoreArtifact(
  db: Db,
  input: { artifactId: string; userId: string; onlyBy?: ArtifactTrashedBy },
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const artifact = await lockArtifact(tx, input.artifactId)
    await requireRole(tx, artifact.id, person(input.userId), 'trash', true)
    if (artifact.deletedAt === null) return false
    if (input.onlyBy !== undefined && artifact.deletedBy !== input.onlyBy) return false
    await tx.artifact.update({
      where: { id: artifact.id },
      data: {
        deletedAt: null,
        deletedBy: null,
        purgeAfter: null,
        revision: { increment: 1 },
        seq: await journalOne(tx, artifact, input.userId, 'restore'),
      },
    })
    return true
  })
}

export interface ArtifactSweep {
  purged: number
  journal: number
  batches: number
  leases: number
  filled: number
}

/**
 * The collector of artifacts (Ар50, Ар52, §7.1): artifacts whose 30 days in the trash are over go
 * for good; the journal keeps 30 days or the last 10 000 operations of an artifact; stored answers
 * of batches go after 30 days; expired leases are cleared; rows of the code before are filled.
 */
export async function sweepArtifacts(
  db: Pick<PrismaClient, '$executeRaw' | 'artifact' | 'artifactBlock' | 'artifactBatch'>,
  now: Date,
  limit = 100,
): Promise<ArtifactSweep> {
  const expired = await db.artifact.findMany({
    where: { purgeAfter: { lt: now } },
    select: { id: true },
    take: limit,
  })
  const purged = expired.length
    ? (await db.artifact.deleteMany({ where: { id: { in: expired.map((each) => each.id) } } }))
        .count
    : 0
  const before = new Date(now.getTime() - artifactLimits.journalDays * DAY_MS)
  const journal = await db.$executeRaw`
    DELETE FROM artifact_ops o
    USING chat_documents d
    WHERE d.id = o.artifact_id
      AND (o.created_at < ${before} OR o.seq <= d.seq - ${artifactLimits.journalOps})`
  const batches = (await db.artifactBatch.deleteMany({ where: { createdAt: { lt: before } } }))
    .count
  const ended = {
    leaseHolder: null,
    leaseUserId: null,
    leaseTaskId: null,
    leaseTurn: null,
    leaseToken: null,
    leaseUntil: null,
  }
  // The intent of a block the agent inserted stays with its write until the check.
  const leases =
    (
      await db.artifactBlock.updateMany({
        where: { leaseUntil: { lt: now }, pendingTaskId: null },
        data: { ...ended, leaseIntent: null, leaseIntentChecked: false },
      })
    ).count +
    (
      await db.artifactBlock.updateMany({
        where: { leaseUntil: { lt: now }, pendingTaskId: { not: null } },
        data: ended,
      })
    ).count
  const filled = await fillArtifactRows(db)
  return { purged, journal, batches, leases, filled }
}
