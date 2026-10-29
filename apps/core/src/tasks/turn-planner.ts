import type { AttemptCreditBudget } from '@repo/billing'
import {
  attemptBudgetRub,
  MAX_SANDBOX_EGRESS_HOSTS,
  MAX_SANDBOX_TURN_MS,
  Money,
  SANDBOX_EGRESS_PORT,
  turnInboxLimits,
  turnInboxPath,
  turnPlanLimits,
  turnPlanSchema,
  withTurnCredentials,
  type AgentDriver,
  type AgentWorkingSet,
  type BrowserCheckpointKind,
  type BrowserCheckpointState,
  type BrowserObjectStatus,
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
  type TaskRequirements,
  type TurnCredentialPolicy,
  type TurnPlan,
  type TurnSkill,
  type UnkeyedTurnRequest,
} from '@repo/domain'

import { llmGatewayBaseUrl } from '../llm/backends.ts'
import { ceilingQuestionOf } from './turn-outcome.ts'
import {
  browserTaskInstructions,
  CONTINUE_PROMPT,
  turnInstructions,
  type PreviewFacts,
} from './turn-instructions.ts'

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

/** A file the client sent with the task, as the agent is told of it: never its key or address. */
export interface TaskAttachmentFacts {
  id: string
  fileName: string
  contentType: string
  sizeBytes: number
}

/**
 * An object the task saved on the site through its browser (`browser_checkpoints`, Б22), as the
 * agent is told of it: a new session of the agent — after a failed turn, «Продолжить» — does not
 * remember it, and must continue it instead of making another one.
 */
export interface SavedObjectFacts {
  kind: BrowserCheckpointKind
  objectId: string
  /**
   * `verified` — a trusted read found it; `unverified` — saved, the site has not confirmed it;
   * `missing` — the last read did not find it.
   */
  state: Exclude<BrowserCheckpointState, 'seen'>
  /**
   * What the last read found: present only while `verified`; the title is left out when it may
   * hold a contact (savedObjectOf).
   */
  title?: string
  status?: BrowserObjectStatus
  /** The path of its editor: no origin and no query, which may carry what a page put there. */
  editPath: string
}

/** What a pass of a task in the cloud browser needs of its site (docs/plan/57, Б8, Б20, Б26). */
export interface BrowserPassFacts {
  /** `sites.url`: where the agent's browser starts. */
  siteUrl: string
  /** `sites.agent_notes`: the client's hints for the agent («вход по адресу /login»). */
  agentNotes: string | null
  /** The files bound to the task, in the order they were sent. */
  attachments: readonly TaskAttachmentFacts[]
  /** What the task saved on the site, in all its sessions and turns, oldest first (Б22). */
  saved: readonly SavedObjectFacts[]
  /** What the stack's adapter tells the agent of its admin pages; null — it has no browser. */
  guide: string | null
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
  /**
   * What the task works with (`tasks.needs_repository`, `tasks.needs_browser`, docs/plan/57, Б2):
   * every layer of the pass branches on it, never on the stack or the driver.
   */
  requirements: TaskRequirements
  /** Present for a task that needs the cloud browser. */
  browser?: BrowserPassFacts
  /**
   * The files bound to a task with a repository, in the order they were sent: the latest go
   * into the sandbox of its turn (turnInboxOf). Absent or empty — none.
   */
  attachments?: readonly TaskAttachmentFacts[]
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
   * The skills of the site's agent (`site_agent_skills`, owner's request of 26.10.2026): the
   * platform's own unless turned off, then the added ones; a turn gets them with the internet.
   */
  skills?: readonly TurnSkill[]
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
  /**
   * SANDBOX_INTERNET=open (owner's decisions of 26.10.2026): the agent of a turn reaches the
   * public internet through the egress proxy and gets the site's skills — a turn in the browser
   * too, whose admin pages stay reachable through the `web` tools alone (Б20).
   */
  internet: boolean
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
      /** The task's own: a pass that needs a browser opens it before the turn (Б18). */
      requirements: TaskRequirements
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

/**
 * The words the client wrote after `since` (all of them for a new session), oldest first, in at
 * most `limit` characters.
 */
export function promptOf(
  requests: readonly ClientRequest[],
  since: Date | null,
  limit: number = turnPlanLimits.prompt,
): string {
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
    if (length + added > limit) break
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

/** Where a pass without a repository starts: its checkpoint chain only (startWithoutRepository). */
type StartWithoutRepository = Pick<Start, 'previous' | 'since'>

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
  // A task keeps its requirements (Б2): a replaced plan without a workspace is not this task's.
  if (!replaced?.workspace) return null
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

/** At most this many files are listed to the agent: the rest are older than the turn needs. */
const PROMPT_ATTACHMENTS = 50

const sizeOf = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`

/** At most this many saved objects are listed: a task changes up to 20 (Б34), its client more. */
const PROMPT_SAVED_OBJECTS = 40
/** A title as the agent is told of it: one line, this long at most. */
const PROMPT_TITLE_CHARS = 120

function promptTitle(title: string | undefined): string {
  if (title === undefined) return 'title not shown'
  // Line breaks and invisible or direction marks would break the list's shape.
  const line = [...title.replace(/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim()]
    .slice(0, PROMPT_TITLE_CHARS)
    .join('')
  return line ? `title ${JSON.stringify(line)}` : 'no title'
}

/** One saved object of the list: its state says what the agent does with it first. */
function savedObjectLine(object: SavedObjectFacts): string {
  const name = `${object.kind} ${object.objectId}`
  const editor = `editor ${object.editPath}`
  switch (object.state) {
    case 'verified':
      return `${name}: verified, ${promptTitle(object.title)}, status ${object.status ?? 'unknown'}; ${editor}`
    case 'unverified':
      return `${name}: saved, the site has not confirmed it yet — call web_verify before anything else; ${editor}`
    case 'missing':
      return `${name}: the last check did not find it on the site — do not make it again, ask the client with web_help; ${editor}`
  }
}

/**
 * What the platform adds to the client's words in a task in the cloud browser (docs/plan/57,
 * Б8, Б22, Б26): the site's address and the client's notes about it, what the task already
 * saved there — so that a new session continues those objects and makes no duplicate —, and the
 * files sent with the task — id, name, type and size, never a key or an address of the file:
 * the agent puts them on a page with `web_upload` by id, and only the browser worker reads them.
 */
function browserContextOf(browser: BrowserPassFacts): string {
  const lines = ['---', `The site of this task: ${browser.siteUrl}`]
  const notes = browser.agentNotes?.trim()
  if (notes) lines.push('', "The client's notes about the site:", notes)
  const saved = browser.saved.slice(-PROMPT_SAVED_OBJECTS)
  if (saved.length > 0) {
    lines.push(
      '',
      'Already saved on the site by this task (continue with these objects; never create another one for the same request; call web_verify first when one is not verified):',
    )
    const unlisted = browser.saved.length - saved.length
    if (unlisted > 0) lines.push(`- ${unlisted} earlier objects are not listed`)
    for (const object of saved) lines.push(`- ${savedObjectLine(object)}`)
  }
  const files = browser.attachments.slice(-PROMPT_ATTACHMENTS)
  if (files.length > 0) {
    lines.push('', 'Files the client sent with this task (upload them with web_upload by id):')
    for (const file of files)
      lines.push(`- ${file.id}: ${file.fileName}, ${file.contentType}, ${sizeOf(file.sizeBytes)}`)
  }
  return lines.join('\n')
}

/** The files of a task a turn with a repository gets, and how many earlier ones it does not. */
export interface TurnInboxPlan {
  /** Their paths under SANDBOX_INBOX, in the order they were sent. */
  paths: string[]
  omitted: number
}

/**
 * The files that go into the sandbox of a turn with a repository (spec §8, «Подготовка»): the
 * latest, as many as turnInboxLimits lets one turn hold, so that the files of the message being
 * answered are always there; the earlier ones do not fit. A file whose path would not pass the
 * plan's rule is left out too.
 */
export function turnInboxOf(files: readonly TaskAttachmentFacts[]): TurnInboxPlan {
  const paths: string[] = []
  let bytes = 0
  for (const file of files.toReversed()) {
    if (paths.length === turnInboxLimits.files || bytes + file.sizeBytes > turnInboxLimits.bytes)
      break
    const path = turnInboxPath(file.id, file.fileName)
    if (path === null) continue
    paths.push(path)
    bytes += file.sizeBytes
  }
  return { paths: paths.reverse(), omitted: files.length - paths.length }
}

/** The prompt of a pass in the cloud browser: the client's words, then what the platform adds. */
function browserPromptOf(facts: PassFacts, browser: BrowserPassFacts, since: Date | null): string {
  const context = browserContextOf(browser)
  const words = promptOf(facts.requests, since, turnPlanLimits.prompt - context.length - 2)
  return `${words}\n\n${context}`
}

/**
 * Where a pass without a repository starts (docs/plan/57, Б3, Б4): there is no branch to read,
 * so turns are chained by their checkpoints — a completed turn is continued from its snapshot,
 * as the product store requires; after an unsuccessful one a new session starts.
 */
function startWithoutRepository(
  facts: PassFacts,
  driver: AgentDriver,
): StartWithoutRepository | null {
  const last = facts.turns.get(facts.task.turnNo)
  if (!last) return facts.task.turnNo === 0 ? { since: null } : null
  if (last.status !== 'completed') return { since: null }
  const previous = snapshotOf(facts, driver, last)
  return previous ? { previous, since: last.startedAt } : null
}

/**
 * The plan of one pass, or why there is none. The budget comes first: a key that cannot
 * cover a first call is a question to the client, not a turn (Р8).
 */
export async function planTurn(facts: PassFacts, env: PlannerEnvironment): Promise<PassPlan> {
  const { task, requirements } = facts
  // The product takes a task with the repository or with the browser, not both yet (Б3).
  if (requirements.repository && requirements.browser)
    return { kind: 'refused', code: 'not_accepted' }
  if (requirements.repository && !facts.repo) return { kind: 'refused', code: 'not_accepted' }
  // A stack whose adapter has no browser support takes no task in the browser.
  const browser = requirements.browser ? facts.browser : undefined
  if (requirements.browser && !browser?.guide) return { kind: 'refused', code: 'not_accepted' }
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

  // The client's variables reach the commands of a repository turn; a turn in the browser works
  // through the `web` tools alone, and its commands reach nothing (Б20).
  const egress = requirements.repository ? (facts.egress ?? []) : []
  // One gateway variable holds them: more than it takes is no turn.
  if (egress.length > MAX_SANDBOX_EGRESS_HOSTS) return { kind: 'refused', code: 'technical' }
  const internet = env.internet
  const skills = internet ? (facts.skills ?? []) : []

  let start: Start | StartWithoutRepository
  let workspace: PublicationSource | undefined
  if (requirements.repository && facts.repo) {
    const started = await startOf(facts, env)
    if (!started) return { kind: 'refused', code: 'technical' }
    // A later turn publishes by CAS against the branch: one that stands elsewhere would fail the
    // turn at its end, after its money was spent. The first turn creates the branch.
    if (task.turnNo > 0) {
      const expected =
        started.expectedBranchSha === undefined
          ? started.expectedBaseSha
          : started.expectedBranchSha
      if ((await env.branchHead()) !== expected)
        return { kind: 'branch_moved', update: pendingUpdate(facts) }
    }
    start = started
    workspace = {
      repo: { provider: facts.repo.provider, owner: facts.repo.owner, name: facts.repo.name },
      branch: `agent/${task.id}`,
      expectedBaseSha: started.expectedBaseSha,
      ...(started.expectedBranchSha !== undefined
        ? { expectedBranchSha: started.expectedBranchSha }
        : {}),
      protectedPaths: [...facts.rules.protectedPaths],
      ...(facts.rules.workingSet ? { workingSet: facts.rules.workingSet } : {}),
      ...(facts.rules.addOnlyPaths?.length && facts.rules.media
        ? { addOnlyPaths: [...facts.rules.addOnlyPaths], media: facts.rules.media }
        : {}),
    }
  } else {
    const started = startWithoutRepository(facts, env.driver)
    if (!started) return { kind: 'refused', code: 'technical' }
    start = started
  }
  const turn = task.turnNo + 1
  const sessionId = task.id
  const reasoningEffort = reasoningEffortByClass[task.modelClass]
  // The client's files go into the sandbox of a turn with a repository; a task in the browser
  // hands them to the browser worker instead (Б26).
  const inbox = workspace ? turnInboxOf(facts.attachments ?? []) : null
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
        ...(internet ? { internet: true as const } : {}),
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
      // Rule 8: by what the task needs, never by its stack — the adapter's guide says the rest.
      instructions: browser?.guide
        ? browserTaskInstructions(
            browser.guide,
            internet ? { skills: skills.map((skill) => skill.name) } : null,
          )
        : turnInstructions(
            facts.preview,
            { names: facts.variables ?? [], hosts: egress },
            facts.databaseGuide,
            facts.rules,
            internet ? { skills: skills.map((skill) => skill.name) } : null,
            inbox?.paths.length ? { files: inbox.paths.length, omitted: inbox.omitted } : null,
          ),
      ...(egress.length || internet ? { egressProxy: SANDBOX_EGRESS_PROXY_URL } : {}),
      ...(internet ? { internet: true as const } : {}),
      ...(skills.length ? { skills: [...skills] } : {}),
    },
    input: {
      prompt: browser
        ? browserPromptOf(facts, browser, start.since)
        : promptOf(facts.requests, start.since),
      // Their paths only: core puts the files there when the sandbox is prepared.
      attachments: inbox?.paths ?? [],
    },
    driverVersion: env.driver.cliVersion,
    // A plan of a repository task keeps the shape it had before the requirements (Б3).
    ...(workspace ? { workspace } : { requirements: { ...requirements } }),
    committedAt: facts.committedAt.toISOString(),
    ...(start.previous ? { previous: start.previous } : {}),
    ...('replacesTurn' in start && start.replacesTurn !== undefined
      ? { replacesTurn: start.replacesTurn }
      : {}),
    ...('rebased' in start && start.rebased ? { rebased: true } : {}),
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
  return { kind: 'turn', request, policy, turn, requirements: { ...requirements } }
}

/** A plan saved by an assignment, or null when it no longer passes its schema (history). */
export function savedPlanOf(value: unknown): TurnPlan | null {
  const parsed = turnPlanSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
