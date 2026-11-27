import { attemptCreditBudget } from '@repo/billing'
import {
  chatMemory,
  classProfile,
  attachMentionedArtifacts,
  listChatArtifacts,
  memoryEntriesOfPass,
  artifactCommentSourceOf,
  passUnattended,
  readArtifactCommentDispatch,
  markArtifactReadOther,
  readyProjectFiles,
  taskAttachments,
  turnAccountSkills,
  type PrismaClient,
} from '@repo/db'
import {
  DomainError,
  isDomainError,
  modelClassSchema,
  readFeedRow,
  repoMirrorStates,
  repoModes,
  repoProviderKinds,
  repoSecretsFoundPaths,
  turnPlanSchema,
  turnSkillsOf,
  type LlmBackend,
  type LlmBackendId,
  type ModelClass,
  type ProjectSectionFacts,
  type UnavailableRepositoryFacts,
} from '@repo/domain'
import { artifactCommentsByOthers, artifactMentionsOf } from '@repo/domain/artifacts'
import { z } from 'zod'

import type { PoolProbeClient } from '../llm/pool-probe-client.ts'
import { poolHasRoom } from '../llm/pool-room.ts'
import { AGENT_COMMANDS } from './turn-instructions.ts'
import type {
  ClientRequest,
  FinishedTurn,
  PassBudget,
  PassFacts,
  PassRepositoryRow,
  TaskAttachmentFacts,
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
  backends: readonly LlmBackend[]
  /**
   * The probe of the pool through the gateway: a pool closed only by the forecast between probes
   * is probed before a pass leaves it for the next backend (`poolHasRoom`); absent — not probed.
   */
  poolProbe?: PoolProbeClient
}

const planShape = turnPlanSchema.shape
const contextShape = planShape.context.shape
const checkpointPlanSchema = z.object({
  driverId: planShape.driverId,
  driverVersion: planShape.driverVersion,
  sandbox: z.object({ image: planShape.sandbox.shape.image }),
  context: z.object({
    taskId: contextShape.taskId,
    sessionId: contextShape.sessionId,
    turn: contextShape.turn,
    llm: contextShape.llm,
    mcp: contextShape.mcp,
    nativeSessionId: contextShape.nativeSessionId
      .nullable()
      .transform((value) => value ?? undefined),
  }),
  previous: planShape.previous.nullable(),
  repository: z.object({ projectRepositoryId: z.uuid() }).nullish(),
})

/** PostgreSQL projects the checkpoint fields: old instructions and prompts never leave the table. */
async function checkpointPlans(db: PrismaClient, taskId: string) {
  const rows = await db.$queryRaw<Array<{ turnNo: number; checkpoint: unknown }>>`
    SELECT DISTINCT ON (turn_no) turn_no AS "turnNo", jsonb_build_object(
      'driverId', plan->'driverId', 'driverVersion', plan->'driverVersion',
      'sandbox', jsonb_build_object('image', plan#>'{sandbox,image}'),
      'context', jsonb_build_object(
        'taskId', plan#>'{context,taskId}', 'sessionId', plan#>'{context,sessionId}',
        'turn', plan#>'{context,turn}', 'llm', plan#>'{context,llm}',
        'mcp', plan#>'{context,mcp}', 'nativeSessionId', plan#>'{context,nativeSessionId}'
      ),
      'previous', plan->'previous',
      'repository', CASE WHEN plan ? 'repository' THEN jsonb_build_object(
        'projectRepositoryId', plan#>'{repository,projectRepositoryId}'
      ) END
    ) AS checkpoint
    FROM turn_assignments WHERE task_id = ${taskId}::uuid AND finished_at IS NOT NULL
    ORDER BY turn_no, created_at DESC, id DESC`
  return new Map(
    rows.map(({ turnNo, checkpoint }) => [turnNo, checkpointPlanSchema.safeParse(checkpoint).data]),
  )
}

const turnStatus = (status: string): FinishedTurn['status'] =>
  status === 'completed' || status === 'failed' || status === 'lost' || status === 'cancelled'
    ? status
    : 'other'

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
      modelClass: true,
      billable: true,
      needsBrowser: true,
      workspace: {
        select: {
          // The skills of the workspace's agent (plan 83, БП11): every chat of it gets them.
          agentSkills: {
            select: { name: true, url: true, enabled: true, authKind: true, authState: true },
          },
        },
      },
      // The author's own instructions to the agent (docs/plan/76-agent-instructions.md, И2).
      createdBy: { select: { id: true, agentInstructions: { select: { text: true } } } },
      // The project of the chat (docs/plan/84-projects.md, ПР7): its goal and instructions.
      project: {
        select: {
          id: true,
          name: true,
          goal: true,
          instructions: true,
          deletedAt: true,
          // The repository of the project (docs/plan/84-projects.md, ПР12): prepared for the
          // pass by PassRunner once its mirror is ready.
          repository: {
            select: {
              id: true,
              provider: true,
              path: true,
              defaultBranch: true,
              mode: true,
              mirrorState: true,
              secretsFound: true,
            },
          },
        },
      },
      // The run of a scheduled task the chat is (docs/plan/82-scheduled-tasks.md, Зп27, Зп29).
      scheduledRun: { select: { name: true } },
    },
  })
  if (!task) return null
  // The repository comes with the pass once it is prepared (PassRunner, docs/plan/84-projects.md,
  // §4.3, step 3); the facts read here never name one.
  const requirements = { repository: false, browser: task.needsBrowser }
  const requestId = BigInt(input.requestEventId)
  const rows = await db.taskEvent.findMany({
    where: { taskId: task.id, type: 'feed.request', id: { lte: requestId } },
    orderBy: { id: 'asc' },
    select: { id: true, payload: true, createdAt: true, artifactCommentHasWords: true },
  })
  const answered = rows.at(-1)
  if (answered?.id !== requestId) return null
  const unattended =
    task.scheduledRun &&
    (await passUnattended(db, task.id, { requestEventId: input.requestEventId }))
      ? { name: task.scheduledRun.name }
      : null
  const carried: PassDispatch = unattended
    ? { kind: 'none' }
    : await dispatchOfPass(db, task.id, answered, rows)
  if (carried.kind === 'invalid') return null
  const dispatch = carried.kind === 'notes' ? carried.facts : null
  // Threads with words of other people mark the turn as one that read others (Ар25, 88.17в).
  if (dispatch && artifactCommentsByOthers(dispatch.artifactComments.notes))
    await markArtifactReadOther(db, {
      taskId: task.id,
      turnNo: input.turnNo,
      now: input.now.getTime(),
    })
  const requests: ClientRequest[] = rows.map((row) => {
    const event = readFeedRow('feed.request', row.payload)
    const text =
      row.artifactCommentHasWords !== false &&
      event.type === 'feed.request' &&
      'text' in event &&
      typeof event.text === 'string'
        ? event.text
        : null
    const kind = event.type === 'feed.request' ? event.kind : 'unreadable'
    const command = event.type === 'feed.request' && event.kind === 'command' ? event.command : null
    const carried =
      event.type === 'feed.request' && event.kind === 'agent_command' && event.command !== null
        ? AGENT_COMMANDS[event.command]
        : null
    // A command is a press: its row never reaches the agent (Р34), unless the agent carries it out,
    // and then it goes in the words of the platform or as an action of the turn
    // (docs/plan/61-chats-first.md, §5.2).
    return {
      id: row.id,
      kind,
      text: kind === 'command' ? null : (carried?.prompt ?? text),
      ...(carried?.action ? { action: carried.action } : {}),
      command,
      attachments:
        event.type === 'feed.request' && 'attachments' in event ? (event.attachments ?? []) : [],
      createdAt: row.createdAt,
    }
  })

  const modelClass = modelClassSchema.safeParse(task.modelClass ?? 'standard')
  if (!modelClass.success) return null
  const openProject = task.project && task.project.deletedAt === null ? task.project : null
  // The artifacts the client named in their own words (`@artifact:<id>`, docs/plan/88-artifacts.md,
  // Ар23, Ар47) join the chat — by the client's role, never from a text an agent wrote: the first
  // request of a run of a scheduled task is its instruction, which an agent may have written
  // (`raditi_schedule_create`), so its mentions are not read.
  const ownWords = task.scheduledRun ? requests.slice(1) : requests
  const mentioned = [
    ...new Set(
      ownWords.flatMap((request) =>
        // A command and the words of a command the agent carries out are the platform's.
        request.kind !== 'command' && request.kind !== 'agent_command' && request.text
          ? artifactMentionsOf(request.text)
          : [],
      ),
    ),
  ]
  // The reads below do not depend on each other; only the steps inside one entry are ordered.
  const [
    turnRows,
    plans,
    variables,
    chosen,
    creditBudget,
    attachmentRows,
    projectFiles,
    memoryEntries,
    chatArtifacts,
    projectArtifacts,
    accountSkills,
  ] = await Promise.all([
    db.taskTurn.findMany({
      where: { taskId: task.id },
      select: {
        turnNo: true,
        status: true,
        startedAt: true,
        nativeSessionId: true,
        rejectedAt: true,
        undoneAt: true,
      },
    }),
    checkpointPlans(db, task.id),
    // The variables of the workspace (docs/plan/83-remove-projects.md, БП4): every chat gets them,
    // whatever the data class of the workspace (the owner's decision of 17.11.2026, БП14).
    db.workspaceEnvVar.findMany({
      where: { workspaceId: task.workspaceId },
      orderBy: { name: 'asc' },
      select: { name: true },
    }),
    // The same query «Попробовать ещё» asks before it moves a dialog into a class, backend by
    // backend in the order of the registry: the plan first, the API when the plan has its limits
    // out (owner's answer of 13.11.2026, docs/plan/70-turn-without-time-limit.md, ВР24). With every
    // pool out the first stays, and the issue of its key tells the client so (plan 68).
    profileWithRoom(deps, modelClass.data),
    task.billable
      ? attemptCreditBudget(db, { taskId: task.id, attempt: input.attempt, now: input.now })
      : null,
    taskAttachments(deps.db, task.id),
    // The files of the context of the project (docs/plan/84-projects.md, ПР8): what is ready now.
    openProject ? readyProjectFiles(deps.db, openProject.id) : [],
    // The memory of the chat (docs/plan/84-projects.md, ПР18): null — off for its author.
    chatMemory(deps.db, task.id).then((memory) =>
      memory ? memoryEntriesOfPass(deps.db, memory) : null,
    ),
    // The artifacts the chat made, edited or was given (Ар26): their lines, no content — read
    // once the ones the client named joined it.
    (async () => {
      if (mentioned.length > 0)
        await attachMentionedArtifacts(deps.db, { taskId: task.id, artifactIds: mentioned })
      return (await listChatArtifacts(deps.db, { taskId: task.id, scope: 'chat' })).rows
    })(),
    // The artifacts of its project (Ар26, slice 88.20): every turn of the project knows them by
    // line. A mention never moves an artifact into a project: this list does not wait for it.
    openProject
      ? listChatArtifacts(deps.db, { taskId: task.id, scope: 'project' }).then(({ rows }) => rows)
      : [],
    // The skills of the author of the chat (docs/plan/97-skills.md, Нв1, Нв13): the built-in ones
    // and the enabled own ones with their files, as the account has them now.
    task.createdBy ? turnAccountSkills(deps.db, task.createdBy.id) : [],
  ])
  const turns = new Map<number, FinishedTurn>(
    turnRows.map((row) => [
      row.turnNo,
      {
        turnNo: row.turnNo,
        status: turnStatus(row.status),
        rejected: row.rejectedAt !== null,
        undone: row.undoneAt !== null,
        startedAt: row.startedAt,
        nativeSessionId: row.nativeSessionId,
        plan: plans.get(row.turnNo) ?? null,
      },
    ]),
  )
  const profile = chosen
    ? {
        backend: chosen.backend,
        modelSlug: chosen.modelSlug,
        providerModelId: chosen.providerModelId,
      }
    : undefined
  const budget: PassBudget =
    creditBudget === null ? { kind: 'quota' } : { kind: 'credits', budget: creditBudget }
  const attachments = attachmentFactsOf(attachmentRows)
  const lineOf = ({ id, kind, title, version, updatedAt }: (typeof chatArtifacts)[number]) => ({
    id,
    kind,
    title,
    version,
    updatedAt,
  })
  return {
    task: {
      id: task.id,
      workspaceId: task.workspaceId,
      attempt: input.attempt,
      turnNo: input.turnNo,
      modelClass: modelClass.data,
    },
    requirements,
    clientInstructions: task.createdBy?.agentInstructions?.text ?? null,
    project: projectFactsOf(task.project),
    repositoryRow: repositoryRowOf(task.project),
    repositoryUnavailable: repositoryUnavailableOf(task.project),
    ...(projectFiles.length ? { projectFiles } : {}),
    memory: memoryEntries,
    ...(chatArtifacts.length ? { chatArtifacts: chatArtifacts.map(lineOf) } : {}),
    ...(projectArtifacts.length ? { projectArtifacts: projectArtifacts.map(lineOf) } : {}),
    ...(accountSkills.length ? { accountSkills } : {}),
    ...(dispatch ?? {}),
    ...(unattended ? { unattended } : {}),
    ...(attachments.length ? { attachments } : {}),
    requests,
    committedAt: answered.createdAt,
    turns,
    variables: variables.map((variable) => variable.name),
    skills: turnSkillsOf(task.workspace.agentSkills, { platformBrowser: requirements.browser }),
    profile: profile ?? null,
    budget,
    now: input.now,
  }
}

type PassRequestRow = { id: bigint; payload: unknown; artifactCommentHasWords: boolean | null }

/** What a pass carries of a dispatch of notes: none, notes, or links that do not hold. */
type PassDispatch =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | {
      kind: 'notes'
      facts: Required<Pick<PassFacts, 'artifactCommentSourceId' | 'artifactComments'>>
    }

/**
 * The notes of the dispatch this pass carries: of the request it answers, or of the dispatch the
 * ceiling question it continues names (`artifactCommentSourceOf`). `invalid` — the link does not
 * hold, and the pass is not planned.
 */
async function dispatchOfPass(
  db: PrismaClient,
  taskId: string,
  answered: PassRequestRow,
  history: readonly PassRequestRow[],
): Promise<PassDispatch> {
  const none = { kind: 'none' } as const
  const invalid = { kind: 'invalid' } as const
  const event = readFeedRow('feed.request', answered.payload)
  if (event.type !== 'feed.request')
    return answered.artifactCommentHasWords === null ? none : invalid
  const sourceId = await artifactCommentSourceOf(db, { taskId, requestEventId: answered.id })
  if (sourceId === null) return none
  const original = history.find(({ id }) => id === sourceId)
  if (!original || original.artifactCommentHasWords === null) return invalid
  const request = readFeedRow('feed.request', original.payload)
  if (
    request.type !== 'feed.request' ||
    (request.kind !== 'first' && request.kind !== 'answer') ||
    request.authorId !== event.authorId
  )
    return invalid
  const artifactComments = await readArtifactCommentDispatch(db, {
    taskId,
    requestEventId: original.id,
    authorId: request.authorId,
  }).catch((error: unknown) => {
    throw notesWithdrawn(error)
  })
  return { kind: 'notes', facts: { artifactCommentSourceId: original.id, artifactComments } }
}

/**
 * The artifact was deleted or its access lost since the dispatch: the client is told so. A snapshot
 * that no longer passes its schema stays a technical failure.
 */
function notesWithdrawn(error: unknown): unknown {
  if (!isDomainError(error) || error.code !== 'ARTIFACT_NOT_FOUND') return error
  return new DomainError(
    'ARTIFACT_COMMENTS_WITHDRAWN',
    'The notes sent with the request are no longer available',
    409,
  )
}

/**
 * The project as the pass gives it to the agent (ПР7, ПР20): a project in the archive keeps its
 * chats and so its section; one in the trash has its passes stopped, and a pass that still starts
 * goes without it.
 */
const projectFactsOf = (
  project: {
    name: string
    goal: string | null
    instructions: string | null
    deletedAt: Date | null
  } | null,
): ProjectSectionFacts | null =>
  project && project.deletedAt === null
    ? { name: project.name, goal: project.goal, instructions: project.instructions }
    : null

/**
 * The repository of the chat's project the pass may prepare (ПР12): one whose mirror is ready, of a
 * project not in the trash. One still syncing, too large or unreachable — the chat goes without it.
 */
function repositoryRowOf(
  project: {
    id: string
    deletedAt: Date | null
    repository: {
      id: string
      provider: string
      path: string
      defaultBranch: string
      mode: string
      mirrorState: string
      secretsFound: unknown
    } | null
  } | null,
): PassRepositoryRow | null {
  const repo = project?.repository
  if (!project || project.deletedAt !== null || !repo || repo.mirrorState !== 'ready') return null
  const provider = repoProviderKinds.find((kind) => kind === repo.provider)
  const mode = repoModes.find((value) => value === repo.mode)
  if (!provider || !mode) return null
  const found = repoSecretsFoundPaths(repo.secretsFound)
  return {
    projectId: project.id,
    projectRepositoryId: repo.id,
    provider,
    path: repo.path,
    defaultBranch: repo.defaultBranch,
    mode,
    secretsFound: found,
  }
}

/**
 * The repository of the chat's project whose mirror is not ready (19.11.2026): its state and path
 * for the section that tells the agent why the code is not there. Null when it is ready, when the
 * project has none or is in the trash.
 */
function repositoryUnavailableOf(
  project: {
    deletedAt: Date | null
    repository: { path: string; mirrorState: string } | null
  } | null,
): UnavailableRepositoryFacts | null {
  const repo = project?.repository
  if (!project || project.deletedAt !== null || !repo) return null
  const state = repoMirrorStates.find((value) => value === repo.mirrorState)
  if (!state || state === 'ready') return null
  return { unavailable: state, path: repo.path }
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

/** The profile of the class on the first backend whose pool has room, or on the first at all. */
async function profileWithRoom(
  { db, backends, poolProbe }: PassFactsDependencies,
  modelClass: ModelClass,
): Promise<Awaited<ReturnType<typeof classProfile<LlmBackendId>>>> {
  let first: Awaited<ReturnType<typeof classProfile<LlmBackendId>>> = null
  for (const backend of backends) {
    const profile = await classProfile(db, { modelClass, backends: [backend.id] })
    if (!profile) continue
    first ??= profile
    // One backend: no other to go to, and the issue decides under its lock as before.
    if (backends.length === 1) return profile
    // What a turn of the profile takes, as the issue counts it (Л12).
    const cost = await db.llmTurnCost.findUnique({
      where: { modelId: profile.modelId },
      select: { p95PlanCredits: true },
    })
    const turnCostCredits =
      cost === null || cost.p95PlanCredits.lte(0) ? null : cost.p95PlanCredits.toNumber()
    if (
      await poolHasRoom(db, backend, new Date(), {
        turnCostCredits,
        ...(poolProbe ? { probe: poolProbe } : {}),
      })
    )
      return profile
  }
  return first
}
