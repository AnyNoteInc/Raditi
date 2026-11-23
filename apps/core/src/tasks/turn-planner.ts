import type { AttemptCreditBudget } from '@repo/billing'
import {
  askedToRemember,
  clientInstructionsSection,
  memorySection,
  projectContextSection,
  projectSection,
  repositorySection,
  type UnavailableRepositoryFacts,
  turnProjectPath,
  type MemorySectionEntry,
  type ProjectContextFile,
  type ProjectSectionFacts,
  type RepoMode,
  type RepoProviderKind,
  type TurnRepository,
} from '@repo/domain'
import {
  attemptBudgetRub,
  TURN_LEASE_TTL_MS,
  Money,
  SANDBOX_EGRESS_PORT,
  turnInboxAttachmentId,
  turnInboxLimits,
  turnInboxPath,
  turnPlanLimits,
  turnPlanSchema,
  requestedFileFormats,
  type AgentDriver,
  type FeedFailureCode,
  type FeedQuestionPayload,
  type LlmBackend,
  type LlmBackendId,
  type ModelClass,
  type SandboxRuntime,
  type SnapshotReference,
  type TaskRequirements,
  type TurnAction,
  type TurnCredentialPolicy,
  type TurnPlan,
  type TurnSkill,
  type UnkeyedTurnRequest,
} from '@repo/domain'

import {
  artifactCommentsSection,
  artifactsSection,
  type ArtifactCommentSection,
  type ArtifactSectionBrand,
  type ChatArtifactLine,
} from '@repo/domain/artifacts'

import { llmGatewayBaseUrl } from '../llm/backends.ts'
import { ceilingQuestionOf } from './turn-outcome.ts'
import {
  CONTINUE_PROMPT,
  openTaskInstructions,
  CHAT_TITLE_SECTION,
  requestedFormatsSection,
  TURN_RESOURCES,
  unattendedSection,
} from './turn-instructions.ts'

// The planner of a pass (roadmap N11): what the turn supervisor is asked to run and under which
// key policy, from the facts of the chat read in PostgreSQL. Pure: the reader of the facts
// (pass-facts.ts) does the I/O. A chat has no site and no repository
// (docs/plan/83-remove-projects.md): its turns are chained by their checkpoints. No branch names
// an agent shell or a backend (CLAUDE.md rule 8).

/** The address of sandbox-gw inside the isolated network of a turn (spec §8 «Сеть»). */
export const SANDBOX_GATEWAY_URL = 'http://sandbox-gw:8080' // NOSONAR: plain HTTP stays inside the turn's internal network (spec §8)
/**
 * The egress proxy on sandbox-gw: the agent's commands reach the public internet through it, by
 * CONNECT, so their TLS runs end to end.
 */
export const SANDBOX_EGRESS_PROXY_URL = `http://sandbox-gw:${SANDBOX_EGRESS_PORT}` // NOSONAR: as above, CONNECT carries the client's own TLS

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

/** A row of the dialog's feed the prompt is built from: what the client wrote or pressed. */
export interface ClientRequest {
  id: bigint
  kind: string
  /**
   * The client's words, or the words of the platform of an `agent_command`; absent for a press
   * (`retry`, `command`).
   */
  text: string | null
  /** What an `agent_command` asks of the turn itself instead of words (`/compact`). */
  action?: TurnAction
  /** The command of a press (`cancel`, …), or null. */
  command: string | null
  /** The ids of the files sent with these words. */
  attachments?: readonly string[]
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
  /**
   * The client took it back by `/undo` (`task_turns.undone_at`): its words do not go to the agent
   * and no turn goes on from it (docs/plan/61-chats-first.md, §5.14).
   */
  undone: boolean
  startedAt: Date | null
  nativeSessionId: string | null
  /** Only the checkpoint metadata of `turn_assignments.plan`, never its instructions or input. */
  plan: CheckpointPlan | null
}

type CheckpointPlan = Pick<TurnPlan, 'driverId' | 'driverVersion'> & {
  sandbox: Pick<TurnPlan['sandbox'], 'image'>
  context: Pick<
    TurnPlan['context'],
    'taskId' | 'sessionId' | 'turn' | 'llm' | 'mcp' | 'nativeSessionId'
  >
  previous?: TurnPlan['previous'] | null
  repository?: Pick<TurnRepository, 'projectRepositoryId'> | null
}

/** A file the client sent with the task, as the agent is told of it: never its key or address. */
export interface TaskAttachmentFacts {
  id: string
  fileName: string
  contentType: string
  sizeBytes: number
}

/** The repository of the chat's project as the facts read it, before its pass prepares it (ПР12). */
export interface PassRepositoryRow {
  projectId: string
  projectRepositoryId: string
  provider: RepoProviderKind
  path: string
  defaultBranch: string
  mode: RepoMode
  /** The files gitleaks flagged when the repository was connected: never in a sandbox (ПР35). */
  secretsFound: readonly string[]
}

/**
 * The repository prepared for the pass (docs/plan/84-projects.md, §4.3, step 3): fetched, its base
 * chosen, its bundle built and its hidden files named.
 */
export interface PassRepository extends PassRepositoryRow {
  /** The brand of its provider (`support.label`). */
  label: string
  baseSha: string
  sandboxBaseSha: string
  branch: string
  expectedRef: string | null
  bundleSha256: string
  bundleBytes: number
  hiddenPaths: readonly string[]
}

export type PassBudget =
  | { kind: 'credits'; budget: AttemptCreditBudget }
  /** A task that holds no reserve by design (`billable = false`): the class ceiling. */
  | { kind: 'quota' }

export interface PassFacts {
  task: {
    id: string
    workspaceId: string
    attempt: number
    /** `tasks.turn_no` when the pass was claimed. */
    turnNo: number
    modelClass: ModelClass
  }
  /**
   * What the task works with (`tasks.needs_browser`): the browser, when the worker is configured.
   * No chat has a repository (docs/plan/83-remove-projects.md, БП2).
   */
  requirements: TaskRequirements
  /** The author's own instructions to the agent (docs/plan/76-agent-instructions.md, И2). */
  clientInstructions?: string | null
  /**
   * The project of the chat — its name, goal and instructions (docs/plan/84-projects.md, ПР7);
   * absent or null — a chat without a project, or one whose project is in the trash.
   */
  project?: ProjectSectionFacts | null
  /** The repository of the chat's project whose mirror is ready; null or absent — none (ПР12). */
  repositoryRow?: PassRepositoryRow | null
  /**
   * The repository of the chat's project whose mirror is not ready (19.11.2026): the pass goes
   * without its code, and its instructions say why and what to tell the client.
   */
  repositoryUnavailable?: UnavailableRepositoryFacts | null
  /**
   * The repository prepared for this pass (§4.3, step 3); absent or null — the pass goes without
   * one: the chat has none, its mirror is not ready, or the prepare was not asked for.
   */
  repository?: PassRepository | null
  /**
   * The ready files of the context of the chat's project (docs/plan/84-projects.md, ПР8), in the
   * order of their paths: every turn gets them all under /workspace/project, and the instructions
   * list them. Absent or empty — none.
   */
  projectFiles?: readonly ProjectContextFile[]
  /**
   * The active notes of the chat's memory (docs/plan/84-projects.md, ПР18): of its project, with
   * the account's when the project reads them, or the account's. Absent or null — the memory is
   * off for the author of the chat: no section, and the agent has no tools of it.
   */
  memory?: readonly MemorySectionEntry[] | null
  /**
   * The artifacts the chat made or edited, newest first (docs/plan/88-artifacts.md, Ар26): the
   * section `## Artifacts` lists them as data. Absent or empty — none yet.
   */
  chatArtifacts?: readonly ChatArtifactLine[]
  /**
   * The artifacts of the chat's project (Ар26, slice 88.20): `<project-artifacts>` lists those not
   * in `chatArtifacts`, up to 30, without content. Absent — no project, or none.
   */
  projectArtifacts?: readonly ChatArtifactLine[]
  /**
   * The brand of the chat's project (docs/plan/88-artifacts.md, Ар42, slice 88.15а): its tokens go
   * into the section `## Artifacts` as data. Absent — the project has none, or no project.
   */
  projectBrand?: ArtifactSectionBrand
  /** Private data selected for this exact request, never the history of notes. */
  artifactComments?: ArtifactCommentSection
  artifactCommentSourceId?: bigint
  /**
   * The pass of a run of a scheduled task before the first words of its client (`passUnattended`,
   * docs/plan/82-scheduled-tasks.md, Зп27, Зп29), with the name of its task; absent — an ordinary
   * pass.
   */
  unattended?: { name: string } | null
  /**
   * The files bound to the chat, in the order they were sent: the latest go into the sandbox of
   * its turn (turnInboxOf). Absent or empty — none.
   */
  attachments?: readonly TaskAttachmentFacts[]
  /** The rows of `feed.request`, oldest first. */
  requests: readonly ClientRequest[]
  /** When the request this pass answers was written. */
  committedAt: Date
  /** Turns of the task by number, those the plan reads. */
  turns: ReadonlyMap<number, FinishedTurn>
  /** The names of the workspace's variables the agent's commands get (БП4): never a value. */
  variables?: readonly string[]
  /** The skills every turn has: the platform's own; a turn gets them with the internet. */
  skills?: readonly TurnSkill[]
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
  /** core is configured for the browser worker (`apps/browser`). */
  browser: boolean
}

export type PassPlan =
  | {
      kind: 'turn'
      request: UnkeyedTurnRequest
      policy: TurnCredentialPolicy
      /** The turn the pass opens: `tasks.turn_no + 1`. */
      turn: number
      /** The task's own: its browser comes back with the turn, or starts on `web_*` (К11). */
      requirements: TaskRequirements
      /**
       * The client's own words of the pass ask to remember (askedToRemember, ПР18): a note of the
       * agent may be active at once only then.
       */
      remember: boolean
      /**
       * Nobody watches the pass: a run of a scheduled task before its client wrote (Зп27). Its notes
       * of memory are only proposed (docs/plan/84-projects.md, ПР19).
       */
      unattended: boolean
    }
  /** The key cannot cover a first call: the platform asks «Продолжить?» (Р8). */
  | {
      kind: 'ceiling'
      question: Extract<FeedQuestionPayload, { kind: 'ceiling' }>
      artifactCommentSourceId?: bigint
    }
  /** The pass cannot be planned; the task fails with this code, no turn is opened. */
  | { kind: 'refused'; code: FeedFailureCode }

/**
 * The words the client wrote after `since` (all of them for a new session), oldest first, in at
 * most `limit` characters. The words of the platform of a command are a request of their turn, not
 * part of the story: a new session retells what the client said, and an `/init` of long ago is not
 * carried out again; only the newest request goes (docs/plan/61-chats-first.md, §5.14).
 */
export function promptOf(
  requests: readonly ClientRequest[],
  since: Date | null,
  limit: number = turnPlanLimits.prompt,
  fallback = CONTINUE_PROMPT,
): string {
  const told = requests.filter((request) => request.text !== null)
  const newest = told.at(-1)
  const words = told
    .filter((request) => since !== null || request.kind !== 'agent_command' || request === newest)
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
  return kept.length > 0 ? kept.join('\n\n') : fallback
}

/** A turn with an action reads no words, and a plan has them: no model is told this. */
const ACTION_PROMPT = 'An action of the platform.'

/** Where a pass starts: its checkpoint chain only (startOf). */
interface Start {
  previous?: SnapshotReference
  rewound?: true
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
  const prepared = {
    context: {
      ...plan.context,
      llm: { ...plan.context.llm, apiKey: '' },
      mcp: { ...plan.context.mcp, token: '' },
      instructions: '',
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

/** At most this many files are listed to the agent: the rest are older than the turn needs. */
const PROMPT_ATTACHMENTS = 50

const sizeOf = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`

/**
 * What the platform adds to the client's words when the chat has the browser (docs/plan/57,
 * Б26): the files sent with the chat — id, name, type and size and their path in the sandbox,
 * never a key or an address of the file: the agent puts one on a page with `web_upload` by id.
 */
function browserFilesContext(
  files: readonly TaskAttachmentFacts[],
  inbox: readonly string[],
): string {
  const listed = files.slice(-PROMPT_ATTACHMENTS)
  if (listed.length === 0) return ''
  const pathOf = new Map(inbox.map((path) => [turnInboxAttachmentId(path), path]))
  const lines = [
    '---',
    'Files the client sent with this task (read them at their paths; upload them to a page with web_upload by id):',
  ]
  for (const file of listed) {
    const path = pathOf.get(file.id.toLowerCase())
    lines.push(
      `- ${file.id}: ${file.fileName}, ${file.contentType}, ${sizeOf(file.sizeBytes)}${path ? `, at ${path}` : ''}`,
    )
  }
  return lines.join('\n')
}

/** A prompt: the client's words, then what the platform adds, which is always kept whole. */
function promptWith(
  facts: PassFacts,
  context: string,
  since: Date | null,
  hasNotes: boolean,
): string {
  const requests = requestsNotUndone(facts)
  const fallback = hasNotes
    ? 'Рассмотрите выбранные клиентом заметки к артефакту. Если следующая задача неясна, попросите уточнить её.'
    : CONTINUE_PROMPT
  if (context === '') return promptOf(requests, since, turnPlanLimits.prompt, fallback)
  const words = promptOf(requests, since, turnPlanLimits.prompt - context.length - 2, fallback)
  return `${words}\n\n${context}`
}

/** The files of a task its turn gets, and how many earlier ones it does not. */
export interface TurnInboxPlan {
  /** Their paths under SANDBOX_INBOX, in the order they were sent. */
  paths: string[]
  omitted: number
}

/**
 * The files that go into the sandbox of a turn (spec §8, «Подготовка»): the
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

/** Whether a row of the feed holds words of a turn the client undid. */
function wordsOfUndone(facts: PassFacts, { createdAt }: ClientRequest): boolean {
  return [...facts.turns.values()].some((turn) => {
    if (!turn.undone || turn.startedAt === null) return false
    const before = facts.turns.get(turn.turnNo - 1)?.startedAt ?? null
    return (
      createdAt.getTime() <= turn.startedAt.getTime() &&
      (before === null || createdAt.getTime() > before.getTime())
    )
  })
}

/**
 * The rows the agent may be told of: all but the words of a turn the client undid, those written
 * after the turn before it started and up to its own start. A new session retells the rest, and a
 * restored one saw none of those (docs/plan/61-chats-first.md, §5.14).
 */
function requestsNotUndone(facts: PassFacts): readonly ClientRequest[] {
  return facts.requests.filter((request) => !wordsOfUndone(facts, request))
}

/** The files the agent may be told of: those of an undone request go with its words. */
function filesNotUndone<File extends { id: string }>(
  facts: PassFacts,
  files: readonly File[],
): readonly File[] {
  const undone = new Set(
    facts.requests.flatMap((request) =>
      wordsOfUndone(facts, request) ? (request.attachments ?? []) : [],
    ),
  )
  return files.filter((file) => !undone.has(file.id))
}

/**
 * The client's own words of the pass, as the prompt carries them and nothing the platform adds:
 * the format the client asks for is read from them (docs/plan/67-agent-documents.md, Д1).
 */
function clientWordsOf(facts: PassFacts, since: Date | null): string {
  return promptOf(requestsNotUndone(facts), since)
}

/**
 * The client's own words this pass answers (docs/plan/84-projects.md, ПР18): those written after
 * the last turn of the chat started — all of them before its first — and never the words of the
 * platform of a command. Whether they ask to remember is read from them alone.
 */
function passWordsOf(facts: PassFacts): string {
  const since = facts.turns.get(facts.task.turnNo)?.startedAt ?? null
  return requestsNotUndone(facts)
    .filter((request) => request.kind !== 'agent_command' && request.text !== null)
    .filter((request) => since === null || request.createdAt.getTime() > since.getTime())
    .map((request) => request.text!)
    .join('\n\n')
}

/**
 * The action of the pass, among the requests the session it restores has not seen. A retry or
 * «Продолжить» after a compaction that did not end repeats it, for they say nothing of their own.
 * Words among them, before or after the command, come first: no compaction would tell them to
 * anyone, and the next turn would take them for seen. A pass that restores no session has nothing to
 * shorten, and a new session is told only the client's words: it goes as words would
 * (docs/plan/61-chats-first.md, §5.14).
 */
function actionOf(facts: PassFacts, start: Start): TurnAction | undefined {
  if (!start.previous) return undefined
  const { since } = start
  const unseen = requestsNotUndone(facts).filter(
    (request) => since === null || request.createdAt.getTime() > since.getTime(),
  )
  if (unseen.some((request) => request.text !== null)) return undefined
  return unseen.findLast((request) => request.action !== undefined)?.action
}

/**
 * Where a pass starts (docs/plan/57, Б3, Б4): there is no branch to read, so turns are chained
 * by their checkpoints — a completed turn is continued from its snapshot,
 * as the product store requires; after an unsuccessful one a new session starts. After one the
 * client undid the pass starts where that turn started, from its checkpoint or as a new session:
 * nothing else of it is taken back (docs/plan/61-chats-first.md, §5.14).
 */
function startOf(facts: PassFacts, driver: AgentDriver): Start | null {
  const last = facts.turns.get(facts.task.turnNo)
  if (!last) return facts.task.turnNo === 0 ? { since: null } : null
  if (last.undone) {
    const previous = last.plan?.previous
    if (!last.plan) return null
    if (!previous || !sameCli(previous, driver)) return { rewound: true, since: null }
    return { previous, rewound: true, since: facts.turns.get(previous.turn)?.startedAt ?? null }
  }
  if (last.status !== 'completed') return { since: null }
  const previous = snapshotOf(facts, driver, last)
  if (!previous) return null
  // A release that brings another version of the CLI cannot restore its session: the chat goes
  // on in a new one, told every word of the client, rather than failing each pass for good.
  return sameCli(previous, driver) ? { previous, since: last.startedAt } : { since: null }
}

/** The checkpoint was sealed by the CLI the turn runs: its session can be restored. */
const sameCli = (previous: SnapshotReference, driver: AgentDriver): boolean =>
  previous.driver.id === driver.id && previous.driver.version === driver.cliVersion

/**
 * The plan of one pass, or why there is none. The budget comes first: a key that cannot
 * cover a first call is a question to the client, not a turn (Р8).
 */
export async function planTurn(facts: PassFacts, env: PlannerEnvironment): Promise<PassPlan> {
  const { task } = facts
  // A repository exactly when the pass prepared one (docs/plan/84-projects.md, ПР12).
  const repository = facts.repository ?? null
  const requirements: TaskRequirements = { ...facts.requirements, repository: repository !== null }
  // A chat goes on without a word of `web_*` when the browser worker is not there (§5.4).
  const browser = requirements.browser && env.browser
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
        ...(!facts.unattended &&
        facts.artifactComments &&
        facts.artifactCommentSourceId !== undefined
          ? { artifactCommentSourceId: facts.artifactCommentSourceId }
          : {}),
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

  // Every turn has the public internet through the egress proxy and the platform's skills
  // (owner's decisions of 26.10.2026).
  const skills = facts.skills ?? []
  const internet = { skills: skills.map((skill) => skill.name) }

  const start = startOf(facts, env.driver)
  if (!start) return { kind: 'refused', code: 'technical' }
  const comments = facts.unattended ? undefined : facts.artifactComments
  const action = comments ? undefined : actionOf(facts, start)
  // Whether the repository of the chat came, went or changed since the turn whose session this
  // pass restores (ПР32): only the session of that checkpoint is taken then.
  const before = start.previous
    ? (facts.turns.get(start.previous.turn)?.plan?.repository?.projectRepositoryId ?? null)
    : null
  const changed =
    start.previous !== undefined && before !== (repository?.projectRepositoryId ?? null)
  const repositoryBlock: TurnRepository | undefined = repository
    ? {
        projectId: repository.projectId,
        projectRepositoryId: repository.projectRepositoryId,
        provider: repository.provider,
        baseSha: repository.baseSha,
        sandboxBaseSha: repository.sandboxBaseSha,
        branch: repository.branch,
        mode: repository.mode,
        expectedRef: repository.expectedRef,
        bundleSha256: repository.bundleSha256,
        bundleBytes: repository.bundleBytes,
        hiddenPaths: [...repository.hiddenPaths],
        ...(changed ? { repositoryChanged: true as const } : {}),
      }
    : undefined
  const repoSection = repository
    ? repositorySection({
        provider: repository.provider,
        path: repository.path,
        label: repository.label,
        branch: repository.branch,
        defaultBranch: repository.defaultBranch,
        baseSha: repository.baseSha,
        mode: repository.mode,
        hiddenPaths: repository.hiddenPaths,
        ...(changed ? { changed: 'connected' as const } : {}),
      })
    : facts.repositoryUnavailable
      ? repositorySection(facts.repositoryUnavailable)
      : changed && before !== null
        ? repositorySection({ changed: 'disconnected' })
        : ''
  const turn = task.turnNo + 1
  const sessionId = task.id
  const reasoningEffort = reasoningEffortByClass[task.modelClass]
  // The client's files go into the sandbox of the turn (docs/plan/61, К16).
  const inbox = action ? null : turnInboxOf(filesNotUndone(facts, facts.attachments ?? []))
  const inboxFacts = inbox?.paths.length
    ? { files: inbox.paths.length, omitted: inbox.omitted }
    : null
  // The files of the project, with the project: an action (a compaction) reads no file.
  const projectFiles = action || !facts.project ? [] : projectFilesOf(facts.projectFiles ?? [])
  const request: UnkeyedTurnRequest = {
    sandbox: {
      image: env.driver.image,
      labels: {
        workspaceId: task.workspaceId,
        // The row of the turn's lease is the chat's own (docs/plan/83-remove-projects.md, БП6).
        siteId: task.id,
        taskId: task.id,
        sessionId,
        turn,
      },
      runtime: env.runtime,
      resources: { ...TURN_RESOURCES },
      user: { ...SANDBOX_USER },
      env: {},
      secrets: [],
      network: { mode: 'gateway', routes: ['llm', 'mcp'], internet: true },
      // The first lease of the container, not a limit of the work: the turn renews it
      // (docs/plan/70-turn-without-time-limit.md, ВР1).
      hardTimeoutMs: TURN_LEASE_TTL_MS,
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
      // A run's chat has the name of its task, which the model never changes (docs/plan/82, Зп17).
      instructions: `${openTaskInstructions(internet, {
        browser,
        inbox: inboxFacts,
        variables: facts.variables ?? [],
        repository: repository !== null,
      })}${facts.task.turnNo === 0 && !facts.unattended ? CHAT_TITLE_SECTION : ''}${requestedFormatsSection(requestedFileFormats(clientWordsOf(facts, start.since)))}${repoSection}${facts.unattended ? unattendedSection(facts.unattended.name, { project: Boolean(facts.project), repository: repository !== null }) : ''}${clientInstructionsSection(facts.clientInstructions)}${projectSection(facts.project)}${projectContextSection(projectFiles.map((file) => file.facts))}${action ? '' : artifactsSection(facts.chatArtifacts ?? [], undefined, { brand: facts.projectBrand ?? null, project: facts.projectArtifacts ?? [] })}${memorySection(facts.memory)}${comments ? artifactCommentsSection(comments) : ''}`,
      egressProxy: SANDBOX_EGRESS_PROXY_URL,
      internet: true,
      ...(skills.length ? { skills: [...skills] } : {}),
    },
    input: action
      ? { prompt: ACTION_PROMPT, attachments: [], action }
      : {
          prompt: promptWith(
            facts,
            browser
              ? browserFilesContext(
                  filesNotUndone(facts, facts.attachments ?? []),
                  inbox?.paths ?? [],
                )
              : '',
            start.since,
            comments !== undefined,
          ),
          // Their paths only: core puts the files there when the sandbox is prepared.
          attachments: inbox?.paths ?? [],
          ...(projectFiles.length ? { projectFiles: projectFiles.map((file) => file.path) } : {}),
        },
    driverVersion: env.driver.cliVersion,
    requirements: { ...requirements },
    ...(repositoryBlock ? { repository: repositoryBlock } : {}),
    committedAt: facts.committedAt.toISOString(),
    ...(start.previous ? { previous: start.previous } : {}),
    ...(start.rewound ? { rewound: true as const } : {}),
  }
  const policy: TurnCredentialPolicy = {
    driverId: env.driver.id,
    backend: backend.id,
    modelSlug: facts.profile.modelSlug,
    modelClass: task.modelClass,
    reasoningEffort,
    // The first expiry of the key; every renewal of the turn moves it on (ВР3).
    ttlMs: TURN_LEASE_TTL_MS,
    budgetRub,
  }
  return {
    kind: 'turn',
    request,
    policy,
    turn,
    requirements: { ...requirements },
    remember: !action && askedToRemember(passWordsOf(facts)),
    unattended: Boolean(facts.unattended),
  }
}

/** A plan saved by an assignment, or null when it no longer passes its schema (history). */
export function savedPlanOf(value: unknown): TurnPlan | null {
  const parsed = turnPlanSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The files of the project a turn holds: each at its path; a name that is not one is left out. */
function projectFilesOf(
  files: readonly ProjectContextFile[],
): { path: string; facts: ProjectContextFile }[] {
  return files.flatMap((facts) => {
    const path = turnProjectPath(facts.name)
    return path === null ? [] : [{ path, facts }]
  })
}
