import {
  artifactsOfTurn,
  dropArtifactWrites,
  insertFeedEvent,
  saveArtifactVersion,
  dropStaleArtifactWrites,
  pendingArtifactTitles,
  pendingArtifactWrites,
  settleArtifactWrites,
  staleArtifactWriters,
  sweepArtifacts,
  type ArtifactClaimVerdict,
  type ArtifactSettled,
  type ArtifactWriteVerdict,
  type PrismaClient,
} from '@repo/db'
import {
  hasOutwardPasswordForm,
  type FeedRow,
  isDomainError,
  tokenReasonOf,
  type PageRefusalReason,
} from '@repo/domain'

// The check of the agent's text in artifacts (docs/plan/88-artifacts.md, Ар16, Ар19, §7.3; slice
// 88.4). A write of the agent waits in `pending_*` under a new revision and holds its block for the
// writing chat: nobody else reads it until core found in it no key of the turn and no value of the
// variables of the chat's workspace — what only the turn holds — and nothing the role refuses for
// pages (embedded tokens, a password form sent elsewhere). Every text of the
// agent goes so: the content of a block and the strings in it (the cells of a row, the settings),
// its text properties (a heading, the name of a frame), the intent of an insert or a claim, the
// title of the artifact. A passed write becomes the block's checked content; a refused one leaves
// the text before it (`settleArtifactWrites`). Nothing found is logged — only counts.
//
// While a turn runs, `checkLive` checks every tick of the pass (1.5 s, as the sections of plan
// 74): another person sees the agent's text a moment after it was written. `settle` does the same
// at the end of a completed turn and ends the chat's claims; `fail` — of a failed, cancelled or
// recovered one — checks with what is left of the turn's values, if anything, and drops the
// rest (Ар16). `sweep` drops the writes of chats whose pass is over and no end of a turn reached,
// by the time of the write (`pending_at`), and runs the collector of artifacts.
//
// Since the tools of plan 69 became synonyms of the operations (slice 88.6, Ар3), this is also the
// end of a turn for documents: each artifact the turn changed gets a version of what passed (Ар13;
// `doc_finish` waits for it), the tab of a document is signalled (`feed.doc_touch`) and the chat's
// publications of documents (`page_publish({ docId })`) come true from that version. After the
// answer, `tell` writes the rows of the feed: `feed.artifact` and `feed.artifact_left` (Ар46).

type Refuses = (text: string) => 'turn_key' | 'client_value' | null

/** A write left waiting this long by a chat whose pass is over is dropped (Ар16). */
export const ARTIFACT_STALE_WRITE_MS = 10 * 60_000
/** How often the collector of artifacts runs within the sweep of chats (trash, journal, leases). */
export const ARTIFACT_COLLECT_EVERY_MS = 10 * 60_000

export interface ArtifactChecksDependencies {
  db: Pick<
    PrismaClient,
    | '$transaction'
    | '$queryRaw'
    | '$executeRaw'
    | 'artifact'
    | 'artifactBlock'
    | 'artifactBatch'
    | 'artifactOp'
    | 'taskTurn'
    | 'taskEvent'
  >
  /** The chat's publications of documents, after their versions (docs/plan/69-pages.md, Ст9). */
  pages?: {
    publishDocuments(
      taskId: string,
      turnId: string | null,
      refused: ReadonlySet<string>,
    ): Promise<void>
  }
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => Date
}

/** Every string a JSON text holds, its keys too: a value split by escapes is read as it is meant. */
function jsonStrings(text: string): string[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return []
  }
  const out: string[] = []
  const walk = (item: unknown) => {
    if (typeof item === 'string') out.push(item)
    else if (Array.isArray(item)) item.forEach(walk)
    else if (item !== null && typeof item === 'object')
      for (const [key, inner] of Object.entries(item)) {
        out.push(key)
        walk(inner)
      }
  }
  walk(value)
  return out
}

/** The texts of one write of the agent, each read on its own and all together. */
export function artifactWriteTexts(write: {
  pendingContent: string | null
  pendingProps: unknown
  leaseIntent: string | null
}): string[] {
  const parts: string[] = []
  if (write.pendingContent !== null) {
    parts.push(write.pendingContent)
    parts.push(...jsonStrings(write.pendingContent))
  }
  if (write.pendingProps !== null && typeof write.pendingProps === 'object')
    for (const value of Object.values(write.pendingProps as Record<string, unknown>))
      if (typeof value === 'string') parts.push(value)
  if (write.leaseIntent !== null) parts.push(write.leaseIntent)
  return parts
}

/**
 * Why the texts are refused, by the turn's check first, then by the role's of each part — the
 * checks of pages without their size, which the limits of a block already hold; null — not.
 */
export function artifactTextRefusal(
  refuses: Refuses,
  parts: readonly string[],
): PageRefusalReason | null {
  if (parts.length === 0) return null
  const turn = refuses(parts.join('\n'))
  if (turn) return turn
  for (const part of parts) {
    const token = tokenReasonOf(part)
    if (token) return token
    if (hasOutwardPasswordForm(part)) return 'password_form'
  }
  return null
}

export interface ArtifactCheckOutcome {
  checked: number
  refused: number
  dropped: number
}

const none: ArtifactCheckOutcome = { checked: 0, refused: 0, dropped: 0 }

export class ArtifactChecks {
  readonly #deps: ArtifactChecksDependencies
  readonly #now: () => Date
  #collectedAt = 0

  constructor(deps: ArtifactChecksDependencies) {
    this.#deps = deps
    this.#now = deps.now ?? (() => new Date())
  }

  /**
   * The writes of the chat that wait, while its turn runs. Never throws: what is not checked now
   * is checked by the next tick or the end of the turn.
   */
  async checkLive(taskId: string, turn: number, refuses: Refuses): Promise<ArtifactCheckOutcome> {
    try {
      const settled = await this.#settled(taskId, refuses, false)
      await this.#signal(taskId, turn, settled)
      return outcomeOf(settled)
    } catch (error) {
      this.#warn('artifact_checks_live_failed', taskId, turn, error)
      return none
    }
  }

  /** The end of a completed turn: everything the chat left is checked, its claims end. */
  async settle(taskId: string, turn: number, refuses: Refuses): Promise<ArtifactCheckOutcome> {
    let outcome = none
    let refused = new Set<string>()
    try {
      const settled = await this.#settled(taskId, refuses, true)
      outcome = outcomeOf(settled)
      this.#log(taskId, turn, outcome)
      refused = await this.#endTurn(taskId, turn, settled)
    } catch (error) {
      this.#warn('artifact_checks_failed', taskId, turn, error)
    }
    try {
      await this.#deps.pages?.publishDocuments(taskId, await this.#turnId(taskId, turn), refused)
    } catch (error) {
      this.#warn('artifact_publications_failed', taskId, turn, error)
    }
    return outcome
  }

  /**
   * The versions of the artifacts the turn changed (Ар13) — of what passed, by the agent of the chat
   * — and the rows of the documents' card. The ids of the artifacts with writes sent back.
   */
  async #endTurn(taskId: string, turn: number, settled: readonly ArtifactSettled[]) {
    const { db } = this.#deps
    const touched = await artifactsOfTurn(db, taskId, turn)
    const refused = new Set<string>([
      ...touched.filter((each) => each.refused > 0).map((each) => each.artifactId),
      ...settled.filter((each) => each.refused > 0).map((each) => each.artifactId),
    ])
    for (const artifact of touched) {
      if (artifact.checked === 0) continue
      try {
        await saveArtifactVersion(db, {
          artifactId: artifact.artifactId,
          actor: { kind: 'agent', taskId, turnNo: turn },
        })
      } catch (error) {
        this.#warn('artifact_version_failed', taskId, turn, error)
      }
    }
    await this.#signal(taskId, turn, settled, touched)
    return refused
  }

  /**
   * The tab of a document beside the chat reads it again when its revision grows
   * (`feed.doc_touch`, a signal without text), until the cabinet listens to `artifact.signals`
   * itself (slice 88.10).
   */
  async #signal(
    taskId: string,
    turn: number,
    settled: readonly ArtifactSettled[],
    touched: readonly { artifactId: string }[] = [],
  ) {
    const ids = [
      ...new Set([
        ...settled.map((each) => each.artifactId),
        ...touched.map((each) => each.artifactId),
      ]),
    ]
    if (ids.length === 0) return
    const { db } = this.#deps
    const artifacts = await db.artifact.findMany({
      where: { id: { in: ids } },
      select: { id: true, revision: true },
    })
    const turnId = await this.#turnId(taskId, turn)
    for (const artifact of artifacts)
      await insertFeedEvent(db, {
        taskId,
        turnId,
        row: {
          type: 'feed.doc_touch',
          payload: { v: 1, docId: artifact.id, revision: artifact.revision },
        },
      })
  }

  /**
   * After the answer of a completed turn (Ар46, §7.3): a row `feed.artifact` for each artifact the
   * turn created or changed, and `feed.artifact_left` for its writes the check sent back — never
   * why. Never throws.
   */
  async tell(taskId: string, turn: number): Promise<void> {
    const { db } = this.#deps
    try {
      const touched = await artifactsOfTurn(db, taskId, turn)
      if (touched.length === 0) return
      const turnId = await this.#turnId(taskId, turn)
      const write = (row: FeedRow) => insertFeedEvent(db, { taskId, turnId, row })
      for (const artifact of touched)
        if (artifact.created || artifact.checked > 0)
          await write({
            type: 'feed.artifact',
            payload: {
              v: 1,
              artifactId: artifact.artifactId,
              kind: artifact.kind,
              created: artifact.created,
            },
          })
      for (const artifact of touched)
        if (artifact.refused > 0)
          await write({
            type: 'feed.artifact_left',
            payload: {
              v: 1,
              artifactId: artifact.artifactId,
              blocks: Math.min(artifact.refused, 1000),
              reason: 'refused',
            },
          })
    } catch (error) {
      this.#warn('artifact_feed_failed', taskId, turn, error)
    }
  }

  async #turnId(taskId: string, turn: number): Promise<string | null> {
    const row = await this.#deps.db.taskTurn.findFirst({
      where: { taskId, turnNo: turn },
      select: { id: true },
    })
    return row?.id ?? null
  }

  /**
   * A turn that failed, was cancelled or whose end recovery reached (Ар16): what passes with the
   * values left — the turn's own, or those Vault holds now — is kept, the rest is dropped and the
   * chat's claims end. `refuses` null — nothing to check with: every write is dropped. Never throws;
   * what fails here is dropped by `sweep`.
   */
  async fail(
    taskId: string,
    turn: number | null,
    refuses: Refuses | null,
  ): Promise<ArtifactCheckOutcome> {
    try {
      const outcome = refuses ? outcomeOf(await this.#settled(taskId, refuses, false)) : { ...none }
      const dropped = count(await dropArtifactWrites(this.#deps.db, taskId), 'refused')
      const total = { ...outcome, dropped }
      this.#log(taskId, turn, total)
      return total
    } catch (error) {
      this.#warn('artifact_checks_failed', taskId, turn, error)
      return none
    }
  }

  /**
   * The collector (Ар16, Ар50): writes of chats whose pass is over, older than
   * ARTIFACT_STALE_WRITE_MS, are dropped; every ARTIFACT_COLLECT_EVERY_MS — the trash, the journal,
   * stored answers, expired leases and the rows of the code before (`sweepArtifacts`).
   */
  async sweep(options: { busy?: (taskId: string) => boolean } = {}): Promise<number> {
    const { db, logger } = this.#deps
    const now = this.#now()
    let dropped = 0
    const before = new Date(now.getTime() - ARTIFACT_STALE_WRITE_MS)
    const stale = await staleArtifactWriters(db, before)
    for (const taskId of stale) {
      if (options.busy?.(taskId)) continue
      try {
        // Only what was written before, and nothing once the chat's pass started anywhere.
        dropped += count(await dropStaleArtifactWrites(db, taskId, before), 'refused')
      } catch (error) {
        this.#warn('artifact_sweep_drop_failed', taskId, null, error)
      }
    }
    if (dropped > 0) logger?.log(`artifact_sweep_dropped writes=${dropped} chats=${stale.length}`)
    if (now.getTime() - this.#collectedAt >= ARTIFACT_COLLECT_EVERY_MS) {
      this.#collectedAt = now.getTime()
      const swept = await sweepArtifacts(db, now)
      const total = swept.purged + swept.journal + swept.batches + swept.leases + swept.filled
      if (total > 0)
        logger?.log(
          `artifact_sweep purged=${swept.purged} journal=${swept.journal} batches=${swept.batches} leases=${swept.leases} filled=${swept.filled}`,
        )
    }
    return dropped
  }

  async #settled(taskId: string, refuses: Refuses, final: boolean): Promise<ArtifactSettled[]> {
    const { db } = this.#deps
    const [writes, titles] = await Promise.all([
      pendingArtifactWrites(db, taskId),
      pendingArtifactTitles(db, taskId),
    ])
    const blocks: ArtifactWriteVerdict[] = []
    const claims: ArtifactClaimVerdict[] = []
    for (const write of writes) {
      if (write.pendingTaskId === taskId) {
        blocks.push({
          artifactId: write.documentId,
          block: write.sectionKey,
          rev: write.rev,
          intent: write.leaseIntent,
          refusal: artifactTextRefusal(refuses, artifactWriteTexts(write)),
        })
      } else if (
        write.leaseHolder === 'agent' &&
        write.leaseTaskId === taskId &&
        write.leaseIntent !== null &&
        !write.leaseIntentChecked
      ) {
        claims.push({
          artifactId: write.documentId,
          block: write.sectionKey,
          intent: write.leaseIntent,
          refusal: artifactTextRefusal(refuses, [write.leaseIntent]),
        })
      }
    }
    const titleVerdicts = titles.map((title) => ({
      artifactId: title.id,
      text: title.pendingTitle ?? '',
      refusal: artifactTextRefusal(refuses, [title.pendingTitle ?? '']),
    }))
    if (blocks.length === 0 && claims.length === 0 && titleVerdicts.length === 0 && !final)
      return []
    return settleArtifactWrites(db, { taskId, blocks, claims, titles: titleVerdicts, final })
  }

  #log(taskId: string, turn: number | null, outcome: ArtifactCheckOutcome) {
    if (outcome.checked + outcome.refused + outcome.dropped === 0) return
    this.#deps.logger?.log(
      `artifact_checks_settled task=${taskId} turn=${turn ?? 'none'} checked=${outcome.checked} refused=${outcome.refused} dropped=${outcome.dropped}`,
    )
  }

  #warn(line: string, taskId: string, turn: number | null, error: unknown) {
    this.#deps.logger?.warn(
      `${line} task=${taskId} turn=${turn ?? 'none'} reason=${isDomainError(error) ? error.code : 'unknown'}`,
    )
  }
}

const outcomeOf = (settled: readonly ArtifactSettled[]): ArtifactCheckOutcome => ({
  checked: count(settled, 'checked'),
  refused: count(settled, 'refused'),
  dropped: 0,
})

const count = (settled: readonly ArtifactSettled[], key: 'checked' | 'refused') =>
  settled.reduce((sum, each) => sum + each[key], 0)
