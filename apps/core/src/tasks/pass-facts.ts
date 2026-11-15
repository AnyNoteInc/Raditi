import { attemptCreditBudget } from '@repo/billing'
import { classProfile, taskAttachments, type PrismaClient } from '@repo/db'
import {
  modelClassSchema,
  readFeedRow,
  turnSkillsOf,
  workspaceEnvVarsReachAgent,
  type LlmBackend,
  type LlmBackendId,
  type ModelClass,
} from '@repo/domain'

import { poolHasRoom } from '../llm/pool-room.ts'
import { AGENT_COMMANDS } from './turn-instructions.ts'
import {
  savedPlanOf,
  type ClientRequest,
  type FinishedTurn,
  type PassBudget,
  type PassFacts,
  type TaskAttachmentFacts,
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
          dataClass: true,
          // The skills of the workspace's agent (plan 83, БП11): every chat of it gets them.
          agentSkills: {
            select: { name: true, url: true, enabled: true, authKind: true, authState: true },
          },
        },
      },
      // The author's own instructions to the agent (docs/plan/76-agent-instructions.md, И2).
      createdBy: { select: { agentInstructions: { select: { text: true } } } },
    },
  })
  if (!task) return null
  // No chat has a repository (docs/plan/83-remove-projects.md, БП2).
  const requirements = { repository: false, browser: task.needsBrowser }
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

  const [turnRows, assignments, variables] = await Promise.all([
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
    db.turnAssignment.findMany({
      where: { taskId: task.id, finishedAt: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { turnNo: true, plan: true },
    }),
    // The variables of the workspace (docs/plan/83-remove-projects.md, БП4): every chat gets them,
    // none in a workspace of client data before the gate of 152-FZ (rule 1).
    workspaceEnvVarsReachAgent(task.workspace.dataClass)
      ? db.workspaceEnvVar.findMany({
          where: { workspaceId: task.workspaceId },
          orderBy: { name: 'asc' },
          select: { name: true },
        })
      : [],
  ])
  const plans = new Map(assignments.map((row) => [row.turnNo, savedPlanOf(row.plan)]))
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

  const modelClass = modelClassSchema.safeParse(task.modelClass ?? 'standard')
  if (!modelClass.success) return null
  // The same query «Попробовать ещё» asks before it moves a dialog into a class, backend by
  // backend in the order of the registry: the plan first, the API when the plan has its limits
  // out (owner's answer of 13.11.2026, docs/plan/70-turn-without-time-limit.md, ВР24). With every
  // pool out the first stays, and the issue of its key tells the client so (plan 68).
  const chosen = await profileWithRoom(db, deps.backends, modelClass.data)
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

  const attachments = attachmentFactsOf(await taskAttachments(deps.db, task.id))
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
  db: PrismaClient,
  backends: readonly LlmBackend[],
  modelClass: ModelClass,
): Promise<Awaited<ReturnType<typeof classProfile<LlmBackendId>>>> {
  let first: Awaited<ReturnType<typeof classProfile<LlmBackendId>>> = null
  for (const backend of backends) {
    const profile = await classProfile(db, { modelClass, backends: [backend.id] })
    if (!profile) continue
    first ??= profile
    // One backend: no other to go to, and the issue decides under its lock as before.
    if (backends.length === 1 || (await poolHasRoom(db, backend, new Date()))) return profile
  }
  return first
}
