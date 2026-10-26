import type { PrismaClient } from '@repo/db'
import {
  agentSkillLimits,
  agentSkillNameSchema,
  builtinAgentSkills,
  DomainError,
  isBuiltinAgentSkill,
  parseAgentSkillUrl,
} from '@repo/domain'

import { isManagerRole, memberRole } from './chat/access.ts'
import { accessibleSite, siteNotFound } from './site-basics.ts'

// «Навыки агента» of a site (owner's request of 26.10.2026): the MCP servers its agent connects
// to besides the platform's own, over the open internet of a turn. The platform's two are on
// until an owner or an admin turns one off; they add remote servers by an https address. Core
// reads the rows for every pass (`turnSkillsOf`); a skill keeps nothing secret.

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

async function siteOf(db: PrismaClient, userId: string, siteId: string) {
  const site = await db.site.findFirst({
    where: accessibleSite(userId, siteId),
    select: {
      id: true,
      workspaceId: true,
      agentSkills: { select: { name: true, url: true, enabled: true } },
    },
  })
  if (!site) throw siteNotFound()
  return site
}

const byName = (left: { name: string }, right: { name: string }) =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0

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
      })),
      ...added.map((row) => ({
        name: row.name,
        title: row.name,
        description: null,
        builtin: false,
        url: row.url,
        enabled: row.enabled,
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

type Change =
  | { kind: 'switch'; name: string; enabled: boolean }
  | { kind: 'add'; name: string; url: string }
  | { kind: 'remove'; name: string }

/** One change of the skills of a site; an owner or an admin only, audited. */
export async function changeSiteAgentSkills(
  db: PrismaClient,
  input: { userId: string; siteId: string; ip: string | null; change: Change },
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

  const write = async (tx: Pick<PrismaClient, 'siteAgentSkill'>) => {
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
      await tx.siteAgentSkill.create({ data: { siteId: site.id, name: name.data, url } })
      // The address is the owner's choice of a public server: it names no secret.
      meta = { ...meta, url }
    } else {
      if (builtin) throw siteSkillBuiltin()
      if (!row) throw siteSkillNotFound()
      await tx.siteAgentSkill.delete({ where: key })
    }
  }

  await db.$transaction(async (tx) => {
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
  return readSiteAgentSkills(db, input)
}
