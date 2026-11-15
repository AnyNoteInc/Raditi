import { findPersonalWorkspace, type PrismaClient } from '@repo/db'
import {
  envVarNameProblem,
  envVarValueSchema,
  workspaceEnvVarLimits,
  workspaceEnvVarPath,
  workspaceEnvVarSecret,
  workspaceEnvVarsReachAgent,
  workspaceEnvVarTombstone,
  type AppEnv,
} from '@repo/domain'

import { isManagerRole, memberRole } from './chat/access.ts'
import type { ChatSecretWriter } from './chat/context.ts'
import { personalWorkspaceOf } from './chat/dialog-lock.ts'
import {
  workspaceEnvChanged,
  workspaceEnvLimit,
  workspaceEnvNameInvalid,
  workspaceEnvNameReserved,
  workspaceEnvNotAllowed,
  workspaceEnvValueInvalid,
  workspaceNotFound,
} from './chat/refusals.ts'

// «Настройки → Переменные» (docs/plan/83-remove-projects.md, БП4): the variables of a workspace.
// The value of each is written to Vault `kv/workspaces/<workspaceId>/env/<NAME>` here, under
// `sites-writer`, and never read back; the name lives in `workspace_env_vars`. Every chat of the
// workspace gets them all in the agent's commands. A member sees the names, an owner or an admin
// changes them, and nobody ever gets a value back.

export interface WorkspaceEnvVarView {
  name: string
  keyVersion: number
  updatedAt: Date
}

export interface WorkspaceEnvList {
  /** null — the user has no workspace yet: the first variable makes it. */
  workspaceId: string | null
  /** The user may add, replace and remove variables here. */
  canEdit: boolean
  /**
   * false in a workspace of real client data before the gate of 152-FZ
   * (`workspaceEnvVarsReachAgent`): the variables are kept, the agent does not get them yet.
   */
  agentGets: boolean
  variables: WorkspaceEnvVarView[]
}

const viewSelect = { name: true, keyVersion: true, updatedAt: true } as const

interface Place {
  appEnv: AppEnv
  userId: string
  /** Absent — the user's personal workspace, the one their chats go to. */
  workspaceId?: string | undefined
}

/** The workspace, the reader's role in it and its data class; NOT_FOUND for any other. */
async function workspaceOf(
  db: PrismaClient,
  place: Place & { create: boolean },
): Promise<{ id: string; canEdit: boolean; dataClass: 'synthetic' | 'client' } | null> {
  let id = place.workspaceId
  if (id === undefined) {
    const personal = place.create
      ? await personalWorkspaceOf(db, { userId: place.userId, appEnv: place.appEnv })
      : await findPersonalWorkspace(db, { userId: place.userId, appEnv: place.appEnv })
    if (personal === null) return null
    id = personal.id
  }
  const role = await memberRole(db, id, place.userId)
  if (role === null) throw workspaceNotFound()
  const workspace = await db.workspace.findUniqueOrThrow({
    where: { id },
    select: { dataClass: true },
  })
  return { id, canEdit: isManagerRole(role), dataClass: workspace.dataClass }
}

export async function listWorkspaceEnv(db: PrismaClient, place: Place): Promise<WorkspaceEnvList> {
  const workspace = await workspaceOf(db, { ...place, create: false })
  if (workspace === null)
    return { workspaceId: null, canEdit: true, agentGets: true, variables: [] }
  const variables = await db.workspaceEnvVar.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { name: 'asc' },
    select: viewSelect,
  })
  return {
    workspaceId: workspace.id,
    canEdit: workspace.canEdit,
    agentGets: workspaceEnvVarsReachAgent(workspace.dataClass),
    variables,
  }
}

/** Writes a version by CAS: a writer that lost the race is told so, never overwrites it. */
async function writeValue(
  secrets: ChatSecretWriter,
  path: string,
  data: Record<string, string>,
): Promise<number> {
  const metadata = await secrets.kvMetadata(path)
  const cas = metadata?.currentVersion ?? 0
  try {
    return (await secrets.kvWrite(path, data, { cas, maxVersions: 1 })).version
  } catch (error) {
    const now = await secrets.kvMetadata(path)
    if ((now?.currentVersion ?? 0) !== cas) throw workspaceEnvChanged()
    throw error
  }
}

async function managed(db: PrismaClient, place: Place) {
  const workspace = await workspaceOf(db, { ...place, create: true })
  if (workspace === null) throw workspaceNotFound()
  if (!workspace.canEdit) throw workspaceEnvNotAllowed()
  return workspace
}

/**
 * Adds a variable or replaces its value: the value goes to Vault first, then the row names the
 * version written. Of two writers the later version of Vault wins the row.
 */
export async function setWorkspaceEnv(
  db: PrismaClient,
  secrets: () => ChatSecretWriter,
  input: Place & { name: string; value: string },
): Promise<WorkspaceEnvVarView> {
  const problem = envVarNameProblem(input.name)
  if (problem === 'format') throw workspaceEnvNameInvalid()
  if (problem === 'reserved') throw workspaceEnvNameReserved()
  if (!envVarValueSchema.safeParse(input.value).success) throw workspaceEnvValueInvalid()
  const workspace = await managed(db, input)
  const others = await db.workspaceEnvVar.count({
    where: { workspaceId: workspace.id, name: { not: input.name } },
  })
  if (others >= workspaceEnvVarLimits.perWorkspace) throw workspaceEnvLimit()

  const version = await writeValue(
    secrets(),
    workspaceEnvVarPath(workspace.id, input.name),
    workspaceEnvVarSecret(input.value),
  )
  const created = await db.workspaceEnvVar.createMany({
    data: [
      {
        workspaceId: workspace.id,
        name: input.name,
        keyVersion: version,
        createdBy: input.userId,
      },
    ],
    skipDuplicates: true,
  })
  if (created.count === 0) {
    await db.workspaceEnvVar.updateMany({
      where: { workspaceId: workspace.id, name: input.name, keyVersion: { lt: version } },
      data: { keyVersion: version },
    })
  }
  return db.workspaceEnvVar.findUniqueOrThrow({
    where: { workspaceId_name: { workspaceId: workspace.id, name: input.name } },
    select: viewSelect,
  })
}

/**
 * Removes a variable: its key gets a version without a value (the writer never deletes), then
 * the row goes — unless a newer value was written meanwhile.
 */
export async function removeWorkspaceEnv(
  db: PrismaClient,
  secrets: () => ChatSecretWriter,
  input: Place & { name: string; now: Date },
): Promise<{ removed: boolean }> {
  if (envVarNameProblem(input.name) !== null) return { removed: false }
  const workspace = await managed(db, input)
  const row = await db.workspaceEnvVar.findUnique({
    where: { workspaceId_name: { workspaceId: workspace.id, name: input.name } },
    select: { keyVersion: true },
  })
  if (row === null) return { removed: false }
  const store = secrets()
  const path = workspaceEnvVarPath(workspace.id, input.name)
  // A key that was never written has nothing to hide; otherwise the version without a value.
  const written = (await store.kvMetadata(path)) !== null
  const deleted = await db.workspaceEnvVar.deleteMany({
    where: written
      ? {
          workspaceId: workspace.id,
          name: input.name,
          keyVersion: { lt: await writeValue(store, path, workspaceEnvVarTombstone(input.now)) },
        }
      : { workspaceId: workspace.id, name: input.name, keyVersion: { lte: row.keyVersion } },
  })
  return { removed: deleted.count > 0 }
}
