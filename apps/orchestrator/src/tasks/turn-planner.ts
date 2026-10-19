import type { AttemptCreditBudget } from '@repo/billing'
import {
  attemptBudgetRub,
  MAX_SANDBOX_EGRESS_HOSTS,
  MAX_SANDBOX_TURN_MS,
  Money,
  SANDBOX_EGRESS_PORT,
  turnPlanLimits,
  turnPlanSchema,
  withTurnCredentials,
  type AgentDriver,
  type AgentWorkingSet,
  type FeedFailureCode,
  type FeedQuestionPayload,
  type LlmBackend,
  type LlmBackendId,
  type MediaChecks,
  type ModelClass,
  type PublicationSource,
  type RepoRef,
  type SandboxRuntime,
  type SnapshotReference,
  type TurnCredentialPolicy,
  type TurnPlan,
  type UnkeyedTurnRequest,
} from '@repo/domain'

import { llmGatewayBaseUrl } from '../llm/backends.ts'
import { ceilingQuestionOf } from './turn-outcome.ts'
import { CONTINUE_PROMPT, turnInstructions, type PreviewFacts } from './turn-instructions.ts'

// The planner of a pass (roadmap N11; docs/plan/53-chat-preview-release.md, R3): what the turn
// supervisor is asked to run and under which key policy, from the facts of the dialog read in
// PostgreSQL. Pure: the reader of the facts (pass-facts.ts) does the I/O. No branch names an
// agent shell, a backend or a CMS (CLAUDE.md rule 8): the driver, the backend and the stack
// adapter answer for themselves.

/** The address of sandbox-gw inside the isolated network of a turn (spec §8 «Сеть»). */
export const SANDBOX_GATEWAY_URL = 'http://sandbox-gw:8080' // NOSONAR: plain HTTP stays inside the turn's internal network (spec §8)
/**
 * The client egress proxy on sandbox-gw (plan 53, Р13): the agent's commands reach the hosts of
 * the client's variables through it, by CONNECT, so their TLS runs end to end.
 */
export const SANDBOX_EGRESS_PROXY_URL = `http://sandbox-gw:${SANDBOX_EGRESS_PORT}` // NOSONAR: as above, CONNECT carries the client's own TLS

/** CLAUDE.md rule 5: at most 2 vCPU, 4 GiB and 512 processes, 20 minutes per turn. */
const TURN_RESOURCES = Object.freeze({ cpu: 2, memoryMiB: 4096, pids: 512 })
const SANDBOX_USER = Object.freeze({ uid: 10001, gid: 10001 })

/**
 * The level of reasoning of a class (П5: one model, `low`, `high` and `max`). The profiles of
 * every enabled backend carry these levels; the gateway applies the one of the turn key.
 */
export const reasoningEffortByClass: Readonly<Record<ModelClass, string>> = Object.freeze({
  light: 'low',
  standard: 'high',
  heavy: 'max',
})

/**
 * The rules of the site's stack for a turn's workspace (`siteWorkspaceRules` of @repo/domain):
 * the protected paths always; the working set and the add-only media once the stack's adapter
 * has them — without them the turn gets the full tree, as before Р11.
 */
export interface WorkspaceRules {
  protectedPaths: readonly string[]
  workingSet?: AgentWorkingSet
  addOnlyPaths?: readonly string[]
  media?: MediaChecks
}

/**
 * How long after its `/update` a moved task branch is taken for that update at work, and the
 * pass waits for it (and puts it again) instead of failing.
 */
export const UPDATE_REPAIR_MS = 2 * 60 * 60_000

/** A row of the dialog's feed the prompt is built from: what the client wrote or pressed. */
export interface ClientRequest {
  id: bigint
  kind: string
  /** The client's words; absent for a press (`retry`, `command`). */
  text: string | null
  /** The command of a press (`cancel`, `reset`, `update`), or null. */
  command: string | null
  createdAt: Date
}

/** A finished turn of the task, as `task_turns` and its assignment keep it. */
export interface FinishedTurn {
  turnNo: number
  status: 'completed' | 'failed' | 'lost' | 'cancelled' | 'other'
  /**
   * Its pass ended in a `feed.failure` (`task_turns.rejected_at`): the platform refused what it
   * left, even when the turn itself completed (docs/plan/53, «Попробовать ещё (18.10)»).
   */
  rejected: boolean
  headSha: string | null
  startedAt: Date | null
  nativeSessionId: string | null
  /** `turn_assignments.plan`; null — it no longer passes its schema (a removed driver). */
  plan: TurnPlan | null
}

export type PassBudget =
  | { kind: 'credits'; budget: AttemptCreditBudget }
  /** A task that holds no reserve by design (`billable = false`): the class ceiling. */
  | { kind: 'quota' }

export interface PassFacts {
  task: {
    id: string
    workspaceId: string
    siteId: string
    attempt: number
    /** `tasks.turn_no` when the pass was claimed. */
    turnNo: number
    modelClass: ModelClass
  }
  /** The site's repository; null — the site has none yet. */
  repo: (RepoRef & { defaultBranch: string }) | null
  /** What the turn's workspace takes from the site's adapter (`siteWorkspaceRules`, R4). */
  rules: WorkspaceRules
  /** The rows of `feed.request`, oldest first. */
  requests: readonly ClientRequest[]
  /** When the request this pass answers was written: the trusted time of its commit. */
  committedAt: Date
  /** Turns of the task by number, those the plan reads. */
  turns: ReadonlyMap<number, FinishedTurn>
  /**
   * The head the platform last wrote to `agent/<taskId>`: that of the last completed turn, or
   * that of a candidate «Обновить» moved after it (Р27); null when nothing was written.
   */
  writtenHead: string | null
  /**
   * The dialog's latest candidate, whatever its status — the standing one, or the carrier of an
   * «Обновить» superseded at once (R3) —, or null.
   */
  candidate: { turnNo: number; headSha: string } | null
  preview: PreviewFacts
  /**
   * `host:port` the agent's commands may reach (plan 53, Р13): the hosts of the client's
   * variables the agent gets, each once, sorted; absent or empty — no egress at all.
   */
  egress?: readonly string[]
  /** The names of the client's variables the agent's commands get (Р13): never a value. */
  variables?: readonly string[]
  /**
   * What the site's adapter tells the agent of the database changes of its stack
   * (`SiteAdapter.dbPlanGuide`); absent or empty — nothing.
   */
  databaseGuide?: string
  /** The enabled profile of the task's class, or null when none is enabled. */
  profile: { backend: LlmBackendId; modelSlug: string; providerModelId: string } | null
  budget: PassBudget
  /** When the facts were read. */
  now: Date
}

export interface PlannerEnvironment {
  driver: AgentDriver
  backends: readonly LlmBackend[]
  runtime: SandboxRuntime
  /** The head of the default branch, read on the trusted side only for a first turn. */
  mainHead: () => Promise<string | null>
  /** The head of the task branch `agent/<taskId>`, read on the trusted side for a later turn. */
  branchHead: () => Promise<string | null>
}

export type PassPlan =
  | {
      kind: 'turn'
      request: UnkeyedTurnRequest
      policy: TurnCredentialPolicy
      /** The turn the pass opens: `tasks.turn_no + 1`. */
      turn: number
    }
  /** The key cannot cover a first call: the platform asks «Продолжить?» (Р8). */
  | { kind: 'ceiling'; question: Extract<FeedQuestionPayload, { kind: 'ceiling' }> }
  /** The pass cannot be planned; the task fails with this code, no turn is opened. */
  | { kind: 'refused'; code: FeedFailureCode }
  /**
   * The task branch is not where the platform last left it, so the turn could not publish. An
   * `/update` of the dialog may still be at work (its id — the rebase to put again, and the pass
   * waits); without one the pass fails before any money is spent.
   */
  | { kind: 'branch_moved'; update: string | null }

/** The words the client wrote after `since` (all of them for a new session), oldest first. */
export function promptOf(requests: readonly ClientRequest[], since: Date | null): string {
  const words = requests
    .filter((request) => request.text !== null)
    .filter((request) => since === null || request.createdAt.getTime() > since.getTime())
    .map((request) => request.text!.trim())
    .filter((text) => text.length > 0)
  // The latest words count most: the oldest are left out when they do not fit.
  const kept: string[] = []
  let length = 0
  for (const text of words.reverse()) {
    const added = text.length + (kept.length > 0 ? 2 : 0)
    if (length + added > turnPlanLimits.prompt) break
    kept.unshift(text)
    length += added
  }
  return kept.length > 0 ? kept.join('\n\n') : CONTINUE_PROMPT
}

/** Where the pass starts: a first turn, a continuation, a replacement or a rebased start. */
interface Start {
  expectedBaseSha: string
  expectedBranchSha?: string | null
  previous?: SnapshotReference
  replacesTurn?: number
  rebased?: true
  /** The words before this time were seen by the session the pass restores. */
  since: Date | null
}

function snapshotOf(
  facts: PassFacts,
  driver: AgentDriver,
  turn: FinishedTurn,
): SnapshotReference | null {
  const plan = turn.plan
  if (!plan || plan.driverId !== driver.id) return null
  const { context } = withTurnCredentials(plan, { llmApiKey: '', mcpToken: '' })
  const prepared = {
    context: {
      ...context,
      ...(turn.nativeSessionId ? { nativeSessionId: turn.nativeSessionId } : {}),
    },
    files: [],
    env: {},
    secrets: [],
  }
  return {
    workspaceId: facts.task.workspaceId,
    sessionId: plan.context.sessionId,
    turn: turn.turnNo,
    image: plan.sandbox.image,
    driver: { id: plan.driverId, version: plan.driverVersion },
    home: driver.sessionState(prepared),
  }
}

/**
 * A turn the next one may go on from: completed, and its result taken. A turn whose pass ended in
 * a failure is replaced like any unsuccessful one, though it published (`rejected`).
 */
const succeeded = (turn: FinishedTurn): boolean => turn.status === 'completed' && !turn.rejected

async function startOf(facts: PassFacts, env: PlannerEnvironment): Promise<Start | null> {
  const last = facts.turns.get(facts.task.turnNo)
  if (!last) {
    if (facts.task.turnNo !== 0) return null
    const head = await env.mainHead()
    return head ? { expectedBaseSha: head, since: null } : null
  }
  // «Обновить» moved the dialog onto a new `main` after its last turn (Р27): it records the
  // candidate under the task's turn number, with a head that turn did not write. The next turn
  // is a new session on that head — after an unsuccessful turn a replacement of it, so that its
  // content is undone first; its own input stands on the old `main`.
  const moved =
    facts.candidate &&
    facts.candidate.turnNo === facts.task.turnNo &&
    last.headSha !== facts.candidate.headSha
      ? facts.candidate.headSha
      : null
  if (moved !== null) {
    if (succeeded(last)) return { expectedBaseSha: moved, rebased: true, since: null }
    return {
      expectedBaseSha: moved,
      expectedBranchSha: facts.writtenHead,
      replacesTurn: last.turnNo,
      rebased: true,
      since: null,
    }
  }
  if (succeeded(last)) {
    if (!last.headSha) return null
    const previous = snapshotOf(facts, env.driver, last)
    if (!previous) return null
    return { expectedBaseSha: last.headSha, previous, since: last.startedAt }
  }
  // An unsuccessful turn is replaced from the checkpoint it started with (spec §8); the branch
  // is pinned where the platform last wrote it, a candidate «Обновить» moved included, and a
  // replaced new session after «Обновить» is a new session again.
  const replaced = last.plan
  if (!replaced) return null
  const restored = replaced.previous ? facts.turns.get(replaced.previous.turn) : undefined
  return {
    expectedBaseSha: replaced.workspace.expectedBaseSha,
    expectedBranchSha: facts.writtenHead,
    replacesTurn: last.turnNo,
    ...(replaced.previous ? { previous: replaced.previous } : {}),
    ...(replaced.rebased ? { rebased: true as const } : {}),
    since: replaced.previous ? (restored?.startedAt ?? null) : null,
  }
}

/** The `/update` of the dialog that may still be moving its branch, as its request id. */
function pendingUpdate(facts: PassFacts): string | null {
  const update = facts.requests.findLast((request) => request.command === 'update')
  if (!update || facts.now.getTime() - update.createdAt.getTime() > UPDATE_REPAIR_MS) return null
  return update.id.toString()
}

/**
 * The plan of one pass, or why there is none. The budget comes first: a key that cannot
 * cover a first call is a question to the client, not a turn (Р8).
 */
export async function planTurn(facts: PassFacts, env: PlannerEnvironment): Promise<PassPlan> {
  const { task } = facts
  if (!facts.repo) return { kind: 'refused', code: 'not_accepted' }
  if (!facts.profile) return { kind: 'refused', code: 'unavailable' }
  const backend = env.backends.find((candidate) => candidate.id === facts.profile!.backend)
  if (!backend) return { kind: 'refused', code: 'unavailable' }

  let budgetRub: string
  if (facts.budget.kind === 'credits') {
    const { budget } = facts.budget
    const key = new Money(budget.budgetRub)
    if (key.isZero() || key.lt(budget.finishRub))
      return {
        kind: 'ceiling',
        question: ceilingQuestionOf(
          {
            chainAttempts: budget.chainAttempts,
            reserved: budget.reserved,
            used: budget.used,
            customerLeftRub: budget.customerLeftRub,
            spendableNow: budget.spendableNow,
          },
          Math.max(task.turnNo, 1),
        ),
      }
    budgetRub = budget.budgetRub
  } else {
    budgetRub = attemptBudgetRub({
      kind: 'quota',
      modelClass: task.modelClass,
      spentRub: '0',
      openReservedRub: '0',
    })
  }

  const egress = facts.egress ?? []
  // One gateway variable holds them: more than it takes is no turn.
  if (egress.length > MAX_SANDBOX_EGRESS_HOSTS) return { kind: 'refused', code: 'technical' }

  const start = await startOf(facts, env)
  if (!start) return { kind: 'refused', code: 'technical' }
  // A later turn publishes by CAS against the branch: one that stands elsewhere would fail the
  // turn at its end, after its money was spent. The first turn creates the branch.
  if (task.turnNo > 0) {
    const expected =
      start.expectedBranchSha === undefined ? start.expectedBaseSha : start.expectedBranchSha
    if ((await env.branchHead()) !== expected)
      return { kind: 'branch_moved', update: pendingUpdate(facts) }
  }
  const turn = task.turnNo + 1
  const sessionId = task.id
  const reasoningEffort = reasoningEffortByClass[task.modelClass]
  const workspace: PublicationSource = {
    repo: { provider: facts.repo.provider, owner: facts.repo.owner, name: facts.repo.name },
    branch: `agent/${task.id}`,
    expectedBaseSha: start.expectedBaseSha,
    ...(start.expectedBranchSha !== undefined
      ? { expectedBranchSha: start.expectedBranchSha }
      : {}),
    protectedPaths: [...facts.rules.protectedPaths],
    ...(facts.rules.workingSet ? { workingSet: facts.rules.workingSet } : {}),
    ...(facts.rules.addOnlyPaths?.length && facts.rules.media
      ? { addOnlyPaths: [...facts.rules.addOnlyPaths], media: facts.rules.media }
      : {}),
  }
  const request: UnkeyedTurnRequest = {
    sandbox: {
      image: env.driver.image,
      labels: {
        workspaceId: task.workspaceId,
        siteId: task.siteId,
        taskId: task.id,
        sessionId,
        turn,
      },
      runtime: env.runtime,
      resources: { ...TURN_RESOURCES },
      user: { ...SANDBOX_USER },
      env: {},
      secrets: [],
      network: {
        mode: 'gateway',
        routes: ['llm', 'mcp'],
        ...(egress.length ? { egress: [...egress] } : {}),
      },
      hardTimeoutMs: MAX_SANDBOX_TURN_MS,
    },
    context: {
      taskId: task.id,
      sessionId,
      turn,
      llm: {
        baseUrl: llmGatewayBaseUrl(SANDBOX_GATEWAY_URL, backend),
        model: facts.profile.providerModelId,
        reasoningEffort,
      },
      mcp: { url: `${SANDBOX_GATEWAY_URL}/mcp` },
      instructions: turnInstructions(
        facts.preview,
        { names: facts.variables ?? [], hosts: egress },
        facts.databaseGuide,
        facts.rules,
      ),
      ...(egress.length ? { egressProxy: SANDBOX_EGRESS_PROXY_URL } : {}),
    },
    input: { prompt: promptOf(facts.requests, start.since), attachments: [] },
    driverVersion: env.driver.cliVersion,
    workspace,
    committedAt: facts.committedAt.toISOString(),
    ...(start.previous ? { previous: start.previous } : {}),
    ...(start.replacesTurn !== undefined ? { replacesTurn: start.replacesTurn } : {}),
    ...(start.rebased ? { rebased: true } : {}),
  }
  const policy: TurnCredentialPolicy = {
    driverId: env.driver.id,
    backend: backend.id,
    modelSlug: facts.profile.modelSlug,
    modelClass: task.modelClass,
    reasoningEffort,
    ttlMs: MAX_SANDBOX_TURN_MS,
    budgetRub,
  }
  return { kind: 'turn', request, policy, turn }
}

/** A plan saved by an assignment, or null when it no longer passes its schema (history). */
export function savedPlanOf(value: unknown): TurnPlan | null {
  const parsed = turnPlanSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
