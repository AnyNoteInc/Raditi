import {
  accountSkillLimits,
  builtinSkill,
  builtinSkills,
  skillExists,
  skillNotFound,
  skillsEnabledTooMany,
  skillsTooMany,
  skillsTurnTooLarge,
  turnSkillFilesLimits,
  type SkillFrontmatter,
  type SkillSourceKind,
  type SkillSourceRef,
} from '@repo/domain'
import { z } from 'zod'

import type { Prisma, PrismaClient } from './generated/prisma/client.ts'
import { uuidv7 } from './uuidv7.ts'

// The skills of an account (docs/plan/97-skills.md, Нв1–Нв4, Нв13): what a turn of a user gets,
// a file of one of them as the executor reads it, the list of the cabinet, and a new version
// written under a lock of the user — so that two installs side by side never pass a limit
// together. The bytes are the caller's: it puts them into raditi-inbox before the row and
// removes the ones a removal or a pruning returns.

type Tx = Prisma.TransactionClient
type Db = Pick<PrismaClient, '$transaction'>
const id = z.uuid()

/** A file of a version as `account_skill_versions.files` keeps it; its place is its number. */
export const accountSkillFileSchema = z
  .object({
    path: z.string().min(1).max(accountSkillLimits.pathChars),
    sizeBytes: z.number().int().min(0).max(accountSkillLimits.fileBytes),
    executable: z.boolean(),
  })
  .strict()
export type AccountSkillFile = z.infer<typeof accountSkillFileSchema>
const filesSchema = z.array(accountSkillFileSchema).min(1).max(accountSkillLimits.filesPerSkill)

/** The files of a version, as kept; a row the schema refuses has none a turn may take. */
export function accountSkillFilesOf(value: unknown): AccountSkillFile[] {
  const parsed = filesSchema.safeParse(value)
  return parsed.success ? parsed.data : []
}

/** A skill of a turn: built-in, or a version of the account's with its files. */
export interface TurnAccountSkillRow {
  name: string
  builtin: boolean
  userOnly: boolean
  /** Not for a built-in skill. */
  versionId?: string
  files?: AccountSkillFile[]
}

/**
 * The skills of a user a turn gets (Нв13): the built-in ones on by default unless the user turned
 * them off, the ones of the catalog the user turned on, and every enabled skill of the user's own
 * with its current version. Sorted by name; within the bounds of a turn — a skill that would
 * cross them is left out, which the cabinet already refuses (`setAccountSkillEnabled`).
 */
export async function turnAccountSkills(
  db: Pick<Tx, 'accountSkill'>,
  userId: string,
): Promise<TurnAccountSkillRow[]> {
  const rows = await db.accountSkill.findMany({
    where: { userId: id.parse(userId) },
    select: {
      name: true,
      source: true,
      enabled: true,
      version: { select: { id: true, userOnly: true, files: true } },
    },
    orderBy: { name: 'asc' },
  })
  const byName = new Map(rows.map((row) => [row.name, row]))
  const skills: TurnAccountSkillRow[] = []
  for (const skill of builtinSkills) {
    const row = byName.get(skill.name)
    const enabled = row && row.source === 'builtin' ? row.enabled : skill.defaultEnabled
    if (enabled) skills.push({ name: skill.name, builtin: true, userOnly: false })
  }
  let files = 0
  let bytes = 0
  for (const row of rows) {
    if (row.source === 'builtin' || !row.enabled || !row.version || builtinSkill(row.name)) continue
    const own = accountSkillFilesOf(row.version.files)
    if (own.length === 0) continue
    const size = own.reduce((sum, file) => sum + file.sizeBytes, 0)
    if (
      files + own.length > turnSkillFilesLimits.files ||
      bytes + size > turnSkillFilesLimits.bytes
    )
      continue
    files += own.length
    bytes += size
    skills.push({
      name: row.name,
      builtin: false,
      userOnly: row.version.userOnly,
      versionId: row.version.id,
      files: own,
    })
  }
  if (skills.length > accountSkillLimits.enabled) skills.length = accountSkillLimits.enabled
  return skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * The enabled skills of the author of a chat with their current versions, as the executor of a
 * turn reads their files (docs/plan/97-skills.md, Нв13): by name, now — a skill the client turned
 * off or changed since the plan was made is absent or has its new files. null — the chat has no
 * author.
 */
export async function chatAccountSkillVersions(
  db: Pick<Tx, 'task' | 'accountSkill'>,
  taskId: string,
): Promise<{
  userId: string
  skills: Map<string, { versionId: string; files: AccountSkillFile[] }>
} | null> {
  const task = await db.task.findUnique({
    where: { id: id.parse(taskId) },
    select: { createdById: true },
  })
  if (!task?.createdById) return null
  const rows = await db.accountSkill.findMany({
    where: { userId: task.createdById, enabled: true, source: { not: 'builtin' } },
    select: { name: true, version: { select: { id: true, files: true } } },
  })
  const skills = new Map<string, { versionId: string; files: AccountSkillFile[] }>()
  for (const row of rows)
    if (row.version)
      skills.set(row.name, {
        versionId: row.version.id,
        files: accountSkillFilesOf(row.version.files),
      })
  return { userId: task.createdById, skills }
}

/** A row of the cabinet: a skill of the user's own, with its current version. */
export interface AccountSkillRow {
  id: string
  name: string
  source: SkillSourceKind
  sourceRef: unknown
  enabled: boolean
  updateCommit: string | null
  createdAt: Date
  updatedAt: Date
  version: {
    id: string
    commit: string | null
    description: string
    license: string | null
    userOnly: boolean
    frontmatter: unknown
    files: AccountSkillFile[]
    sizeBytes: number
    createdAt: Date
  } | null
  /** Earlier versions, newest first. */
  history: { id: string; commit: string | null; createdAt: Date }[]
}

const rowSelect = {
  id: true,
  name: true,
  source: true,
  sourceRef: true,
  enabled: true,
  updateCommit: true,
  createdAt: true,
  updatedAt: true,
  versionId: true,
  version: {
    select: {
      id: true,
      commit: true,
      description: true,
      license: true,
      userOnly: true,
      frontmatter: true,
      files: true,
      sizeBytes: true,
      createdAt: true,
    },
  },
  versions: {
    select: { id: true, commit: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: accountSkillLimits.versionsKept + 1,
  },
} as const

type SelectedRow = Prisma.AccountSkillGetPayload<{ select: typeof rowSelect }>

function rowOf(row: SelectedRow): AccountSkillRow {
  return {
    id: row.id,
    name: row.name,
    source: row.source as SkillSourceKind,
    sourceRef: row.sourceRef,
    enabled: row.enabled,
    updateCommit: row.updateCommit,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version ? { ...row.version, files: accountSkillFilesOf(row.version.files) } : null,
    history: row.versions.filter((version) => version.id !== row.versionId),
  }
}

/** Every skill row of a user: the own ones, and the built-in ones whose default they changed. */
export async function listAccountSkills(
  db: Pick<Tx, 'accountSkill'>,
  userId: string,
): Promise<AccountSkillRow[]> {
  const rows = await db.accountSkill.findMany({
    where: { userId: id.parse(userId) },
    select: rowSelect,
    orderBy: { name: 'asc' },
  })
  return rows.map(rowOf)
}

/** One skill of a user by its id; SKILL_NOT_FOUND for another user's. */
export async function accountSkillOf(
  db: Pick<Tx, 'accountSkill'>,
  input: { userId: string; skillId: string },
): Promise<AccountSkillRow> {
  const row = await db.accountSkill.findFirst({
    where: { id: id.parse(input.skillId), userId: id.parse(input.userId) },
    select: rowSelect,
  })
  if (!row) throw skillNotFound()
  return rowOf(row)
}

/** Holds the skills of a user until the transaction ends: limits are counted under it. */
async function lockUser(tx: Pick<Tx, '$executeRaw'>, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`account_skills:${userId}`}, 0))`
}

/** What the turns of a user would take with these skills on, and whether it fits (Нв3). */
async function assertEnabledFit(
  tx: Pick<Tx, 'accountSkill'>,
  userId: string,
  change: { name: string; files?: AccountSkillFile[]; builtinOn?: boolean },
): Promise<void> {
  const rows = await tx.accountSkill.findMany({
    where: { userId },
    select: { name: true, source: true, enabled: true, version: { select: { files: true } } },
  })
  const enabled = new Map<string, AccountSkillFile[]>()
  for (const skill of builtinSkills) {
    const row = rows.find((candidate) => candidate.name === skill.name)
    if (row ? row.enabled : skill.defaultEnabled) enabled.set(skill.name, [])
  }
  for (const row of rows)
    if (row.source !== 'builtin' && row.enabled && row.version)
      enabled.set(row.name, accountSkillFilesOf(row.version.files))
  if (change.builtinOn) enabled.set(change.name, [])
  else if (change.files) enabled.set(change.name, change.files)
  if (enabled.size > accountSkillLimits.enabled) throw skillsEnabledTooMany()
  const files = [...enabled.values()].flat()
  if (
    files.length > turnSkillFilesLimits.files ||
    files.reduce((sum, file) => sum + file.sizeBytes, 0) > turnSkillFilesLimits.bytes
  )
    throw skillsTurnTooLarge()
}

/** A version to write: its facts; its files are already in raditi-inbox under `versionId`. */
export interface AccountSkillVersionInput {
  versionId: string
  commit?: string | null
  frontmatter: SkillFrontmatter
  /** Every field of the header, for keeping. */
  header: unknown
  files: AccountSkillFile[]
  sha256: string
}

/** A new id for a version, to name its objects before its row exists. */
export const newAccountSkillVersionId = (): string => uuidv7()

/**
 * Installs a skill, or — `replace` — makes the version the current one of the user's skill of
 * the same name (Нв11, Нв20). Under the lock of the user: at most 50 skills, a new one enabled
 * only when 20 enabled ones and the bounds of a turn still allow, else installed off. A name of a
 * built-in skill is the platform's. Returns the skill, whether it is on, and the versions pruned
 * past the five kept, whose objects the caller removes.
 */
export async function writeAccountSkillVersion(
  db: Db,
  input: {
    userId: string
    source: Exclude<SkillSourceKind, 'builtin'>
    sourceRef: SkillSourceRef
    version: AccountSkillVersionInput
    replace: boolean
  },
): Promise<{ skillId: string; enabled: boolean; pruned: string[] }> {
  return db.$transaction(async (tx) => {
    const userId = id.parse(input.userId)
    const name = input.version.frontmatter.name
    if (builtinSkill(name)) throw skillExists()
    await lockUser(tx, userId)
    const existing = await tx.accountSkill.findUnique({
      where: { userId_name: { userId, name } },
      select: { id: true, enabled: true, source: true },
    })
    if (existing && !input.replace) throw skillExists()
    if (
      !existing &&
      (await tx.accountSkill.count({ where: { userId } })) >= accountSkillLimits.installed
    )
      throw skillsTooMany()
    const wantsOn = existing ? existing.enabled : true
    let enabled = wantsOn
    if (wantsOn)
      try {
        await assertEnabledFit(tx, userId, { name, files: input.version.files })
      } catch (error) {
        // A new skill that does not fit comes in off; a new version of an enabled one that grew
        // past the bounds is refused — turning it off silently would surprise the client.
        if (existing) throw error
        enabled = false
      }
    const versionData = {
      id: input.version.versionId,
      commit: input.version.commit ?? null,
      description: input.version.frontmatter.description,
      license: input.version.frontmatter.license ?? null,
      userOnly: input.version.frontmatter.userOnly,
      frontmatter: (input.version.header ?? {}) as Prisma.InputJsonValue,
      files: input.version.files,
      fileCount: input.version.files.length,
      sizeBytes: input.version.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      sha256: input.version.sha256,
    }
    let skillId: string
    if (existing) {
      skillId = existing.id
      await tx.accountSkillVersion.create({ data: { ...versionData, skillId } })
      await tx.accountSkill.update({
        where: { id: skillId },
        data: {
          versionId: versionData.id,
          source: input.source,
          sourceRef: input.sourceRef as Prisma.InputJsonValue,
          updateCommit: null,
        },
      })
    } else {
      skillId = uuidv7()
      // The skill and its first version point at each other: the skill first, without one.
      await tx.accountSkill.create({
        data: {
          id: skillId,
          userId,
          name,
          source: input.source,
          sourceRef: input.sourceRef as Prisma.InputJsonValue,
          enabled,
        },
      })
      await tx.accountSkillVersion.create({ data: { ...versionData, skillId } })
      await tx.accountSkill.update({ where: { id: skillId }, data: { versionId: versionData.id } })
    }
    const versions = await tx.accountSkillVersion.findMany({
      where: { skillId },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    })
    const pruned = versions.slice(accountSkillLimits.versionsKept).map((version) => version.id)
    if (pruned.length) await tx.accountSkillVersion.deleteMany({ where: { id: { in: pruned } } })
    return { skillId, enabled, pruned }
  })
}

/**
 * Turns a skill on or off (Нв2): an own one by its id, a built-in one by its name — its row made
 * or changed. On only when the limits allow (SKILLS_ENABLED_TOO_MANY, SKILLS_TURN_TOO_LARGE).
 */
export async function setAccountSkillEnabled(
  db: Db,
  input: { userId: string; skillId?: string; builtin?: string; enabled: boolean },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const userId = id.parse(input.userId)
    await lockUser(tx, userId)
    if (input.builtin !== undefined) {
      if (!builtinSkill(input.builtin)) throw skillNotFound()
      if (input.enabled)
        await assertEnabledFit(tx, userId, { name: input.builtin, builtinOn: true })
      await tx.accountSkill.upsert({
        where: { userId_name: { userId, name: input.builtin } },
        create: {
          userId,
          name: input.builtin,
          source: 'builtin',
          sourceRef: { kind: 'builtin' },
          enabled: input.enabled,
        },
        update: { enabled: input.enabled },
      })
      return
    }
    const skill = await tx.accountSkill.findFirst({
      where: { id: id.parse(input.skillId), userId, source: { not: 'builtin' } },
      select: { id: true, name: true, version: { select: { files: true } } },
    })
    if (!skill) throw skillNotFound()
    if (input.enabled)
      await assertEnabledFit(tx, userId, {
        name: skill.name,
        files: accountSkillFilesOf(skill.version?.files),
      })
    await tx.accountSkill.update({ where: { id: skill.id }, data: { enabled: input.enabled } })
  })
}

/**
 * Makes an earlier version the current one (Нв4, «Вернуть прошлую версию»). The limits of a turn
 * are checked again when the skill is on.
 */
export async function restoreAccountSkillVersion(
  db: Db,
  input: { userId: string; skillId: string; versionId: string },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const userId = id.parse(input.userId)
    await lockUser(tx, userId)
    const skill = await tx.accountSkill.findFirst({
      where: { id: id.parse(input.skillId), userId, source: { not: 'builtin' } },
      select: { id: true, name: true, enabled: true },
    })
    if (!skill) throw skillNotFound()
    const version = await tx.accountSkillVersion.findFirst({
      where: { id: id.parse(input.versionId), skillId: skill.id },
      select: { id: true, files: true },
    })
    if (!version) throw skillNotFound()
    if (skill.enabled)
      await assertEnabledFit(tx, userId, {
        name: skill.name,
        files: accountSkillFilesOf(version.files),
      })
    await tx.accountSkill.update({
      where: { id: skill.id },
      data: { versionId: version.id, updateCommit: null },
    })
  })
}

/**
 * Removes a skill of the user with all its versions; returns the versions whose objects the
 * caller removes. A built-in skill is not removed — only turned off.
 */
export async function removeAccountSkill(
  db: Db,
  input: { userId: string; skillId: string },
): Promise<string[]> {
  return db.$transaction(async (tx) => {
    const userId = id.parse(input.userId)
    await lockUser(tx, userId)
    const skill = await tx.accountSkill.findFirst({
      where: { id: id.parse(input.skillId), userId, source: { not: 'builtin' } },
      select: { id: true, versions: { select: { id: true } } },
    })
    if (!skill) throw skillNotFound()
    // Its versions go with it (ON DELETE CASCADE); its pointer at one is checked at the end.
    await tx.accountSkill.delete({ where: { id: skill.id } })
    return skill.versions.map((version) => version.id)
  })
}
