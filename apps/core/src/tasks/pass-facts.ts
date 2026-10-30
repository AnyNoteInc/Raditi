import { attemptCreditBudget } from '@repo/billing'
import {
  classProfile,
  taskAttachments,
  taskBrowserCheckpoints,
  type BrowserCheckpointRecord,
  type PrismaClient,
} from '@repo/db'
import {
  egressHostListSchema,
  egressHostsOf,
  envVarReachesAgent,
  isDomainError,
  modelClassSchema,
  previewOrigin,
  previewUnavailableReasons,
  readFeedRow,
  siteWorkspaceRules,
  turnSkillsOf,
  type LlmBackend,
  type PreviewAddress,
  type SiteAdapter,
  type SiteFacts,
  type SiteStack,
} from '@repo/domain'

import type { PreviewFacts } from './turn-instructions.ts'
import {
  savedPlanOf,
  type BrowserPassFacts,
  type ClientRequest,
  type FinishedTurn,
  type PassBudget,
  type PassFacts,
  type SavedObjectFacts,
  type TaskAttachmentFacts,
  type WorkspaceRules,
} from './turn-planner.ts'

export interface PassFactsInput {
  taskId: string
  attempt: number
  /** `tasks.turn_no` when the pass was claimed. */
  turnNo: number
  /** The `feed.request` the pass answers. */
  requestEventId: string
  now: Date
}

export interface PassFactsDependencies {
  db: PrismaClient
  adapter: (stack: SiteStack) => SiteAdapter
  backends: readonly LlmBackend[]
  /** Where previews are served; null — previews are off in this core. */
  previews: PreviewAddress | null
}

/**
 * What the facts of a site are known by in core today: its stack and address. The docroot and
 * versions come with the connection of the site (plan 39); the adapters read none of them for
 * the paths a pass needs.
 */
export const siteFactsOf = (site: { stack: SiteStack; url: string }): SiteFacts => ({
  stack: site.stack,
  url: site.url,
  docroot: '/',
  extras: {},
})

const turnStatus = (status: string): FinishedTurn['status'] =>
  status === 'completed' || status === 'failed' || status === 'lost' || status === 'cancelled'
    ? status
    : 'other'

/**
 * The workspace rules of the stack in one call (R4), or its protected paths alone while its
 * adapter has no working set or media rules yet: the turn then gets the full tree.
 */
export function workspaceRulesOf(adapter: SiteAdapter, site: SiteFacts): WorkspaceRules {
  try {
    return siteWorkspaceRules(adapter, site)
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_IMPLEMENTED')
      return { protectedPaths: adapter.protectedPaths(site) }
    throw error
  }
}

function previewFactsOf(
  preview: { status: string; hostname: string; unavailableReason: string | null } | null,
  address: PreviewAddress | null,
): PreviewFacts {
  if (!preview) return { state: 'absent' }
  if (preview.status === 'unavailable') {
    const reason = previewUnavailableReasons.find((known) => known === preview.unavailableReason)
    return { state: 'unavailable', reason: reason ?? 'not_supported' }
  }
  if (preview.status === 'ready' && address)
    return { state: 'serving', origin: previewOrigin(preview.hostname, address) }
  // Being built — the first build of the dialog, or one the start of this pass asked for after
  // the preview stopped unused (owner's answer of 26.10.2026).
  if (['pending', 'building', 'expired'].includes(preview.status) && address)
    return { state: 'starting', origin: previewOrigin(preview.hostname, address) }
  return { state: 'absent' }
}

/**
 * Reads what the planner of a pass needs, in PostgreSQL only. null — the request of the job is
 * not a request of this task (a stale or foreign job). A refusal of the budget (no credit rate,
 * no priced model) is thrown as the domain error it is.
 */
export async function readPassFacts(
  deps: PassFactsDependencies,
  input: PassFactsInput,
): Promise<PassFacts | null> {
  const { db } = deps
  const task = await db.task.findUnique({
    where: { id: input.taskId },
    select: {
      id: true,
      workspaceId: true,
      siteId: true,
      modelClass: true,
      billable: true,
      needsRepository: true,
      needsBrowser: true,
      site: {
        select: {
          stack: true,
          url: true,
          agentNotes: true,
          workspace: { select: { dataClass: true } },
          agentSkills: { select: { name: true, url: true, enabled: true } },
        },
      },
    },
  })
  if (!task) return null
  const requirements = { repository: task.needsRepository, browser: task.needsBrowser }
  const rows = await db.taskEvent.findMany({
    where: { taskId: task.id, type: 'feed.request' },
    orderBy: { id: 'asc' },
    select: { id: true, payload: true, createdAt: true },
  })
  const answered = rows.find((row) => row.id === BigInt(input.requestEventId))
  if (!answered) return null
  const requests: ClientRequest[] = rows.map((row) => {
    const event = readFeedRow('feed.request', row.payload)
    const text =
      event.type === 'feed.request' && 'text' in event && typeof event.text === 'string'
        ? event.text
        : null
    const kind = event.type === 'feed.request' ? event.kind : 'unreadable'
    const command = event.type === 'feed.request' && event.kind === 'command' ? event.command : null
    // A command is a press: its row never reaches the agent (Р34).
    return {
      id: row.id,
      kind,
      text: kind === 'command' ? null : text,
      command,
      createdAt: row.createdAt,
    }
  })

  const [repository, turnRows, assignments, candidate, preview, variables] = await Promise.all([
    db.gitRepository.findFirst({
      where: { siteId: task.siteId },
      orderBy: { createdAt: 'asc' },
      select: { provider: true, owner: true, name: true, defaultBranch: true },
    }),
    db.taskTurn.findMany({
      where: { taskId: task.id },
      select: {
        turnNo: true,
        status: true,
        headSha: true,
        startedAt: true,
        nativeSessionId: true,
        rejectedAt: true,
      },
    }),
    db.turnAssignment.findMany({
      where: { taskId: task.id, finishedAt: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { turnNo: true, plan: true },
    }),
    // The latest revision whatever its status: an «Обновить» that left nothing to release while
    // a pass of the dialog was queued records its head as a revision superseded at once (R3).
    db.taskCandidate.findFirst({
      where: { taskId: task.id },
      orderBy: { revision: 'desc' },
      select: { turnNo: true, headSha: true },
    }),
    db.previewEnvironment.findUnique({
      where: { taskId: task.id },
      select: { status: true, hostname: true, unavailableReason: true },
    }),
    db.siteEnvVar.findMany({
      where: { siteId: task.siteId, toAgent: true, agentConsentAt: { not: null } },
      orderBy: { name: 'asc' },
      select: { name: true, hosts: true, toAgent: true, toPreview: true, agentConsentAt: true },
    }),
  ])
  const plans = new Map(assignments.map((row) => [row.turnNo, savedPlanOf(row.plan)]))
  const turns = new Map<number, FinishedTurn>(
    turnRows.map((row) => [
      row.turnNo,
      {
        turnNo: row.turnNo,
        status: turnStatus(row.status),
        rejected: row.rejectedAt !== null,
        headSha: row.headSha,
        startedAt: row.startedAt,
        nativeSessionId: row.nativeSessionId,
        plan: plans.get(row.turnNo) ?? null,
      },
    ]),
  )
  const published = turnRows
    .filter((row) => row.status === 'completed' && row.headSha)
    .sort((a, b) => b.turnNo - a.turnNo)[0]
  // A candidate whose head is not the head of its turn was moved by «Обновить» (Р27): when
  // no turn completed after it, its head is what the task branch holds.
  const rebased =
    candidate && candidate.headSha !== (turns.get(candidate.turnNo)?.headSha ?? null)
      ? candidate
      : null
  const writtenHead =
    rebased && rebased.turnNo >= (published?.turnNo ?? 0)
      ? rebased.headSha
      : (published?.headSha ?? null)

  const modelClass = modelClassSchema.safeParse(task.modelClass ?? 'standard')
  if (!modelClass.success) return null
  // The same query «Попробовать ещё» asks before it moves a dialog into a class.
  const chosen = await classProfile(db, {
    modelClass: modelClass.data,
    backends: deps.backends.map((backend) => backend.id),
  })
  const profile = chosen
    ? {
        backend: chosen.backend,
        modelSlug: chosen.modelSlug,
        providerModelId: chosen.providerModelId,
      }
    : undefined

  const budget: PassBudget = task.billable
    ? {
        kind: 'credits',
        budget: await attemptCreditBudget(db, {
          taskId: task.id,
          attempt: input.attempt,
          now: input.now,
        }),
      }
    : { kind: 'quota' }

  // The variables the agent's commands get and the hosts they reach through the egress proxy
  // (plan 53, Р13): none in a workspace of client data.
  const agentVariables = variables.filter((variable) =>
    envVarReachesAgent(variable, task.site.workspace.dataClass),
  )
  const egress = egressHostsOf(
    agentVariables.map((variable) => {
      const hosts = egressHostListSchema.safeParse(variable.hosts)
      return { hosts: hosts.success ? hosts.data : [] }
    }),
  )

  const site = siteFactsOf(task.site)
  // The repository's rules and the database guide are of a repository task; a task in the
  // browser takes the stack's guide to its admin pages instead (docs/plan/57, Б20, Б21).
  const adapter = requirements.repository ? deps.adapter(task.site.stack) : null
  const rules: WorkspaceRules = adapter ? workspaceRulesOf(adapter, site) : { protectedPaths: [] }
  const browser = requirements.browser
    ? await browserFactsOf(deps, task.id, {
        stack: task.site.stack,
        url: task.site.url,
        agentNotes: task.site.agentNotes,
      })
    : undefined
  // The files of a repository task go into the sandbox of its turn (spec §8, «Подготовка»).
  const attachments = requirements.repository
    ? attachmentFactsOf(await taskAttachments(deps.db, task.id))
    : []
  return {
    task: {
      id: task.id,
      workspaceId: task.workspaceId,
      siteId: task.siteId,
      attempt: input.attempt,
      turnNo: input.turnNo,
      modelClass: modelClass.data,
    },
    requirements,
    ...(browser ? { browser } : {}),
    ...(attachments.length ? { attachments } : {}),
    repo: repository
      ? {
          provider: repository.provider,
          owner: repository.owner,
          name: repository.name,
          defaultBranch: repository.defaultBranch,
        }
      : null,
    rules,
    requests,
    committedAt: answered.createdAt,
    turns,
    writtenHead,
    candidate: candidate ?? null,
    preview: previewFactsOf(preview, deps.previews),
    egress,
    variables: agentVariables.map((variable) => variable.name),
    skills: turnSkillsOf(task.site.agentSkills),
    ...(adapter ? { databaseGuide: adapter.dbPlanGuide(site) } : {}),
    profile: profile ?? null,
    budget,
    now: input.now,
  }
}

/**
 * A title that may hold an e-mail address or a phone number. The agent meets contacts only as
 * the markers of the `mcp` role's privacy map, which core does not hold; the title the site
 * keeps has the real ones, so such a title is not told at all (the editor shows it masked).
 */
const MAY_HOLD_CONTACT = /@|\d(?:[\s().+-]*\d){6}/u

/**
 * An object the task saved, as a pass tells the agent of it (Б22): one it only looked at
 * (`seen`) is none. Its editor goes by its path alone: a query string is left out whatever it
 * holds. `verified` without what a read found is not trusted (browserFeedObjectOf): the agent
 * verifies it again.
 */
export function savedObjectOf(checkpoint: BrowserCheckpointRecord): SavedObjectFacts | null {
  if (checkpoint.state === 'seen') return null
  const found = checkpoint.state === 'verified' ? checkpoint.verified : null
  return {
    kind: checkpoint.ref.kind,
    objectId: checkpoint.ref.objectId,
    state: checkpoint.state === 'verified' && !found ? 'unverified' : checkpoint.state,
    ...(found
      ? {
          ...(MAY_HOLD_CONTACT.test(found.title) ? {} : { title: found.title }),
          status: found.status,
        }
      : {}),
    editPath: new URL(checkpoint.ref.editUrl).pathname,
  }
}

/** The files bound to a task as a pass tells the agent of them: never their key. */
const attachmentFactsOf = (
  rows: readonly { id: string; fileName: string; contentType: string; sizeBytes: number }[],
): TaskAttachmentFacts[] =>
  rows.map((file) => ({
    id: file.id,
    fileName: file.fileName,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
  }))

/**
 * What a pass in the cloud browser needs of its site: the address, the client's notes, the files
 * bound to the task, what the task saved there and the stack's guide to its admin pages — null
 * when the stack has no adapter or no browser support yet (the planner refuses the task then).
 */
async function browserFactsOf(
  deps: PassFactsDependencies,
  taskId: string,
  site: { stack: SiteStack; url: string; agentNotes: string | null },
): Promise<BrowserPassFacts> {
  const [attachments, checkpoints] = await Promise.all([
    taskAttachments(deps.db, taskId),
    taskBrowserCheckpoints(deps.db, taskId),
  ])
  let guide: string | null
  try {
    guide = deps.adapter(site.stack).browserGuide()
  } catch (error) {
    if (!isDomainError(error) || error.code !== 'NOT_IMPLEMENTED') throw error
    guide = null
  }
  return {
    siteUrl: site.url,
    agentNotes: site.agentNotes,
    attachments: attachmentFactsOf(attachments),
    saved: checkpoints.flatMap((checkpoint) => savedObjectOf(checkpoint) ?? []),
    guide,
  }
}
