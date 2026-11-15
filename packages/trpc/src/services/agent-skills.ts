import { findPersonalWorkspace, type PrismaClient } from '@repo/db'
import {
  agentSkillHeaderNameSchema,
  agentSkillHeaderValueSchema,
  agentSkillLimits,
  agentSkillNameSchema,
  agentSkillOAuthSchema,
  agentSkillSecretPath,
  agentSkillSecretSchema,
  builtinAgentSkills,
  DomainError,
  isBuiltinAgentSkill,
  parseAgentSkillUrl,
  workspaceEnvVarTombstone,
  type AppEnv,
  type AgentSkillAuthKind,
  type AgentSkillOAuth,
  type AgentSkillAuthState,
} from '@repo/domain'

import { isManagerRole, memberRole } from './chat/access.ts'
import { personalWorkspaceOf } from './chat/dialog-lock.ts'
import { workspaceNotFound } from './chat/refusals.ts'
import type { McpServerCheck, McpServerServices } from './mcp-server-auth.ts'

// «Настройки → Навыки агента» of a workspace (owner's request of 26.10.2026; per workspace since
// docs/plan/83-remove-projects.md, БП11): the MCP servers the agent of every chat of the
// workspace connects to besides the platform's own, over the open internet of a turn. The platform's two are on
// until an owner or an admin turns one off; they add remote servers by an https address. Core
// reads the rows for every pass (`turnSkillsOf`). A server may have a key in a header
// (docs/plan/81-mcp-server-credentials.md): the key is checked against the server, goes to Vault
// and is never read back; the row keeps the header's name and whether the key works.

export interface AgentSkillView {
  name: string
  /** What the cabinet shows: a platform skill's title, the name of an added one. */
  title: string
  description: string | null
  /** One of the platform's: switched on and off, never removed. */
  builtin: boolean
  /** An added skill's address; null for the platform's. */
  url: string | null
  enabled: boolean
  /** How the server is authorized and whether that works; never the key itself. */
  auth: {
    kind: AgentSkillAuthKind
    headerName: string | null
    state: AgentSkillAuthState
    error: string | null
  }
}

export interface AgentSkillsView {
  skills: AgentSkillView[]
  /** An owner or an admin: adds, switches and removes. */
  canManage: boolean
  /** null — the user has no workspace yet: the first change makes it. */
  workspaceId: string | null
  /** Added skills the workspace may still get. */
  addable: number
}

export const skillNotAllowed = () =>
  new DomainError('AGENT_SKILL_NOT_ALLOWED', 'Only an owner or an admin changes the skills', 403)
export const skillNameInvalid = () =>
  new DomainError('AGENT_SKILL_NAME_INVALID', 'Not a name a skill may have', 400)
export const skillUrlInvalid = () =>
  new DomainError('AGENT_SKILL_URL_INVALID', 'Not an address a skill may have', 400)
export const skillExists = () =>
  new DomainError('AGENT_SKILL_EXISTS', 'The workspace has a skill of this name', 409)
export const skillLimit = () =>
  new DomainError('AGENT_SKILL_LIMIT', 'The workspace has as many added skills as it may', 409)
export const skillNotFound = () =>
  new DomainError('AGENT_SKILL_NOT_FOUND', 'The workspace has no such skill', 404)
export const skillBuiltin = () =>
  new DomainError(
    'AGENT_SKILL_BUILTIN',
    'A skill of the platform is switched off, not removed',
    409,
  )
export const skillHeaderInvalid = () =>
  new DomainError('AGENT_SKILL_HEADER_INVALID', 'Not a header or a key a server may get', 400)
export const skillAuthUnavailable = () =>
  new DomainError('AGENT_SKILL_AUTH_UNAVAILABLE', 'Servers with a key cannot be added here', 503)
export const skillCheckFailed = (reason: Extract<McpServerCheck, { ok: false }>['reason']) =>
  new DomainError('AGENT_SKILL_CHECK_FAILED', 'The server did not answer as an MCP server', 422, {
    reason,
  })
export const skillKeyless = () =>
  new DomainError('AGENT_SKILL_KEYLESS', 'The server has no key to replace', 409)

interface Place {
  appEnv: AppEnv
  userId: string
  /** Absent — the user's personal workspace, the one their chats go to. */
  workspaceId?: string | undefined
}

const skillSelect = {
  name: true,
  url: true,
  enabled: true,
  authKind: true,
  headerName: true,
  authState: true,
  authError: true,
} as const

/**
 * The workspace, whether the reader manages it and its skills; NOT_FOUND for one they are no
 * member of. `create` — a change: the personal workspace is made, with its gift, if there is none.
 */
async function workspaceOf(db: PrismaClient, place: Place, create: boolean) {
  let id = place.workspaceId
  if (id === undefined) {
    const personal = create
      ? await personalWorkspaceOf(db, { userId: place.userId, appEnv: place.appEnv })
      : await findPersonalWorkspace(db, { userId: place.userId, appEnv: place.appEnv })
    if (personal === null) return null
    id = personal.id
  }
  const role = await memberRole(db, id, place.userId)
  if (role === null) throw workspaceNotFound()
  const agentSkills = await db.workspaceAgentSkill.findMany({
    where: { workspaceId: id },
    select: skillSelect,
  })
  return { id, canManage: isManagerRole(role), agentSkills }
}

type Workspace = NonNullable<Awaited<ReturnType<typeof workspaceOf>>>

async function managed(db: PrismaClient, place: Place): Promise<Workspace> {
  const workspace = await workspaceOf(db, place, true)
  if (workspace === null) throw workspaceNotFound()
  if (!workspace.canManage) throw skillNotAllowed()
  return workspace
}

/** Erases a key: a version without a value that alone is kept (the writer never deletes). */
async function eraseSecret(
  secrets: McpServerServices['secrets'],
  path: string,
  now: Date,
): Promise<void> {
  const metadata = await secrets.kvMetadata(path)
  if (metadata === null) return
  await secrets.kvWrite(path, workspaceEnvVarTombstone(now), {
    cas: metadata.currentVersion,
    maxVersions: 1,
  })
}

const byName = (left: { name: string }, right: { name: string }) =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0

const noAuth = { kind: 'none', headerName: null, state: 'ok', error: null } as const

function viewOf(
  workspace: Pick<Workspace, 'id' | 'agentSkills'> | null,
  canManage: boolean,
): AgentSkillsView {
  const own = workspace?.agentSkills ?? []
  const rows = new Map(own.map((row) => [row.name, row]))
  const added = own.filter((row) => !isBuiltinAgentSkill(row.name)).sort(byName)
  return {
    skills: [
      ...builtinAgentSkills.map((skill) => ({
        name: skill.name,
        title: skill.title,
        description: skill.description,
        builtin: true,
        url: null,
        enabled: rows.get(skill.name)?.enabled !== false,
        auth: noAuth,
      })),
      ...added.map((row) => ({
        name: row.name,
        title: row.name,
        description: null,
        builtin: false,
        url: row.url,
        enabled: row.enabled,
        auth: {
          kind: row.authKind,
          headerName: row.headerName,
          state: row.authState,
          error: row.authError,
        },
      })),
    ],
    workspaceId: workspace?.id ?? null,
    canManage,
    addable: Math.max(0, agentSkillLimits.added - added.length),
  }
}

/** The skills of a workspace, for every member of it. */
export async function readAgentSkills(db: PrismaClient, place: Place): Promise<AgentSkillsView> {
  const workspace = await workspaceOf(db, place, false)
  // No workspace yet: the platform's skills, and the user will own the one a change makes.
  return workspace === null ? viewOf(null, true) : viewOf(workspace, workspace.canManage)
}

/** The owner's header of a server and its value, as the form sends them. */
export interface SkillHeaderInput {
  headerName: string
  value: string
}

type Change =
  | { kind: 'switch'; name: string; enabled: boolean }
  | { kind: 'add'; name: string; url: string; header?: SkillHeaderInput }
  | { kind: 'key'; name: string; header: SkillHeaderInput }
  | { kind: 'remove'; name: string }

/** The header as the domain takes it; the value never enters an error or a log. */
function headerOf(input: SkillHeaderInput) {
  const name = agentSkillHeaderNameSchema.safeParse(input.headerName)
  const value = agentSkillHeaderValueSchema.safeParse(input.value)
  if (!name.success || !value.success) throw skillHeaderInvalid()
  return { name: name.data, value: value.data }
}

/**
 * Checks the key against the server and writes it to Vault, before any row names it (plan 81,
 * §3.4): a row never names a key Vault does not have, and a key the server refuses is never kept.
 * Returns the version that holds it.
 */
async function storeCheckedKey(
  services: McpServerServices,
  input: {
    workspaceId: string
    name: string
    url: string
    header: { name: string; value: string }
  },
): Promise<number> {
  const checked = await services.probe({ url: input.url, header: input.header })
  if (!checked.ok) throw skillCheckFailed(checked.reason)
  const path = agentSkillSecretPath(input.workspaceId, input.name)
  // A key of a server removed before leaves a version without a value: the write follows it.
  const metadata = await services.secrets.kvMetadata(path)
  const written = await services.secrets.kvWrite(
    path,
    { value: input.header.value },
    { cas: metadata?.currentVersion ?? 0, maxVersions: 1 },
  )
  return written.version
}

/**
 * Erases the key a failed request wrote, and only while it is still that version: a request of the
 * same name that won meanwhile keeps its own (CAS).
 */
async function eraseOwnVersion(
  services: McpServerServices,
  path: string,
  version: number,
  now: Date,
): Promise<void> {
  const metadata = await services.secrets.kvMetadata(path)
  if (metadata?.currentVersion !== version) return
  await services.secrets.kvWrite(path, workspaceEnvVarTombstone(now), {
    cas: version,
    maxVersions: 1,
  })
}

/** One change of the skills of a workspace; an owner or an admin only, audited. */
export async function changeAgentSkills(
  db: PrismaClient,
  input: Place & { ip: string | null; change: Change; now?: Date },
  services: McpServerServices | null = null,
): Promise<AgentSkillsView> {
  const space = await managed(db, input)
  const { change } = input
  const name = agentSkillNameSchema.safeParse(change.name.trim().toLowerCase())
  if (!name.success) throw skillNameInvalid()
  const row = space.agentSkills.find((skill) => skill.name === name.data)
  const builtin = isBuiltinAgentSkill(name.data)
  const key = { workspaceId_name: { workspaceId: space.id, name: name.data } }
  let meta: Record<string, string | boolean> = { name: name.data }
  const now = input.now ?? new Date()
  const secretPath = agentSkillSecretPath(space.id, name.data)
  // Before the transaction: the server is asked and Vault written outside of it.
  let keyVersion: number | null = null
  let header: { name: string; value: string } | null = null
  if (change.kind === 'add' && change.header !== undefined) {
    if (builtin || row) throw skillExists()
    const url = parseAgentSkillUrl(change.url.trim())
    if (url === null) throw skillUrlInvalid()
    const added = space.agentSkills.filter((skill) => !isBuiltinAgentSkill(skill.name)).length
    if (added >= agentSkillLimits.added) throw skillLimit()
    header = headerOf(change.header)
    if (services === null) throw skillAuthUnavailable()
    keyVersion = await storeCheckedKey(services, {
      workspaceId: space.id,
      name: name.data,
      url,
      header,
    })
  } else if (change.kind === 'key') {
    if (builtin || !row) throw skillNotFound()
    if (row.authKind !== 'header' || row.url === null) throw skillKeyless()
    header = headerOf(change.header)
    if (services === null) throw skillAuthUnavailable()
    keyVersion = await storeCheckedKey(services, {
      workspaceId: space.id,
      name: name.data,
      url: row.url,
      header,
    })
  } else if (change.kind === 'remove' && row && row.authKind !== 'none') {
    // The key goes first: a row is never removed while its key stays behind unnamed.
    if (services === null) throw skillAuthUnavailable()
    await eraseSecret(services.secrets, secretPath, now)
  }

  const write = async (tx: Pick<PrismaClient, 'workspaceAgentSkill' | 'credentialRef'>) => {
    if (change.kind === 'switch') {
      if (!builtin && !row) throw skillNotFound()
      await tx.workspaceAgentSkill.upsert({
        where: key,
        create: { workspaceId: space.id, name: name.data, url: null, enabled: change.enabled },
        update: { enabled: change.enabled },
      })
      meta = { ...meta, enabled: change.enabled }
    } else if (change.kind === 'add') {
      if (builtin || row) throw skillExists()
      const url = parseAgentSkillUrl(change.url.trim())
      if (url === null) throw skillUrlInvalid()
      const added = space.agentSkills.filter((skill) => !isBuiltinAgentSkill(skill.name)).length
      if (added >= agentSkillLimits.added) throw skillLimit()
      await tx.workspaceAgentSkill.create({
        data: {
          workspaceId: space.id,
          name: name.data,
          url,
          ...(header === null
            ? {}
            : { authKind: 'header', headerName: header.name, authCheckedAt: now }),
        },
      })
      // The address is the owner's choice of a public server: it names no secret, nor does the
      // name of its header.
      meta = { ...meta, url, ...(header === null ? {} : { header: header.name }) }
    } else if (change.kind === 'key') {
      if (header === null) throw skillHeaderInvalid()
      await tx.workspaceAgentSkill.update({
        where: key,
        data: { headerName: header.name, authState: 'ok', authError: null, authCheckedAt: now },
      })
      meta = { ...meta, header: header.name }
    } else {
      if (builtin) throw skillBuiltin()
      if (!row) throw skillNotFound()
      await tx.workspaceAgentSkill.delete({ where: key })
      await tx.credentialRef.deleteMany({ where: { workspaceId: space.id, vaultPath: secretPath } })
    }
    if (keyVersion !== null)
      await tx.credentialRef.upsert({
        where: { vaultPath: secretPath },
        create: {
          workspaceId: space.id,
          kind: 'mcp_server',
          vaultPath: secretPath,
          keyVersion,
        },
        update: { keyVersion },
      })
  }

  const transaction = db.$transaction(async (tx) => {
    await write(tx)
    await tx.auditLog.create({
      data: {
        actorType: 'user',
        actorId: input.userId,
        workspaceId: space.id,
        action: `workspace.agent_skill.${change.kind}`,
        targetType: 'workspace',
        targetId: space.id,
        meta,
        ip: input.ip,
      },
    })
  })
  try {
    await transaction
  } catch (error) {
    // A new server's key that no row will name is erased; a replaced key stays — the row still
    // names the server, and its next key is written over it.
    if (change.kind === 'add' && keyVersion !== null && services !== null)
      await eraseOwnVersion(services, secretPath, keyVersion, now).catch(() => undefined)
    throw error
  }
  return readAgentSkills(db, { ...input, workspaceId: space.id })
}

/** What a server signed in with OAuth is connected with: its address, tokens and metadata. */
export interface SkillSignInInput {
  appEnv: AppEnv
  userId: string
  /** Absent — the user's personal workspace, made with its gift if there is none. */
  workspaceId?: string | undefined
  name: string
  url: string
  ip: string | null
  now?: Date
}

/**
 * Whether an owner or an admin may sign this workspace in to a server by this name: a new server, or
 * one already signed in that needs a sign-in again (plan 81, §3.4). Returns the kept name and
 * address; web starts the sign-in only after it.
 */
export async function checkSkillSignIn(
  db: PrismaClient,
  input: Omit<SkillSignInInput, 'ip' | 'now'>,
): Promise<{ workspaceId: string; name: string; url: string }> {
  const space = await managed(db, input)
  const name = agentSkillNameSchema.safeParse(input.name.trim().toLowerCase())
  if (!name.success || isBuiltinAgentSkill(name.data)) throw skillNameInvalid()
  const url = parseAgentSkillUrl(input.url.trim())
  if (url === null) throw skillUrlInvalid()
  const row = space.agentSkills.find((skill) => skill.name === name.data)
  if (row) {
    // Signing in again keeps the server: the same address, a sign-in already.
    if (row.authKind !== 'oauth' || row.url !== url) throw skillExists()
  } else {
    const added = space.agentSkills.filter((skill) => !isBuiltinAgentSkill(skill.name)).length
    if (added >= agentSkillLimits.added) throw skillLimit()
  }
  return { workspaceId: space.id, name: name.data, url }
}

/**
 * Connects a server the owner has signed in to (plan 81, §3.4): checks it with the access token,
 * writes the tokens to Vault, then the row with what of the sign-in is not secret, its
 * `credential_refs` entry and the audit, in one transaction. The tokens are in no row, log or audit.
 */
export async function connectSignedInServer(
  db: PrismaClient,
  services: McpServerServices,
  input: SkillSignInInput & {
    tokens: {
      accessToken: string
      refreshToken?: string
      clientSecret?: string
      expiresIn?: number
    }
    oauth: Omit<AgentSkillOAuth, 'expiresAt'>
  },
): Promise<void> {
  const { workspaceId, name, url } = await checkSkillSignIn(db, input)
  const space = await managed(db, { ...input, workspaceId })
  const now = input.now ?? new Date()
  const secret = agentSkillSecretSchema.safeParse({
    accessToken: input.tokens.accessToken,
    ...(input.tokens.refreshToken ? { refreshToken: input.tokens.refreshToken } : {}),
    ...(input.tokens.clientSecret ? { clientSecret: input.tokens.clientSecret } : {}),
  })
  if (!secret.success || !('accessToken' in secret.data)) throw skillCheckFailed('not_mcp')
  const checked = await services.probe({
    url,
    header: { name: 'Authorization', value: `Bearer ${secret.data.accessToken}` },
  })
  if (!checked.ok) throw skillCheckFailed(checked.reason)
  const oauth = agentSkillOAuthSchema.parse({
    ...input.oauth,
    ...(input.tokens.expiresIn
      ? { expiresAt: new Date(now.getTime() + input.tokens.expiresIn * 1000).toISOString() }
      : {}),
  })
  const path = agentSkillSecretPath(space.id, name)
  const metadata = await services.secrets.kvMetadata(path)
  const { version } = await services.secrets.kvWrite(
    path,
    Object.fromEntries(Object.entries(secret.data).filter(([, value]) => value !== undefined)),
    { cas: metadata?.currentVersion ?? 0, maxVersions: 1 },
  )
  try {
    await db.$transaction(async (tx) => {
      const fields = {
        url,
        authKind: 'oauth' as const,
        headerName: null,
        authState: 'ok' as const,
        authError: null,
        authCheckedAt: now,
        oauth,
      }
      await tx.workspaceAgentSkill.upsert({
        where: { workspaceId_name: { workspaceId: space.id, name } },
        create: { workspaceId: space.id, name, ...fields },
        update: fields,
      })
      await tx.credentialRef.upsert({
        where: { vaultPath: path },
        create: {
          workspaceId: space.id,
          kind: 'mcp_server',
          vaultPath: path,
          keyVersion: version,
        },
        update: { keyVersion: version },
      })
      await tx.auditLog.create({
        data: {
          actorType: 'user',
          actorId: input.userId,
          workspaceId: space.id,
          action: 'workspace.agent_skill.sign_in',
          targetType: 'workspace',
          targetId: space.id,
          meta: { name, url, issuer: oauth.issuer },
          ip: input.ip,
        },
      })
    })
  } catch (error) {
    await eraseOwnVersion(services, path, version, now).catch(() => undefined)
    throw error
  }
}
