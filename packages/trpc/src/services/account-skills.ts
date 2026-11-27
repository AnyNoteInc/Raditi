import { createHash } from 'node:crypto'

import {
  accountSkillOf,
  listAccountSkills,
  newAccountSkillVersionId,
  removeAccountSkill,
  restoreAccountSkillVersion,
  setAccountSkillEnabled,
  writeAccountSkillVersion,
  type AccountSkillFile,
  type AccountSkillRow,
  type Prisma,
  type PrismaClient,
} from '@repo/db'
import {
  accountSkillFileKey,
  accountSkillLimits,
  builtinSkills,
  isDomainError,
  marketplaceNotFound,
  marketplacesTooMany,
  parseSkillRepoAddress,
  skillInvalid,
  skillNoUpdate,
  skillNotFound,
  skillRepoRefSchema,
  skillRepoWebUrl,
  skillRussianTexts,
  skillSourceRefSchema,
  SKILL_MD,
  type ObjectStorage,
  type SkillRepoRef,
  type SkillSourceRef,
} from '@repo/domain'
import {
  readSkillArchive,
  type FoundSkill,
  type SkillSources,
  type SkillVersion,
} from '@repo/skill-sources'
import { z } from 'zod'

import { readTaskFile } from './chat/files.ts'

// «Навыки» of an account (docs/plan/97-skills.md, Нв1–Нв12, Нв20, Нв21): the built-in skills and
// the catalog of Радити, the user's own skills with their versions, and the marketplaces they are
// installed from. A skill is read and checked here (@repo/skill-sources), its files go into
// raditi-inbox under skills/<user>/<version>/<n> before its row, and the rows of a user are written
// under the user's lock (@repo/db). A source is a public repository of GitHub or gitlab.com,
// a marketplace, an uploaded archive, or a `.skill` file the agent made in a chat of the user —
// which the client saves with «Сохранить как навык»: the click is the confirmation (Нв20).

export interface AccountSkillServices {
  sources: SkillSources
  storage: () => ObjectStorage
}

/** The platform's marketplaces (Нв7): shown to every account, never removed by one. */
export const platformMarketplaces: readonly SkillRepoRef[] = Object.freeze([
  { host: 'github', repo: 'anthropics/skills', path: '' },
])

/** A marketplace's listing is read again after this long. */
const LISTING_TTL_MS = 24 * 60 * 60 * 1000
/** A skill of a repository looks for a newer commit after this long (Нв11). */
const UPDATE_TTL_MS = 24 * 60 * 60 * 1000
/** Update checks of one call of the cabinet: each is a request to the provider. */
const UPDATE_CHECKS = 5

/** A plain value Prisma keeps as JSON: what came through JSON.parse already is one. */
const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

type Db = Pick<
  PrismaClient,
  '$transaction' | 'accountSkill' | 'skillMarketplace' | 'task' | 'taskEvent'
>

// ---------------------------------------------------------------------------------------------
// The view of the cabinet
// ---------------------------------------------------------------------------------------------

export interface SkillView {
  /** null for a built-in skill: it is addressed by its name. */
  id: string | null
  name: string
  title: string
  description: string
  summary: string | null
  source: 'builtin' | 'marketplace' | 'git' | 'upload' | 'created'
  /** Built-in: of the catalog of Радити rather than a tool of the platform. */
  catalog: boolean
  enabled: boolean
  userOnly: boolean
  license: string | null
  /** The page of its source, for a skill of a repository. */
  sourceUrl: string | null
  /** What the client reads about its source: a repository, a marketplace, a file, a chat. */
  sourceLabel: string
  commit: string | null
  updateAvailable: boolean
  files: number
  sizeBytes: number
  installedAt: string | null
  updatedAt: string | null
  history: { id: string; commit: string | null; createdAt: string }[]
}

function sourceLabelOf(ref: SkillSourceRef | null, marketplaces: Map<string, string>): string {
  switch (ref?.kind) {
    case 'git':
      return `${ref.repo.host === 'github' ? 'GitHub' : 'GitLab'}: ${ref.repo.repo}${ref.repo.path ? `/${ref.repo.path}` : ''}`
    case 'marketplace':
      return `Каталог ${marketplaces.get(ref.marketplaceId) ?? ref.repo.repo}, ${ref.plugin}`
    case 'upload':
      return `Файл ${ref.fileName}`
    case 'created':
      return 'Создан агентом в чате'
    default:
      return 'Радити'
  }
}

const sourceRefOf = (value: unknown): SkillSourceRef | null => {
  const parsed = skillSourceRefSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function viewOf(row: AccountSkillRow, marketplaces: Map<string, string>): SkillView {
  const ref = sourceRefOf(row.sourceRef)
  const meta = (row.version?.frontmatter as { metadata?: Record<string, unknown> } | null)?.metadata
  const texts = skillRussianTexts(
    Object.fromEntries(
      Object.entries(meta ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  )
  const repo = ref?.kind === 'git' || ref?.kind === 'marketplace' ? ref.repo : null
  return {
    id: row.id,
    name: row.name,
    title: texts.title ?? row.name,
    description: row.version?.description ?? '',
    summary: texts.summary ?? null,
    source: row.source,
    catalog: false,
    enabled: row.enabled,
    userOnly: row.version?.userOnly ?? false,
    license: row.version?.license ?? null,
    sourceUrl: repo ? skillRepoWebUrl(repo, row.version?.commit) : null,
    sourceLabel: sourceLabelOf(ref, marketplaces),
    commit: row.version?.commit ?? null,
    updateAvailable: row.updateCommit !== null && row.updateCommit !== row.version?.commit,
    files: row.version?.files.length ?? 0,
    sizeBytes: row.version?.sizeBytes ?? 0,
    installedAt: row.createdAt.toISOString(),
    updatedAt: row.version?.createdAt.toISOString() ?? null,
    history: row.history.map((version) => ({
      id: version.id,
      commit: version.commit,
      createdAt: version.createdAt.toISOString(),
    })),
  }
}

/**
 * «Навыки» of a user: the built-in skills with their state, then the user's own, by name; the
 * limits of the page.
 */
export async function readAccountSkills(
  db: Db,
  userId: string,
): Promise<{
  skills: SkillView[]
  limits: { installed: number; enabled: number }
  counts: { installed: number; enabled: number }
}> {
  const rows = await listAccountSkills(db, userId)
  const marketplaces = new Map(
    (
      await db.skillMarketplace.findMany({
        where: { OR: [{ userId }, { userId: null }] },
        select: { id: true, name: true, repo: true },
      })
    ).map((row) => [row.id, row.name ?? row.repo]),
  )
  const builtins: SkillView[] = builtinSkills.map((skill) => {
    const row = rows.find(
      (candidate) => candidate.name === skill.name && candidate.source === 'builtin',
    )
    return {
      id: null,
      name: skill.name,
      title: skill.title,
      description: skill.description,
      summary: skill.summary,
      source: 'builtin',
      catalog: skill.catalog,
      enabled: row ? row.enabled : skill.defaultEnabled,
      userOnly: false,
      license: skill.license ?? null,
      sourceUrl: null,
      sourceLabel: 'Радити',
      commit: null,
      updateAvailable: false,
      files: 0,
      sizeBytes: 0,
      installedAt: null,
      updatedAt: null,
      history: [],
    }
  })
  const own = rows.filter((row) => row.source !== 'builtin').map((row) => viewOf(row, marketplaces))
  const skills = [...builtins, ...own]
  return {
    skills,
    limits: { installed: accountSkillLimits.installed, enabled: accountSkillLimits.enabled },
    counts: {
      installed: own.length + builtins.filter((skill) => skill.catalog && skill.enabled).length,
      enabled: skills.filter((skill) => skill.enabled).length,
    },
  }
}

/**
 * The text of SKILL.md of a skill of the user's own and the paths of its files, for «Открыть».
 * A built-in skill shows its description only: its files are the sandbox image's.
 */
export async function readAccountSkillText(
  db: Db,
  deps: Pick<AccountSkillServices, 'storage'>,
  input: { userId: string; skillId: string },
): Promise<{ skillMd: string; files: AccountSkillFile[] }> {
  const row = await accountSkillOf(db, input)
  if (!row.version) throw skillNotFound()
  const index = row.version.files.findIndex((file) => file.path === SKILL_MD)
  if (index < 0) throw skillNotFound()
  const body = await deps
    .storage()
    .get('inbox', accountSkillFileKey(input.userId, row.version.id, index))
  if (body === null) throw skillNotFound()
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of body) {
    size += chunk.byteLength
    if (size > accountSkillLimits.skillMdBytes) break
    chunks.push(chunk)
  }
  return {
    skillMd: new TextDecoder().decode(Buffer.concat(chunks)),
    files: row.version.files,
  }
}

// ---------------------------------------------------------------------------------------------
// Installing a version
// ---------------------------------------------------------------------------------------------

/** The digest of a version: its files in order, each path and its bytes. */
function versionDigest(version: SkillVersion): string {
  const hash = createHash('sha256')
  for (const file of version.files) {
    hash.update(`${file.path}\0${file.bytes.byteLength}\0${file.executable ? 1 : 0}\0`)
    hash.update(file.bytes)
  }
  return hash.digest('hex')
}

async function removeObjects(
  storage: ObjectStorage,
  userId: string,
  versions: readonly { id: string; files: number }[],
): Promise<void> {
  for (const version of versions)
    for (let index = 0; index < version.files; index += 1)
      await storage.delete('inbox', accountSkillFileKey(userId, version.id, index)).catch(() => {})
}

/**
 * Keeps a checked version (Нв4, Нв10): its files into raditi-inbox under a new version, then the
 * rows. A failed write removes the objects it put; the versions pruned past five lose theirs.
 */
async function installVersion(
  db: Db,
  deps: AccountSkillServices,
  input: {
    userId: string
    version: SkillVersion
    source: 'marketplace' | 'git' | 'upload' | 'created'
    sourceRef: SkillSourceRef
    commit?: string | null
    replace: boolean
  },
): Promise<{ skillId: string; name: string; enabled: boolean }> {
  const storage = deps.storage()
  const versionId = newAccountSkillVersionId()
  const files: AccountSkillFile[] = input.version.files.map((file) => ({
    path: file.path,
    sizeBytes: file.bytes.byteLength,
    executable: file.executable,
  }))
  const put: { id: string; files: number } = { id: versionId, files: 0 }
  try {
    for (const [index, file] of input.version.files.entries()) {
      await storage.put('inbox', accountSkillFileKey(input.userId, versionId, index), file.bytes, {
        contentType: 'application/octet-stream',
        sizeBytes: file.bytes.byteLength,
      })
      put.files = index + 1
    }
    const written = await writeAccountSkillVersion(db, {
      userId: input.userId,
      source: input.source,
      sourceRef: input.sourceRef,
      replace: input.replace,
      version: {
        versionId,
        commit: input.commit ?? null,
        frontmatter: input.version.frontmatter,
        header: input.version.header,
        files,
        sha256: versionDigest(input.version),
      },
    })
    if (written.pruned.length) {
      // A pruned version had at most the bound of files; the missing keys are no error.
      await removeObjects(
        storage,
        input.userId,
        written.pruned.map((id) => ({ id, files: accountSkillLimits.filesPerSkill })),
      )
    }
    return {
      skillId: written.skillId,
      name: input.version.frontmatter.name,
      enabled: written.enabled,
    }
  } catch (error) {
    await removeObjects(storage, input.userId, [put])
    throw error
  }
}

/** An install that met a skill of the same name: the client chooses to replace it. */
export type InstallAnswer =
  | { status: 'installed'; skillId: string; name: string; enabled: boolean }
  | { status: 'exists'; name: string }
  | { status: 'choose'; commit: string; skills: FoundSkill[] }

async function installOrAsk(
  db: Db,
  deps: AccountSkillServices,
  input: Parameters<typeof installVersion>[2],
): Promise<InstallAnswer> {
  try {
    return { status: 'installed', ...(await installVersion(db, deps, input)) }
  } catch (error) {
    if (isDomainError(error) && error.code === 'SKILL_EXISTS' && !input.replace)
      return { status: 'exists', name: input.version.frontmatter.name }
    throw error
  }
}

/**
 * «Добавить по ссылке» (Нв8): the skill at the address; when the address holds several, the
 * client chooses one (`path`). `replace` — a new version of a skill of the same name.
 */
export async function installSkillFromAddress(
  db: Db,
  deps: AccountSkillServices,
  input: { userId: string; address: string; path?: string; replace?: boolean },
): Promise<InstallAnswer> {
  const ref = parseSkillRepoAddress(input.address)
  const found = await deps.sources.find(
    input.path !== undefined ? { ...ref, path: input.path } : ref,
  )
  if (found.skills.length !== 1) return { status: 'choose', ...found }
  const folder = found.skills[0]!.path
  const version = await deps.sources.read(ref, found.commit, folder)
  const repo = { ...ref, path: folder }
  return installOrAsk(db, deps, {
    userId: input.userId,
    version,
    source: 'git',
    sourceRef: { kind: 'git', repo },
    commit: found.commit,
    replace: input.replace ?? false,
  })
}

/** «Добавить из файла» (Нв9): a `.zip` or `.skill`, read and checked whole in memory. */
export async function installSkillFromArchive(
  db: Db,
  deps: AccountSkillServices,
  input: { userId: string; bytes: Uint8Array; fileName: string; replace?: boolean },
): Promise<InstallAnswer> {
  const version = readSkillArchive(input.bytes)
  return installOrAsk(db, deps, {
    userId: input.userId,
    version,
    source: 'upload',
    sourceRef: { kind: 'upload', fileName: input.fileName.slice(0, 255) },
    replace: input.replace ?? false,
  })
}

/**
 * «Сохранить как навык» of a `.skill` file the agent left in a chat (Нв20): only a member of the
 * chat reads it, and the click of its author is the confirmation — the words of the model are not.
 * A skill of the same name gets a new version when the client says so.
 */
export async function installSkillFromChatFile(
  db: Db,
  deps: AccountSkillServices,
  input: { userId: string; taskId: string; fileId: string; replace?: boolean },
): Promise<InstallAnswer> {
  const file = await readTaskFile(db, deps.storage(), input)
  if (!file || !/\.(skill|zip)$/iu.test(file.name)) throw skillNotFound()
  const version = readSkillArchive(file.bytes)
  return installOrAsk(db, deps, {
    userId: input.userId,
    version,
    source: 'created',
    sourceRef: { kind: 'created', taskId: input.taskId },
    replace: input.replace ?? false,
  })
}

// ---------------------------------------------------------------------------------------------
// Marketplaces
// ---------------------------------------------------------------------------------------------

const listingSchema = z.array(
  z.object({
    name: z.string(),
    description: z.string().optional(),
    repo: skillRepoRefSchema,
    skills: z
      .array(z.object({ path: z.string(), name: z.string(), description: z.string().optional() }))
      .nullable(),
  }),
)
export type MarketplaceListing = z.infer<typeof listingSchema>

export interface MarketplaceView {
  id: string
  name: string
  repo: string
  host: 'github' | 'gitlab'
  url: string
  platform: boolean
  plugins: MarketplaceListing
  fetchedAt: string | null
  /** The last read failed; the listing is the one before it, or none. */
  stale: boolean
}

async function platformRow(db: Db, ref: SkillRepoRef) {
  const found = await db.skillMarketplace.findFirst({
    where: { userId: null, host: ref.host, repo: ref.repo },
  })
  if (found) return found
  try {
    return await db.skillMarketplace.create({ data: { host: ref.host, repo: ref.repo } })
  } catch {
    // Another request made it at the same time.
    return db.skillMarketplace.findFirstOrThrow({
      where: { userId: null, host: ref.host, repo: ref.repo },
    })
  }
}

/** Reads a marketplace again when its listing is older than a day (or never read). */
async function freshListing(
  db: Db,
  deps: AccountSkillServices,
  row: Awaited<ReturnType<typeof platformRow>>,
  force = false,
): Promise<{ row: typeof row; stale: boolean }> {
  if (!force && row.fetchedAt && Date.now() - row.fetchedAt.getTime() < LISTING_TTL_MS)
    return { row, stale: false }
  try {
    const ref: SkillRepoRef = {
      host: row.host as SkillRepoRef['host'],
      repo: row.repo,
      path: '',
      ...(row.ref ? { ref: row.ref } : {}),
    }
    const listing = await deps.sources.marketplace(ref)
    const updated = await db.skillMarketplace.update({
      where: { id: row.id },
      data: {
        name: listing.name.slice(0, 128),
        commit: listing.commit,
        listing: asJson(listing.plugins),
        fetchedAt: new Date(),
      },
    })
    return { row: updated, stale: false }
  } catch (error) {
    if (!isDomainError(error)) throw error
    return { row, stale: true }
  }
}

function marketplaceView(
  row: Awaited<ReturnType<typeof platformRow>>,
  stale: boolean,
): MarketplaceView {
  const listing = listingSchema.safeParse(row.listing)
  const host = row.host as SkillRepoRef['host']
  return {
    id: row.id,
    name: row.name ?? row.repo,
    repo: row.repo,
    host,
    url: skillRepoWebUrl({ host, repo: row.repo, path: '' }),
    platform: row.userId === null,
    plugins: listing.success ? listing.data : [],
    fetchedAt: row.fetchedAt?.toISOString() ?? null,
    stale,
  }
}

/** «Каталог»: the platform's marketplaces and the user's, each read again when a day old. */
export async function readSkillMarketplaces(
  db: Db,
  deps: AccountSkillServices,
  userId: string,
): Promise<MarketplaceView[]> {
  const rows = [
    ...(await Promise.all(platformMarketplaces.map((ref) => platformRow(db, ref)))),
    ...(await db.skillMarketplace.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })),
  ]
  const fresh = await Promise.all(rows.map((row) => freshListing(db, deps, row)))
  return fresh.map(({ row, stale }) => marketplaceView(row, stale))
}

/** «Добавить каталог» (Нв7): read once before it is kept, so a repository without one is refused. */
export async function addSkillMarketplace(
  db: Db,
  deps: AccountSkillServices,
  input: { userId: string; address: string },
): Promise<MarketplaceView> {
  const ref = parseSkillRepoAddress(input.address)
  if (platformMarketplaces.some((own) => own.host === ref.host && own.repo === ref.repo)) {
    const row = await platformRow(db, ref)
    return marketplaceView(row, false)
  }
  const listing = await deps.sources.marketplace({ ...ref, path: '' })
  return db.$transaction(async (tx) => {
    const existing = await tx.skillMarketplace.findFirst({
      where: { userId: input.userId, host: ref.host, repo: ref.repo },
    })
    const data = {
      ref: ref.ref ?? null,
      name: listing.name.slice(0, 128),
      commit: listing.commit,
      listing: asJson(listing.plugins),
      fetchedAt: new Date(),
    }
    if (existing)
      return marketplaceView(
        await tx.skillMarketplace.update({ where: { id: existing.id }, data }),
        false,
      )
    if (
      (await tx.skillMarketplace.count({ where: { userId: input.userId } })) >=
      accountSkillLimits.marketplaces
    )
      throw marketplacesTooMany()
    return marketplaceView(
      await tx.skillMarketplace.create({
        data: { ...data, userId: input.userId, host: ref.host, repo: ref.repo },
      }),
      false,
    )
  })
}

export async function removeSkillMarketplace(
  db: Db,
  input: { userId: string; marketplaceId: string },
): Promise<void> {
  const { count } = await db.skillMarketplace.deleteMany({
    where: { id: input.marketplaceId, userId: input.userId },
  })
  if (count === 0) throw marketplaceNotFound()
}

/** A marketplace the user sees: the platform's or their own. */
async function visibleMarketplace(db: Db, userId: string, marketplaceId: string) {
  const row = await db.skillMarketplace.findFirst({
    where: { id: marketplaceId, OR: [{ userId }, { userId: null }] },
  })
  if (!row) throw marketplaceNotFound()
  return row
}

/**
 * «Установить» of a skill of a marketplace (Нв7): its plugin as the listing has it, the skill at
 * `path` of the plugin's repository at the commit now. A plugin of another repository is
 * searched there first; then the client chooses.
 */
export async function installSkillFromMarketplace(
  db: Db,
  deps: AccountSkillServices,
  input: {
    userId: string
    marketplaceId: string
    plugin: string
    path?: string
    replace?: boolean
  },
): Promise<InstallAnswer> {
  const row = await visibleMarketplace(db, input.userId, input.marketplaceId)
  const listing = listingSchema.safeParse(row.listing)
  const plugin = listing.success ? listing.data.find((p) => p.name === input.plugin) : undefined
  if (!plugin) throw marketplaceNotFound()
  const known = plugin.skills?.map((skill) => skill.path) ?? null
  if (input.path === undefined || (known !== null && !known.includes(input.path))) {
    // A plugin of another repository: its skills are found now.
    const found = await deps.sources.find({ ...plugin.repo, path: plugin.repo.path })
    if (input.path === undefined) {
      if (found.skills.length !== 1) return { status: 'choose', ...found }
      input = { ...input, path: found.skills[0]!.path }
    } else if (!found.skills.some((skill) => skill.path === input.path)) throw skillNotFound()
  }
  const commit = await deps.sources.commit(plugin.repo)
  const version = await deps.sources.read(plugin.repo, commit, input.path!)
  return installOrAsk(db, deps, {
    userId: input.userId,
    version,
    source: 'marketplace',
    sourceRef: {
      kind: 'marketplace',
      marketplaceId: row.id,
      plugin: plugin.name,
      repo: { ...plugin.repo, path: input.path! },
    },
    commit,
    replace: input.replace ?? false,
  })
}

// ---------------------------------------------------------------------------------------------
// Changes of an installed skill
// ---------------------------------------------------------------------------------------------

export async function switchAccountSkill(
  db: Db,
  input: { userId: string; skillId?: string; builtin?: string; enabled: boolean },
): Promise<void> {
  await setAccountSkillEnabled(db, input)
}

export async function restoreAccountSkill(
  db: Db,
  input: { userId: string; skillId: string; versionId: string },
): Promise<void> {
  await restoreAccountSkillVersion(db, input)
}

export async function deleteAccountSkill(
  db: Db,
  deps: Pick<AccountSkillServices, 'storage'>,
  input: { userId: string; skillId: string },
): Promise<void> {
  const versions = await removeAccountSkill(db, input)
  await removeObjects(
    deps.storage(),
    input.userId,
    versions.map((id) => ({ id, files: accountSkillLimits.filesPerSkill })),
  )
}

/**
 * The daily look for a newer commit of the skills of repositories (Нв11): at most five per call,
 * the oldest checks first. A source that does not answer is tried next time.
 */
export async function checkAccountSkillUpdates(
  db: Db,
  deps: AccountSkillServices,
  userId: string,
): Promise<number> {
  const due = await db.accountSkill.findMany({
    where: {
      userId,
      source: { in: ['git', 'marketplace'] },
      OR: [
        { updateCheckedAt: null },
        { updateCheckedAt: { lt: new Date(Date.now() - UPDATE_TTL_MS) } },
      ],
    },
    select: { id: true, sourceRef: true, version: { select: { commit: true } } },
    orderBy: { updateCheckedAt: { sort: 'asc', nulls: 'first' } },
    take: UPDATE_CHECKS,
  })
  let found = 0
  for (const skill of due) {
    const ref = sourceRefOf(skill.sourceRef)
    if (!ref || (ref.kind !== 'git' && ref.kind !== 'marketplace')) continue
    try {
      const commit = await deps.sources.commit(ref.repo)
      const newer = commit !== skill.version?.commit ? commit : null
      if (newer) found += 1
      await db.accountSkill.update({
        where: { id: skill.id },
        data: { updateCommit: newer, updateCheckedAt: new Date() },
      })
    } catch (error) {
      if (!isDomainError(error)) throw error
    }
  }
  return found
}

/**
 * «Обновить» (Нв11): what the newer commit changes — the files added, changed (by size or, for
 * SKILL.md, by text) and removed — and its SKILL.md, shown before the client confirms.
 */
export async function previewAccountSkillUpdate(
  db: Db,
  deps: AccountSkillServices,
  input: { userId: string; skillId: string },
): Promise<{
  commit: string
  skillMd: string
  added: string[]
  changed: string[]
  removed: string[]
}> {
  const { row, commit, version } = await readUpdate(db, deps, input)
  const current = await readAccountSkillText(db, deps, input)
  const before = new Map(row.version!.files.map((file) => [file.path, file.sizeBytes]))
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
  const skillMd = decode(version.files.find((file) => file.path === SKILL_MD)!.bytes)
  const changed = version.files
    .filter((file) =>
      file.path === SKILL_MD
        ? skillMd !== current.skillMd
        : before.has(file.path) && before.get(file.path) !== file.bytes.byteLength,
    )
    .map((file) => file.path)
  return {
    commit,
    skillMd,
    added: version.files.filter((file) => !before.has(file.path)).map((file) => file.path),
    changed,
    removed: [...before.keys()].filter((path) => !version.files.some((file) => file.path === path)),
  }
}

async function readUpdate(
  db: Db,
  deps: AccountSkillServices,
  input: { userId: string; skillId: string },
) {
  const row = await accountSkillOf(db, input)
  const ref = sourceRefOf(row.sourceRef)
  if (!ref || (ref.kind !== 'git' && ref.kind !== 'marketplace') || !row.version)
    throw skillNoUpdate()
  const commit = await deps.sources.commit({ ...ref.repo, path: ref.repo.path })
  if (commit === row.version.commit) throw skillNoUpdate()
  const version = await deps.sources.read(ref.repo, commit, ref.repo.path)
  if (version.frontmatter.name !== row.name) throw skillInvalid('name_folder')
  return { row, ref, commit, version }
}

/** Installs the newer commit as the next version of the skill (Нв11). */
export async function applyAccountSkillUpdate(
  db: Db,
  deps: AccountSkillServices,
  input: { userId: string; skillId: string; commit: string },
): Promise<void> {
  const { ref, commit, version } = await readUpdate(db, deps, input)
  // What the client saw is what is installed: a commit that moved meanwhile asks again.
  if (commit !== input.commit) throw skillNoUpdate()
  await installVersion(db, deps, {
    userId: input.userId,
    version,
    source: ref.kind,
    sourceRef: ref,
    commit,
    replace: true,
  })
}
