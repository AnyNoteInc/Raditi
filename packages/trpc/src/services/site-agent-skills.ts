import type { PrismaClient } from '@repo/db'
import {
  agentSkillHeaderNameSchema,
  agentSkillHeaderValueSchema,
  agentSkillLimits,
  agentSkillNameSchema,
  agentSkillSecretPath,
  builtinAgentSkills,
  DomainError,
  isBuiltinAgentSkill,
  parseAgentSkillUrl,
  siteEnvVarTombstone,
  type AgentSkillAuthKind,
  type AgentSkillAuthState,
} from '@repo/domain'

import { isManagerRole, memberRole } from './chat/access.ts'
import type { McpServerCheck, McpServerServices } from './mcp-server-auth.ts'
import { accessibleSite, siteNotFound } from './site-basics.ts'
import { eraseSiteSecret } from './site-delete.ts'

// «Навыки агента» of a site (owner's request of 26.10.2026): the MCP servers its agent connects
// to besides the platform's own, over the open internet of a turn. The platform's two are on
// until an owner or an admin turns one off; they add remote servers by an https address. Core
// reads the rows for every pass (`turnSkillsOf`). A server may have a key in a header
// (docs/plan/80-mcp-server-credentials.md): the key is checked against the server, goes to Vault
// and is never read back; the row keeps the header's name and whether the key works.

export interface SiteAgentSkillView {
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

export interface SiteAgentSkillsView {
  skills: SiteAgentSkillView[]
  /** An owner or an admin: adds, switches and removes. */
  canManage: boolean
  /** Added skills the site may still get. */
  addable: number
}

export const siteSkillNotAllowed = () =>
  new DomainError('SITE_SKILL_NOT_ALLOWED', 'Only an owner or an admin changes the skills', 403)
export const siteSkillNameInvalid = () =>
  new DomainError('SITE_SKILL_NAME_INVALID', 'Not a name a skill may have', 400)
export const siteSkillUrlInvalid = () =>
  new DomainError('SITE_SKILL_URL_INVALID', 'Not an address a skill may have', 400)
export const siteSkillExists = () =>
  new DomainError('SITE_SKILL_EXISTS', 'The site has a skill of this name', 409)
export const siteSkillLimit = () =>
  new DomainError('SITE_SKILL_LIMIT', 'The site has as many added skills as it may', 409)
export const siteSkillNotFound = () =>
  new DomainError('SITE_SKILL_NOT_FOUND', 'The site has no such skill', 404)
export const siteSkillBuiltin = () =>
  new DomainError('SITE_SKILL_BUILTIN', 'A skill of the platform is switched off, not removed', 409)
export const siteSkillHeaderInvalid = () =>
  new DomainError('SITE_SKILL_HEADER_INVALID', 'Not a header or a key a server may get', 400)
export const siteSkillAuthUnavailable = () =>
  new DomainError('SITE_SKILL_AUTH_UNAVAILABLE', 'Servers with a key cannot be added here', 503)
export const siteSkillCheckFailed = (reason: Extract<McpServerCheck, { ok: false }>['reason']) =>
  new DomainError('SITE_SKILL_CHECK_FAILED', 'The server did not answer as an MCP server', 422, {
    reason,
  })
export const siteSkillKeyless = () =>
  new DomainError('SITE_SKILL_KEYLESS', 'The server has no key to replace', 409)

async function siteOf(db: PrismaClient, userId: string, siteId: string) {
  const site = await db.site.findFirst({
    where: accessibleSite(userId, siteId),
    select: {
      id: true,
      workspaceId: true,
      agentSkills: {
        select: {
          name: true,
          url: true,
          enabled: true,
          authKind: true,
          headerName: true,
          authState: true,
          authError: true,
        },
      },
    },
  })
  if (!site) throw siteNotFound()
  return site
}

const byName = (left: { name: string }, right: { name: string }) =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0

const noAuth = { kind: 'none', headerName: null, state: 'ok', error: null } as const

function viewOf(site: Awaited<ReturnType<typeof siteOf>>, canManage: boolean): SiteAgentSkillsView {
  const rows = new Map(site.agentSkills.map((row) => [row.name, row]))
  const added = site.agentSkills.filter((row) => !isBuiltinAgentSkill(row.name)).sort(byName)
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
    canManage,
    addable: Math.max(0, agentSkillLimits.added - added.length),
  }
}

/** The skills of a site, for every member of its workspace. */
export async function readSiteAgentSkills(
  db: PrismaClient,
  input: { userId: string; siteId: string },
): Promise<SiteAgentSkillsView> {
  const site = await siteOf(db, input.userId, input.siteId)
  return viewOf(site, isManagerRole(await memberRole(db, site.workspaceId, input.userId)))
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
  if (!name.success || !value.success) throw siteSkillHeaderInvalid()
  return { name: name.data, value: value.data }
}

/**
 * Checks the key against the server and writes it to Vault, before any row names it (plan 80,
 * §3.4): a row never names a key Vault does not have, and a key the server refuses is never kept.
 * Returns the version that holds it.
 */
async function storeCheckedKey(
  services: McpServerServices,
  input: { siteId: string; name: string; url: string; header: { name: string; value: string } },
): Promise<number> {
  const checked = await services.probe({ url: input.url, header: input.header })
  if (!checked.ok) throw siteSkillCheckFailed(checked.reason)
  const path = agentSkillSecretPath(input.siteId, input.name)
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
  await services.secrets.kvWrite(path, siteEnvVarTombstone(now), { cas: version, maxVersions: 1 })
}

/** One change of the skills of a site; an owner or an admin only, audited. */
export async function changeSiteAgentSkills(
  db: PrismaClient,
  input: { userId: string; siteId: string; ip: string | null; change: Change; now?: Date },
  services: McpServerServices | null = null,
): Promise<SiteAgentSkillsView> {
  const site = await siteOf(db, input.userId, input.siteId)
  if (!isManagerRole(await memberRole(db, site.workspaceId, input.userId)))
    throw siteSkillNotAllowed()
  const { change } = input
  const name = agentSkillNameSchema.safeParse(change.name.trim().toLowerCase())
  if (!name.success) throw siteSkillNameInvalid()
  const row = site.agentSkills.find((skill) => skill.name === name.data)
  const builtin = isBuiltinAgentSkill(name.data)
  const key = { siteId_name: { siteId: site.id, name: name.data } }
  let meta: Record<string, string | boolean> = { name: name.data }
  const now = input.now ?? new Date()
  const secretPath = agentSkillSecretPath(site.id, name.data)
  // Before the transaction: the server is asked and Vault written outside of it.
  let keyVersion: number | null = null
  let header: { name: string; value: string } | null = null
  if (change.kind === 'add' && change.header !== undefined) {
    if (builtin || row) throw siteSkillExists()
    const url = parseAgentSkillUrl(change.url.trim())
    if (url === null) throw siteSkillUrlInvalid()
    const added = site.agentSkills.filter((skill) => !isBuiltinAgentSkill(skill.name)).length
    if (added >= agentSkillLimits.added) throw siteSkillLimit()
    header = headerOf(change.header)
    if (services === null) throw siteSkillAuthUnavailable()
    keyVersion = await storeCheckedKey(services, { siteId: site.id, name: name.data, url, header })
  } else if (change.kind === 'key') {
    if (builtin || !row) throw siteSkillNotFound()
    if (row.authKind !== 'header' || row.url === null) throw siteSkillKeyless()
    header = headerOf(change.header)
    if (services === null) throw siteSkillAuthUnavailable()
    keyVersion = await storeCheckedKey(services, {
      siteId: site.id,
      name: name.data,
      url: row.url,
      header,
    })
  } else if (change.kind === 'remove' && row && row.authKind !== 'none') {
    // The key goes first: a row is never removed while its key stays behind unnamed.
    if (services === null) throw siteSkillAuthUnavailable()
    await eraseSiteSecret(services.secrets, secretPath, now)
  }

  const write = async (tx: Pick<PrismaClient, 'siteAgentSkill' | 'credentialRef'>) => {
    if (change.kind === 'switch') {
      if (!builtin && !row) throw siteSkillNotFound()
      await tx.siteAgentSkill.upsert({
        where: key,
        create: { siteId: site.id, name: name.data, url: null, enabled: change.enabled },
        update: { enabled: change.enabled },
      })
      meta = { ...meta, enabled: change.enabled }
    } else if (change.kind === 'add') {
      if (builtin || row) throw siteSkillExists()
      const url = parseAgentSkillUrl(change.url.trim())
      if (url === null) throw siteSkillUrlInvalid()
      const added = site.agentSkills.filter((skill) => !isBuiltinAgentSkill(skill.name)).length
      if (added >= agentSkillLimits.added) throw siteSkillLimit()
      await tx.siteAgentSkill.create({
        data: {
          siteId: site.id,
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
      if (header === null) throw siteSkillHeaderInvalid()
      await tx.siteAgentSkill.update({
        where: key,
        data: { headerName: header.name, authState: 'ok', authError: null, authCheckedAt: now },
      })
      meta = { ...meta, header: header.name }
    } else {
      if (builtin) throw siteSkillBuiltin()
      if (!row) throw siteSkillNotFound()
      await tx.siteAgentSkill.delete({ where: key })
      await tx.credentialRef.deleteMany({ where: { siteId: site.id, vaultPath: secretPath } })
    }
    if (keyVersion !== null)
      await tx.credentialRef.upsert({
        where: { vaultPath: secretPath },
        create: {
          workspaceId: site.workspaceId,
          siteId: site.id,
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
        workspaceId: site.workspaceId,
        action: `site.agent_skill.${change.kind}`,
        targetType: 'site',
        targetId: site.id,
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
  return readSiteAgentSkills(db, input)
}
