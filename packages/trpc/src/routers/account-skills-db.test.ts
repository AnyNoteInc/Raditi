import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import { legalDocuments, type ObjectStorage } from '@repo/domain'
import { repoReaders, SkillSources, type Fetch } from '@repo/skill-sources'
import { TRPCError } from '@trpc/server'
import { strToU8, zipSync } from 'fflate'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../router.ts'

// «Навыки» on PostgreSQL (docs/plan/97-skills.md): installing from an address, a marketplace and
// an archive, switching within the limits, an update of a skill of a repository, and the objects
// of the versions in the store — written before the row, removed with it.

const databaseUrl = process.env.DATABASE_URL
const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)
const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)

const skillMd = (name: string, text = '') =>
  `---\nname: ${name}\ndescription: Does ${name}. Use when asked.\nmetadata:\n  raditi-title: Навык ${name}\n---\n# ${name}\n${text}`

/** The store of raditi-inbox in memory. */
function memoryStorage() {
  const objects = new Map<string, Uint8Array>()
  const storage = {
    put: async (_bucket: string, key: string, bytes: Uint8Array | AsyncIterable<Uint8Array>) => {
      if (!(bytes instanceof Uint8Array)) throw new Error('bytes expected')
      objects.set(key, bytes)
    },
    get: async (_bucket: string, key: string) => {
      const bytes = objects.get(key)
      return bytes
        ? (async function* () {
            yield bytes
          })()
        : null
    },
    delete: async (_bucket: string, key: string) => {
      objects.delete(key)
    },
  } as unknown as ObjectStorage
  return { objects, storage }
}

/** A public repository of GitHub whose head can move. */
function githubRepo() {
  const state = {
    commit: COMMIT_A,
    files: {
      [COMMIT_A]: {
        '.claude-plugin/marketplace.json': JSON.stringify({
          name: 'demo-market',
          plugins: [{ name: 'docs', source: './', strict: false, skills: ['./skills/pdf'] }],
        }),
        'skills/pdf/SKILL.md': skillMd('pdf'),
        'skills/pdf/scripts/fill.py': 'print(1)',
        'skills/docx/SKILL.md': skillMd('docx'),
      } as Record<string, string>,
      [COMMIT_B]: {
        'skills/pdf/SKILL.md': skillMd('pdf', 'Second version.'),
        'skills/pdf/scripts/fill.py': 'print(2)',
        'skills/pdf/new.md': 'new',
      } as Record<string, string>,
    } as Record<string, Record<string, string>>,
  }
  const fetchFn: Fetch = async (url) => {
    if (url.startsWith('https://api.github.com/repos/o/r/commits/'))
      return Response.json({ sha: state.commit })
    const tree =
      /^https:\/\/api\.github\.com\/repos\/o\/r\/git\/trees\/([0-9a-f]{40})\?recursive=1$/u.exec(
        url,
      )
    if (tree)
      return Response.json({
        truncated: false,
        tree: Object.entries(state.files[tree[1]!] ?? {}).map(([path, text]) => ({
          path,
          mode: path.includes('scripts/') ? '100755' : '100644',
          type: 'blob',
          size: text.length,
        })),
      })
    const raw = /^https:\/\/raw\.githubusercontent\.com\/o\/r\/([0-9a-f]{40})\/(.+)$/u.exec(url)
    if (raw) {
      const text = state.files[raw[1]!]?.[decodeURIComponent(raw[2]!)]
      return text === undefined ? new Response('', { status: 404 }) : new Response(text)
    }
    return new Response('', { status: 404 })
  }
  return { state, sources: new SkillSources(repoReaders(fetchFn)) }
}

async function refusal(act: () => Promise<unknown>): Promise<string> {
  try {
    await act()
  } catch (error) {
    if (error instanceof TRPCError)
      return (error.cause as { code?: string } | undefined)?.code ?? error.code
    throw error
  }
  throw new Error('The procedure was not refused')
}

describe.skipIf(!databaseUrl)('PostgreSQL: the skills of an account (plan 97)', () => {
  let db: PrismaClient
  const userIds: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const users = userIds.splice(0)
    await db.skillMarketplace.deleteMany({
      where: { OR: [{ userId: { in: users } }, { userId: null }] },
    })
    await db.accountSkill.deleteMany({ where: { userId: { in: users } } })
    await db.userConsent.deleteMany({ where: { userId: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function client() {
    const user: User = await db.user.create({
      data: { name: 'Skills verification', email: `${randomUUID()}@skills.example.ru` },
    })
    userIds.push(user.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({ ...consent, userId: user.id, source: 'sign_up' })),
    })
    const repo = githubRepo()
    const store = memoryStorage()
    const caller = createCaller({
      prisma: db,
      headers: new Headers(),
      user,
      session: {
        id: randomUUID(),
        userId: user.id,
        token: `skills-test-${randomUUID()}`,
        expiresAt: new Date('2030-01-01'),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: null,
        userAgent: null,
      },
      billing: null,
      skills: { sources: repo.sources, storage: () => store.storage },
    })
    return { user, caller, repo, store }
  }

  it('lists the built-in skills with skill-creator on and the catalog off', async () => {
    const { caller } = await client()
    const list = await caller.accountSkills.list()
    expect(list.skills.map((skill) => [skill.name, skill.enabled, skill.catalog])).toEqual([
      ['skill-creator', true, false],
      ['commercial-offer', false, true],
      ['product-cards', false, true],
      ['social-posts', false, true],
    ])
    await caller.accountSkills.switch({ builtin: 'social-posts', enabled: true })
    await caller.accountSkills.switch({ builtin: 'skill-creator', enabled: false })
    expect((await caller.accountSkills.slashNames()).map((skill) => skill.name)).toEqual([
      'social-posts',
    ])
  })

  it('installs from an address, asking which skill when it holds several', async () => {
    const { caller, store, user } = await client()
    const choose = await caller.accountSkills.installFromAddress({ address: 'o/r' })
    expect(choose).toMatchObject({ status: 'choose', commit: COMMIT_A })
    const installed = await caller.accountSkills.installFromAddress({
      address: 'o/r',
      path: 'skills/pdf',
    })
    expect(installed).toMatchObject({ status: 'installed', name: 'pdf', enabled: true })
    const keys = [...store.objects.keys()]
    expect(keys).toHaveLength(2)
    expect(keys.every((key) => key.startsWith(`skills/${user.id}/`))).toBe(true)

    const again = await caller.accountSkills.installFromAddress({
      address: 'https://github.com/o/r/tree/main/skills/pdf',
    })
    expect(again).toEqual({ status: 'exists', name: 'pdf' })

    const [, pdf] = (await caller.accountSkills.list()).skills.filter(
      (skill) => skill.name === 'pdf' || skill.name === 'skill-creator',
    )
    expect(pdf).toMatchObject({
      title: 'Навык pdf',
      source: 'git',
      sourceLabel: 'GitHub: o/r/skills/pdf',
      commit: COMMIT_A,
      files: 2,
    })
    const view = await caller.accountSkills.view({ skillId: pdf!.id! })
    expect(view.skillMd).toBe(skillMd('pdf'))
    expect(view.files.map((file) => [file.path, file.executable])).toEqual([
      ['SKILL.md', false],
      ['scripts/fill.py', true],
    ])
  })

  it('finds an update, shows it, and installs the commit the client saw', async () => {
    const { caller, repo } = await client()
    const installed = await caller.accountSkills.installFromAddress({
      address: 'o/r',
      path: 'skills/pdf',
    })
    if (installed.status !== 'installed') throw new Error('not installed')
    expect((await caller.accountSkills.checkUpdates()).found).toBe(0)
    repo.state.commit = COMMIT_B
    await db.accountSkill.update({
      where: { id: installed.skillId },
      data: { updateCheckedAt: null },
    })
    expect((await caller.accountSkills.checkUpdates()).found).toBe(1)
    const preview = await caller.accountSkills.updatePreview({ skillId: installed.skillId })
    expect(preview).toMatchObject({
      commit: COMMIT_B,
      added: ['new.md'],
      changed: ['SKILL.md'],
      removed: [],
    })
    await caller.accountSkills.update({ skillId: installed.skillId, commit: COMMIT_B })
    const pdf = (await caller.accountSkills.list()).skills.find((skill) => skill.name === 'pdf')!
    expect(pdf).toMatchObject({ commit: COMMIT_B, files: 3, updateAvailable: false })
    expect(pdf.history).toHaveLength(1)
    await caller.accountSkills.restore({
      skillId: installed.skillId,
      versionId: pdf.history[0]!.id,
    })
    expect(
      (await caller.accountSkills.list()).skills.find((skill) => skill.name === 'pdf')!.commit,
    ).toBe(COMMIT_A)
    expect(
      await refusal(() =>
        caller.accountSkills.update({ skillId: installed.skillId, commit: COMMIT_A }),
      ),
    ).toBe('SKILL_NO_UPDATE')
  })

  it('reads a marketplace and installs a skill of its plugin', async () => {
    const { caller } = await client()
    const market = await caller.accountSkills.addMarketplace({ address: 'o/r' })
    expect(market).toMatchObject({ name: 'demo-market', platform: false })
    expect(market.plugins[0]!.skills).toEqual([
      { path: 'skills/pdf', name: 'pdf', description: 'Does pdf. Use when asked.' },
    ])
    const answer = await caller.accountSkills.installFromMarketplace({
      marketplaceId: market.id,
      plugin: 'docs',
      path: 'skills/pdf',
    })
    expect(answer).toMatchObject({ status: 'installed', name: 'pdf' })
    const pdf = (await caller.accountSkills.list()).skills.find((skill) => skill.name === 'pdf')!
    expect(pdf.sourceLabel).toBe('Каталог demo-market, docs')
    await caller.accountSkills.removeMarketplace({ marketplaceId: market.id })
    expect(
      await refusal(() => caller.accountSkills.removeMarketplace({ marketplaceId: market.id })),
    ).toBe('MARKETPLACE_NOT_FOUND')
  })

  it('removes a skill with the objects of its versions, and never another user’s', async () => {
    const { caller, store } = await client()
    const stranger = await client()
    const installed = await caller.accountSkills.installFromAddress({
      address: 'o/r',
      path: 'skills/docx',
    })
    if (installed.status !== 'installed') throw new Error('not installed')
    expect(
      await refusal(() => stranger.caller.accountSkills.remove({ skillId: installed.skillId })),
    ).toBe('SKILL_NOT_FOUND')
    await caller.accountSkills.remove({ skillId: installed.skillId })
    expect(store.objects.size).toBe(0)
  })

  it('refuses an archive that is not a skill with its reason, and a name of the platform', async () => {
    const { caller, user, store } = await client()
    const { installSkillFromArchive } = await import('../services/account-skills.ts')
    const deps = { sources: githubRepo().sources, storage: () => store.storage }
    const bad = zipSync({ 'README.md': strToU8('x') })
    expect(
      await installSkillFromArchive(db, deps, {
        userId: user.id,
        bytes: bad,
        fileName: 'x.zip',
      }).catch((error: { details?: { reason?: string } }) => error.details?.reason),
    ).toBe('no_skill_md')
    const good = zipSync({ 'demo/SKILL.md': strToU8(skillMd('demo')) })
    expect(
      await installSkillFromArchive(db, deps, {
        userId: user.id,
        bytes: good,
        fileName: 'demo.skill',
      }),
    ).toMatchObject({ status: 'installed', name: 'demo' })
    expect((await caller.accountSkills.list()).skills.at(-1)).toMatchObject({
      name: 'demo',
      source: 'upload',
      sourceLabel: 'Файл demo.skill',
    })
  })
})
