import { randomUUID } from 'node:crypto'

import { isDomainError, type SkillFrontmatter } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import {
  chatAccountSkillVersions,
  listAccountSkills,
  newAccountSkillVersionId,
  removeAccountSkill,
  restoreAccountSkillVersion,
  setAccountSkillEnabled,
  turnAccountSkills,
  writeAccountSkillVersion,
  type AccountSkillFile,
} from './account-skills.ts'
import type { PrismaClient } from './generated/prisma/client.ts'

const databaseUrl = process.env.DATABASE_URL

async function codeOf(act: () => Promise<unknown>): Promise<string | null> {
  try {
    await act()
    return null
  } catch (error) {
    return isDomainError(error) ? error.code : String(error)
  }
}

const front = (name: string, userOnly = false): SkillFrontmatter => ({
  name,
  description: `Does ${name}.`,
  metadata: {},
  userOnly,
})
const files = (count = 1, sizeBytes = 10): AccountSkillFile[] => [
  { path: 'SKILL.md', sizeBytes, executable: false },
  ...Array.from({ length: count - 1 }, (_, i) => ({
    path: `scripts/${i}.py`,
    sizeBytes,
    executable: true,
  })),
]

describe.skipIf(!databaseUrl)('PostgreSQL: the skills of an account (plan 97)', () => {
  let schema: MigratedSchema
  let db: PrismaClient

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'account_skills')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
  }, 60_000)
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  })

  const user = async () =>
    (await db.user.create({ data: { name: 'Synthetic', email: `${randomUUID()}@example.test` } }))
      .id

  const install = (
    userId: string,
    name: string,
    options: { replace?: boolean; files?: AccountSkillFile[]; userOnly?: boolean } = {},
  ) =>
    writeAccountSkillVersion(db, {
      userId,
      source: 'upload',
      sourceRef: { kind: 'upload', fileName: `${name}.zip` },
      replace: options.replace ?? false,
      version: {
        versionId: newAccountSkillVersionId(),
        frontmatter: front(name, options.userOnly),
        header: { name, description: `Does ${name}.` },
        files: options.files ?? files(),
        sha256: 'a'.repeat(64),
      },
    })

  it('gives a new account the built-in skills on by default', async () => {
    const userId = await user()
    expect(await turnAccountSkills(db, userId)).toEqual([
      { name: 'skill-creator', builtin: true, userOnly: false },
    ])
  })

  it('installs a skill, gives it to a turn and serves its files to the chat of its user', async () => {
    const userId = await user()
    const { skillId, enabled } = await install(userId, 'demo', { files: files(2), userOnly: true })
    expect(enabled).toBe(true)
    const turn = await turnAccountSkills(db, userId)
    expect(turn.map((skill) => skill.name)).toEqual(['demo', 'skill-creator'])
    expect(turn[0]).toMatchObject({ builtin: false, userOnly: true, files: files(2) })

    const workspace = await db.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic', createdById: userId },
    })
    const task = await db.task.create({
      data: { workspaceId: workspace.id, createdById: userId },
      select: { id: true },
    })
    const versions = await chatAccountSkillVersions(db, task.id)
    expect(versions?.userId).toBe(userId)
    expect(versions?.skills.get('demo')?.files).toEqual(files(2))

    await setAccountSkillEnabled(db, { userId, skillId, enabled: false })
    expect((await turnAccountSkills(db, userId)).map((skill) => skill.name)).toEqual([
      'skill-creator',
    ])
  })

  it('refuses a second skill of a name unless it replaces it, and keeps five versions', async () => {
    const userId = await user()
    const first = await install(userId, 'demo')
    expect(await codeOf(() => install(userId, 'demo'))).toBe('SKILL_EXISTS')
    expect(await codeOf(() => install(userId, 'skill-creator'))).toBe('SKILL_EXISTS')
    let pruned: string[] = []
    for (let i = 0; i < 5; i += 1)
      pruned = (await install(userId, 'demo', { replace: true })).pruned
    expect(pruned).toHaveLength(1)
    const [row] = await listAccountSkills(db, userId)
    expect(row!.id).toBe(first.skillId)
    expect(row!.history).toHaveLength(4)
    await restoreAccountSkillVersion(db, {
      userId,
      skillId: row!.id,
      versionId: row!.history[0]!.id,
    })
    const [restored] = await listAccountSkills(db, userId)
    expect(restored!.version!.id).toBe(row!.history[0]!.id)
  })

  it('turns built-in skills on and off by a row of their name', async () => {
    const userId = await user()
    await setAccountSkillEnabled(db, { userId, builtin: 'skill-creator', enabled: false })
    await setAccountSkillEnabled(db, { userId, builtin: 'social-posts', enabled: true })
    expect((await turnAccountSkills(db, userId)).map((skill) => skill.name)).toEqual([
      'social-posts',
    ])
    expect(
      await codeOf(() => setAccountSkillEnabled(db, { userId, builtin: 'nope', enabled: true })),
    ).toBe('SKILL_NOT_FOUND')
  })

  it('keeps the bounds of a turn: twenty on, and no more files than a turn takes', async () => {
    const userId = await user()
    for (let i = 0; i < 19; i += 1) await install(userId, `s${i}`)
    // skill-creator is the twentieth; the next comes in off.
    expect((await install(userId, 'late')).enabled).toBe(false)
    const late = (await listAccountSkills(db, userId)).find((row) => row.name === 'late')!
    expect(
      await codeOf(() => setAccountSkillEnabled(db, { userId, skillId: late.id, enabled: true })),
    ).toBe('SKILLS_ENABLED_TOO_MANY')

    const other = await user()
    for (let i = 0; i < 6; i += 1) await install(other, `big${i}`, { files: files(100) })
    expect((await install(other, 'over', { files: files(100) })).enabled).toBe(false)
  })

  it('removes a skill with its versions, and never one of another user', async () => {
    const userId = await user()
    const stranger = await user()
    const { skillId } = await install(userId, 'demo')
    await install(userId, 'demo', { replace: true })
    expect(await codeOf(() => removeAccountSkill(db, { userId: stranger, skillId }))).toBe(
      'SKILL_NOT_FOUND',
    )
    expect(await removeAccountSkill(db, { userId, skillId })).toHaveLength(2)
    expect(await listAccountSkills(db, userId)).toEqual([])
    expect(await db.accountSkillVersion.count({ where: { skillId } })).toBe(0)
  })
})
