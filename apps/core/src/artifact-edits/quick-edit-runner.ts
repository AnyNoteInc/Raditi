import { chargeTask, extendTaskHolds } from '@repo/billing'
import {
  addAgentCommentReply,
  applyArtifactOps,
  artifactRole,
  claimQuickEdit,
  finishQuickEdit,
  quickEditBlocks,
  settleTurn,
  staleQuickEdits,
  type ClaimedQuickEdit,
  type PrismaClient,
  type QuickEditBlock,
} from '@repo/db'
import { artifactSectionText } from '@repo/doc-render/markdown'
import {
  feedLimits,
  hasOutwardPasswordForm,
  isDomainError,
  tokenReasonOf,
  taskHoldExpiry,
  type FeedRow,
  type LlmBackend,
  type SecretStore,
} from '@repo/domain'
import {
  applyQuickEdits,
  artifactCommentSnapshotSchema,
  hasUniqueCommentQuote,
  introducedContacts,
  normalizeCommentQuote,
  paragraphOfQuote,
  parseQuickEditAnswer,
  QUICK_EDIT_SYSTEM,
  quickEditLimits,
  quickEditRetryMessage,
  quickEditTool,
  quickEditUserMessage,
  splitParagraphs,
  type QuickEditArgs,
  type QuickEditNote,
  type QuickEditPart,
  type QuickEditReason,
  type QuickEditState,
} from '@repo/domain/artifacts'
import { quickKeyClosed, quickKeySession, revokeQuickKey } from '@repo/turn-keys'

import type { ArtifactChecks } from '../artifacts/artifact-checks.ts'
import { CHARGE_LATER_EVENT } from '../tasks/pass-settlement.ts'
import { agentWords } from '../tasks/turn-outcome.ts'
import { textRefusal } from '../turns/text-refusal.ts'
import { readWorkspaceEnvValuesToRefuse } from '../workspace-env/workspace-env-values.ts'
import { issueQuickKey, QUICK_DRIVER, type QuickKey } from './quick-key-issuer.ts'
import { callQuickModel, QuickCallError, type QuickCallAnswer } from './quick-llm-client.ts'

// A quick edit of artifact notes (docs/plan/98-quick-edits.md, §4 step 3): claim → the blocks of
// the notes → one model call through the gateway (and at most one retry) → the code applies the
// answer as a write of the agent → the same check before anyone sees it → the settlement of the
// attempt with its charge. No sandbox, no snapshot, no Vault write. Logs carry ids only.

/** An edit unfinished this long is lost: the call itself is capped at 25 s (БПр15). */
export const QUICK_EDIT_STALE_MS = 2 * 60_000

export interface QuickEditRunnerDependencies {
  db: PrismaClient
  secrets: Pick<SecretStore, 'kvRead'>
  /** The origin of the llm role (LLM_CONTROL_URL); null — quick edits are off. */
  gatewayOrigin: string | null
  artifacts: Pick<ArtifactChecks, 'settle' | 'fail'>
  logger: { log(message: string): void; warn(message: string): void }
  /** The backends of the gateway; only those that declare the platform's own calls are used. */
  backends: readonly LlmBackend[]
  fetch?: typeof fetch
}

interface Ending {
  state: Exclude<QuickEditState, 'queued' | 'running'>
  reason: QuickEditReason | null
  /** The words to the client: the model's reply, or null for the failure row. */
  message: string | null
  calls: number
}

const ended = (
  state: Ending['state'],
  reason: QuickEditReason | null,
  calls = 0,
  message: string | null = null,
): Ending => ({ state, reason, calls, message })

/** The answer to the client when the model gave none: what the card says, plainly. */
const fallbackWords: Partial<Record<QuickEditReason, string>> = {
  held: 'Раздел сейчас правит другой человек. Попробуйте, когда он закончит.',
  moved: 'Место заметки изменилось. Отправьте её агенту.',
  stale: 'Раздел изменился, пока готовилась правка. Попробуйте ещё раз.',
  links: 'Правку не внесли: в ней появились ссылки или контакты, которых не было в тексте.',
  check: 'Правку не внесли: в ней оказалось что-то похожее на пароль или ключ доступа.',
  limit: 'Здесь быстро не получится — отправьте заметку агенту.',
}

export class QuickEditRunner {
  readonly #deps: QuickEditRunnerDependencies

  constructor(deps: QuickEditRunnerDependencies) {
    this.#deps = deps
  }

  async run(quickEditId: string): Promise<void> {
    const { db, logger } = this.#deps
    const claimed = await claimQuickEdit(db, quickEditId)
    if (claimed === null) return
    const started = Date.now()
    let key: QuickKey | null = null
    let ending: Ending
    try {
      ending = await this.#work(claimed, (issued) => (key = issued))
    } catch (error) {
      logger.warn(
        `quick_edit_failed id=${claimed.id} code=${isDomainError(error) ? error.code : 'internal'}`,
      )
      ending = ended(
        'failed',
        isDomainError(error) && error.code === 'QUICK_EDITS_OFF' ? 'paused' : 'platform',
      )
    } finally {
      const issued = key as QuickKey | null
      if (issued !== null) await this.#revoke(issued.keyId)
    }
    await this.#settle(claimed, ending)
    logger.log(
      `quick_edit_done id=${claimed.id} state=${ending.state} reason=${ending.reason ?? '-'} ` +
        `calls=${ending.calls} ms=${Date.now() - started}`,
    )
  }

  /**
   * Edits whose core died or whose job was lost (БПр15): their keys are closed, what their attempt
   * left unchecked in `pending_*` (writes, replies) is dropped, their task goes back to waiting with
   * what the made calls cost charged, the row is `failed`. Keys of quick edits a failed revoke left
   * open past their validity are closed too. Returns how many edits were ended.
   */
  async sweep(olderThanMs = QUICK_EDIT_STALE_MS): Promise<number> {
    const { db, logger } = this.#deps
    const forgotten = await db.llmKey.findMany({
      where: { driverId: QUICK_DRIVER, revokedAt: null, validUntil: { lt: new Date() } },
      select: { id: true },
      take: 100,
    })
    for (const key of forgotten) await this.#revoke(key.id)
    let count = 0
    for (const stale of await staleQuickEdits(db, olderThanMs)) {
      try {
        const keys = await db.llmKey.findMany({
          where: { sessionId: quickKeySession(stale.id), revokedAt: null },
          select: { id: true },
        })
        for (const key of keys) await this.#revoke(key.id)
        const row = await db.artifactQuickEdit.findUniqueOrThrow({
          where: { id: stale.id },
          select: { artifactId: true, userId: true, requestId: true },
        })
        const task = await db.task.findUniqueOrThrow({
          where: { id: stale.taskId },
          select: { workspaceId: true, status: true },
        })
        // A lost job: the task is still `queued` for it; the claim makes the move to waiting legal.
        if (task.status === 'queued')
          await db.$executeRaw`
            UPDATE tasks SET status = 'preparing', waiting = NULL, turn_no = ${stale.attempt},
              updated_at = now()
            WHERE id = ${stale.taskId}::uuid AND status = 'queued' AND attempt = ${stale.attempt}`
        // Nothing the lost attempt wrote may pass with the next one's check.
        await this.#deps.artifacts.fail(stale.taskId, stale.attempt, null)
        await this.#settle(
          {
            id: stale.id,
            taskId: stale.taskId,
            attempt: stale.attempt,
            workspaceId: task.workspaceId,
            ...row,
          },
          ended('failed', 'platform'),
        )
        count++
      } catch (error) {
        logger.warn(
          `quick_edit_sweep_failed id=${stale.id} code=${isDomainError(error) ? error.code : 'internal'}`,
        )
      }
    }
    return count
  }

  async #work(edit: ClaimedQuickEdit, issued: (key: QuickKey) => void): Promise<Ending> {
    const { db } = this.#deps
    const dispatch = await db.artifactCommentDispatch.findUnique({
      where: { userId_requestId: { userId: edit.userId, requestId: edit.requestId } },
      select: { notes: true, artifact: { select: { title: true } } },
    })
    const parsedNotes = artifactCommentSnapshotSchema.safeParse(dispatch?.notes)
    if (!dispatch || !parsedNotes.success) return ended('failed', 'platform')
    const notes = parsedNotes.data
    const anchors = notes.map(
      (note) => note.anchor as { kind: string; block: string; quote?: string },
    )
    const keys = [...new Set(anchors.map((anchor) => anchor.block))]
    if (keys.length > quickEditLimits.parts) return ended('refused', 'limit')
    const blocks = await db.$transaction((tx) =>
      quickEditBlocks(tx, {
        artifactId: edit.artifactId,
        userId: edit.userId,
        keys,
        now: new Date(),
      }),
    )
    if (blocks.length !== keys.length) return ended('refused', 'moved')
    if (blocks.some((block) => block.hold !== null)) return ended('refused', 'held')
    if (
      blocks.reduce((sum, block) => sum + Buffer.byteLength(block.markdown), 0) >
      quickEditLimits.sourceBytes
    )
      return ended('refused', 'limit')
    const byKey = new Map(blocks.map((block) => [block.key, block]))
    const parts: QuickEditPart[] = blocks.map((block) => ({
      key: block.key,
      heading: block.heading,
      markdown: block.markdown,
    }))
    const promptNotes: QuickEditNote[] = []
    for (const [index, note] of notes.entries()) {
      const anchor = anchors[index]!
      const block = byKey.get(anchor.block)!
      const quote = normalizeCommentQuote(anchor.quote ?? '')
      // «Место изменилось»: the quote is no longer once in its section (as the cabinet shows it).
      if (!hasUniqueCommentQuote(normalizeCommentQuote(artifactSectionText(block.markdown)), quote))
        return ended('refused', 'moved')
      promptNotes.push({
        id: note.id,
        // Every note is the clicker's request: notes of others only after their confirmation (БПр9).
        by: 'client',
        part: anchor.block,
        p: paragraphOfQuote(splitParagraphs(block.markdown).paragraphs, quote, artifactSectionText),
        quote,
        body: note.body,
        replies: note.replies.map((reply) =>
          typeof reply === 'string'
            ? { by: 'client' as const, body: reply }
            : { by: 'other' as const, body: reply.body },
        ),
      })
    }
    if (Buffer.byteLength(JSON.stringify(promptNotes)) > quickEditLimits.noteBytes)
      return ended('refused', 'limit')
    const user = quickEditUserMessage({ title: dispatch.artifact.title, parts, notes: promptNotes })
    const messages: Record<string, unknown>[] = [
      { role: 'system', content: QUICK_EDIT_SYSTEM },
      { role: 'user', content: user },
    ]
    const estimate = Math.ceil(
      Buffer.byteLength(JSON.stringify(messages) + JSON.stringify(quickEditTool)) / 3,
    )
    const key = await issueQuickKey(db, {
      taskId: edit.taskId,
      attempt: edit.attempt,
      quickEditId: edit.id,
      estimatedInputTokens: estimate,
      backends: this.#platformBackends().map((backend) => backend.id),
    })
    issued(key)
    const valuesPromise = this.#values(edit.workspaceId)
    // Swallow a rejection until it is awaited: the call goes on meanwhile.
    valuesPromise.catch(() => undefined)
    let args: QuickEditArgs | null = null
    let changed: Map<string, string> | null = null
    let calls = 0
    for (let attempt = 0; attempt < quickEditLimits.calls && args === null; attempt++) {
      calls++
      let answer: QuickCallAnswer
      try {
        answer = await this.#call(key, messages)
      } catch (error) {
        if (error instanceof QuickCallError) return ended('failed', 'platform', calls)
        throw error
      }
      let parsed = parseQuickEditAnswer(answer)
      // An edit that does not fit the paragraphs (a «find» missing or not unique, a wrong number)
      // is a wrong answer too: the one retry names the problem.
      if (parsed.ok && parsed.args.outcome === 'edited') {
        const applied = applyQuickEdits(parts, parsed.args.edits)
        if (applied.ok) changed = applied.blocks
        else parsed = { ok: false, problem: applied.problem }
      }
      if (parsed.ok) {
        args = parsed.args
        break
      }
      // The one retry: the first exchange is the prefix, the provider may read it from its cache.
      messages.push(
        {
          role: 'assistant',
          content: answer.content ?? '',
          ...(answer.toolArguments === null
            ? {}
            : {
                tool_calls: [
                  {
                    id: 'call_0',
                    type: 'function',
                    function: {
                      name: answer.toolName ?? quickEditTool.function.name,
                      arguments: answer.toolArguments,
                    },
                  },
                ],
              }),
        },
        answer.toolArguments === null
          ? { role: 'user', content: quickEditRetryMessage(parsed.problem) }
          : {
              role: 'tool',
              tool_call_id: 'call_0',
              content: quickEditRetryMessage(parsed.problem),
            },
      )
    }
    if (args === null) return ended('failed', 'format', calls)
    await this.#revoke(key.keyId)
    let values: string[]
    try {
      values = await valuesPromise
    } catch {
      // No values to check against: nothing is written (as a pass drops its writes then).
      return ended('failed', 'platform', calls)
    }
    const refuses = textRefusal([key.secret], values)
    if (args.outcome !== 'edited' || changed === null || changed.size === 0) {
      // The answer goes into the notes as well, open: nothing was changed (БПр11).
      if (!(await this.#stillOurs(edit))) return ended('failed', 'platform', calls)
      await this.#reply(edit, notes, args.reply, false)
      await this.#deps.artifacts.settle(edit.taskId, edit.attempt, refuses)
      return ended(
        'unchanged',
        args.outcome === 'needs_agent' ? 'needs_agent' : 'no_change',
        calls,
        args.reply,
      )
    }
    // The notes' words and the client's own replies may bring contacts; nothing else (БПр8).
    const allowed = notes
      .flatMap((note) => [note.body, ...note.replies.filter((reply) => typeof reply === 'string')])
      .join('\n')
    for (const [blockKey, text] of changed)
      if (introducedContacts(byKey.get(blockKey)!.markdown, text, allowed).length > 0)
        return ended('refused', 'links', calls)
    // The check before anyone sees the text, run first here: a refused text is never written, so
    // the notes are never answered «исправлено» for it.
    for (const text of changed.values())
      if (refuses(text) !== null || tokenReasonOf(text) !== null || hasOutwardPasswordForm(text))
        return ended('refused', 'check', calls)
    // A sweep that took this edit for lost settled it: nothing more is written.
    if (!(await this.#stillOurs(edit))) return ended('failed', 'platform', calls)
    const write = await this.#write(edit, changed, byKey)
    if (write !== null) return ended('refused', write, calls)
    await this.#reply(edit, notes, args.reply, true)
    const outcome = await this.#deps.artifacts.settle(edit.taskId, edit.attempt, refuses)
    // The verdict is read off the blocks: a refused write keeps the text before it and names the
    // refusal (its revision grows all the same).
    const after = await db.artifactBlock.findMany({
      where: { documentId: edit.artifactId, sectionKey: { in: [...changed.keys()] } },
      select: { sectionKey: true, rev: true, pendingTaskId: true, refusal: true },
    })
    const passed =
      outcome.refused === 0 &&
      after.length === changed.size &&
      after.every(
        (block) =>
          block.pendingTaskId === null &&
          block.refusal === null &&
          block.rev > (byKey.get(block.sectionKey)?.rev ?? 0),
      )
    return passed ? ended('applied', null, calls, args.reply) : ended('refused', 'check', calls)
  }

  /** Whether the edit is still running as this worker's: the sweep has not ended it. */
  async #stillOurs(edit: ClaimedQuickEdit): Promise<boolean> {
    const row = await this.#deps.db.artifactQuickEdit.findUnique({
      where: { id: edit.id },
      select: { state: true, finishedAt: true },
    })
    return row?.state === 'running' && row.finishedAt === null
  }

  /** The backends whose provider allows the platform's own calls (БПр1). */
  #platformBackends(): LlmBackend[] {
    return this.#deps.backends.filter((backend) => backend.platformUserAgent !== undefined)
  }

  #call(key: QuickKey, messages: readonly Record<string, unknown>[]): Promise<QuickCallAnswer> {
    const backend = this.#platformBackends().find((each) => each.id === key.backendId)
    const route = backend?.routes.find((each) => each.method === 'POST')
    if (this.#deps.gatewayOrigin === null || !backend?.platformUserAgent || !route)
      throw new QuickCallError({ kind: 'broken' })
    return callQuickModel({
      gatewayOrigin: this.#deps.gatewayOrigin,
      route: route.path,
      userAgent: backend.platformUserAgent,
      key: key.secret,
      body: {
        model: key.model,
        max_tokens: quickEditLimits.outputTokens,
        messages,
        tools: [quickEditTool],
        tool_choice: 'auto',
      },
      timeoutMs: quickEditLimits.callMs,
      ...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}),
    })
  }

  async #values(workspaceId: string): Promise<string[]> {
    const rows = await this.#deps.db.$queryRaw<{ name: string }[]>`
      SELECT name FROM workspace_env_vars WHERE workspace_id = ${workspaceId}::uuid ORDER BY name`
    if (rows.length === 0) return []
    return readWorkspaceEnvValuesToRefuse(
      this.#deps.secrets,
      workspaceId,
      rows.map((row) => row.name),
    )
  }

  /** The changed blocks as one batch of the agent; a block changed meanwhile — `stale`. */
  async #write(
    edit: ClaimedQuickEdit,
    changed: ReadonlyMap<string, string>,
    byKey: ReadonlyMap<string, QuickEditBlock>,
  ): Promise<QuickEditReason | null> {
    try {
      await applyArtifactOps(this.#deps.db, {
        batch: {
          artifactId: edit.artifactId,
          opId: `quick-${edit.id}`,
          ops: [...changed].map(([block, content]) => ({
            op: 'replace' as const,
            block,
            ifRev: byKey.get(block)!.rev,
            content,
          })),
        },
        actor: { kind: 'agent', taskId: edit.taskId, turnNo: edit.attempt },
      })
      return null
    } catch (error) {
      if (!isDomainError(error)) throw error
      if (error.code === 'ARTIFACT_STALE') return 'stale'
      if (error.code === 'ARTIFACT_BLOCK_HELD' || error.code === 'ARTIFACT_LEASE_LOST')
        return 'held'
      if (error.code === 'ARTIFACT_SECRET_SHAPE') return 'check'
      throw error
    }
  }

  /**
   * The reply in each note. After an edit a note is closed if the clicker wrote it or owns the
   * artifact (БПр11); without one it stays open.
   */
  async #reply(
    edit: ClaimedQuickEdit,
    notes: readonly { id: string; by?: 'other' }[],
    reply: string,
    edited: boolean,
  ): Promise<void> {
    const role = await artifactRole(this.#deps.db, {
      artifactId: edit.artifactId,
      userId: edit.userId,
    })
    for (const note of notes) {
      try {
        await addAgentCommentReply(this.#deps.db, {
          taskId: edit.taskId,
          turnNo: edit.attempt,
          threadId: note.id,
          requestId: edit.requestId,
          body: reply,
          resolve: edited && (note.by !== 'other' || role === 'owner'),
          now: new Date(),
        })
      } catch (error) {
        // A reply is a courtesy: the edit stands without it (the limit of replies, a closed note).
        if (!isDomainError(error)) throw error
        this.#deps.logger.warn(`quick_edit_reply_skipped id=${edit.id} code=${error.code}`)
      }
    }
  }

  async #revoke(keyId: string): Promise<void> {
    try {
      await revokeQuickKey(this.#deps.db, keyId)
      // The gateway closes a call's accounting as its stream ends: a short wait spares a charge later.
      for (let wait = 0; wait < 3 && !(await quickKeyClosed(this.#deps.db, keyId)); wait++)
        await new Promise((resolve) => setTimeout(resolve, 100))
    } catch {
      this.#deps.logger.warn(`quick_key_revoke_failed key=${keyId}`)
    }
  }

  /** The attempt ends: the task waits for the next click, its work is charged, the row is final. */
  async #settle(edit: ClaimedQuickEdit, ending: Ending): Promise<void> {
    const { db, logger } = this.#deps
    const message =
      ending.message ?? (ending.reason === null ? null : (fallbackWords[ending.reason] ?? null))
    // The same cleaning as the words of a pass: no markup of the feed, within its limit.
    const words = message === null ? null : agentWords(message, feedLimits.message)
    const row: FeedRow =
      words !== null && ending.state !== 'failed'
        ? {
            type: 'feed.result',
            payload: {
              v: 1,
              turn: edit.attempt,
              message: words,
              site: 'none',
              next: 'awaiting_user',
              filesChanged: 0,
              changeType: ending.state === 'applied' ? 'content' : 'none',
              needsApproval: false,
              risk: 'low',
            },
          }
        : {
            type: 'feed.failure',
            payload: {
              v: 1,
              turn: edit.attempt,
              code: 'technical',
              site: 'none',
              credits: null,
              next: 'awaiting_user',
            },
          }
    await db.$transaction(async (tx) => {
      const now = new Date()
      const moved = await settleTurn(tx, {
        taskId: edit.taskId,
        attempt: edit.attempt,
        expectedTurnNo: edit.attempt,
        from: ['preparing', 'running'],
        to: 'awaiting_user',
        turn: edit.attempt,
        feed: [row],
      })
      if (moved.moved) {
        try {
          await chargeTask(tx, { taskId: edit.taskId, now })
        } catch (error) {
          if (!isDomainError(error) || error.code !== 'CONFLICT') throw error
          logger.warn(`quick_edit_charge_later task=${edit.taskId}`)
          await tx.taskEvent.create({
            data: {
              taskId: edit.taskId,
              type: CHARGE_LATER_EVENT,
              payload: { v: 1, attempt: edit.attempt },
            },
          })
          await extendTaskHolds(tx, {
            taskId: edit.taskId,
            expiresAt: taskHoldExpiry(now, 'waiting'),
          })
        }
      }
      await finishQuickEdit(tx, {
        id: edit.id,
        state: ending.state,
        reason: ending.reason,
        calls: ending.calls,
      })
    })
  }
}
