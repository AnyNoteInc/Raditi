import {
  currentDocMarkdown,
  deletePage,
  deleteTreeFile,
  hashPagePassword,
  listTreeFiles,
  pagePasswordProblem,
  publishClientPage,
  purgeDeletedPage,
  readChatDocument,
  restorePage,
  returnDeletedPage,
  setTreeName,
  updatePage,
  setPagePassword,
  takeDownPage,
  type PrismaClient,
} from '@repo/db'
import { markdownTitleOf, readingPage } from '@repo/doc-render'
import {
  checkPageContent,
  docNotFound,
  documentKindOf,
  DomainError,
  isDomainError,
  liveSubscriptionStatuses,
  type ObjectStorage,
  pageAddressUrl,
  pageContentRefused,
  pageLimits,
  pageNotFound,
  type PagesAddress,
} from '@repo/domain'

import { accessibleTask, isManagerRole, memberRole, taskNotFound } from './chat/access.ts'
import { readChatFile } from './chat/files.ts'

// The section «Страницы» of the cabinet and the card of a page in the chat (docs/plan/69-pages.md,
// Ст13–Ст15, Ст30; docs/plan/73-pages-sites.md, Дер1–Дер8): the pages of every workspace the user
// is a member of; a member reads them, the owner and an administrator set the password, take a
// page down and put it back, delete it to the trash, return it and purge it. A page of another
// workspace answers the same NOT_FOUND as one that is not there (Ст20).

export interface CabinetPage {
  pageId: string
  workspaceId: string
  /** Its site (docs/plan/73-pages-sites.md, Дер11): the host it answers on. */
  treeId: string
  /** null — the home page of its site; the site answers for it. */
  parentId: string | null
  /** `/` — the home page. */
  path: string
  /** Its order among the pages of its parent. */
  position: number
  title: string
  url: string
  kind: 'html' | 'markdown' | 'doc'
  state: 'pending' | 'live' | 'taken_down'
  version: number
  hasPassword: boolean
  /**
   * null — the page was taken down by the client; `operator` — by the support. At a home page —
   * its site's: the host is taken down, every path answers 410 (Дер18).
   */
  takenDownBy: 'client' | 'operator' | null
  /**
   * In the trash (docs/plan/73-pages-sites.md, Дер2): since when, and when it is purged; null —
   * not deleted. A page belongs to its workspace, not to a chat (Дер8): the list names no chat.
   */
  trash: { deletedAt: string; purgeAfter: string } | null
  /** The file it was last published from: a hint in «Опубликовать как страницу» (Дер9), not a key. */
  sourceFileName: string | null
  canManage: boolean
  updatedAt: string
  /** The own name of its site (Дер32); null — its slug alone. */
  name: string | null
  /** Whether the tariff of its workspace gives sites their own names (В3). */
  namesAllowed: boolean
}

/** The pages of the user's workspaces, newest first: three queries whatever the workspaces. */
export async function listCabinetPages(
  db: PrismaClient,
  address: PagesAddress,
  userId: string,
): Promise<CabinetPage[]> {
  const members = await db.member.findMany({
    where: { userId },
    select: { workspaceId: true, role: true },
  })
  if (members.length === 0) return []
  const roleOf = new Map(members.map((member) => [member.workspaceId, member.role]))
  const pages = await db.page.findMany({
    where: { workspaceId: { in: [...roleOf.keys()] } },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      workspaceId: true,
      treeId: true,
      parentId: true,
      path: true,
      position: true,
      title: true,
      kind: true,
      state: true,
      currentVersion: true,
      takenDownBy: true,
      deletedAt: true,
      purgeAfter: true,
      sourceFileName: true,
      documentId: true,
      updatedAt: true,
      tree: { select: { slug: true, name: true, passwordHash: true, takenDownBy: true } },
    },
  })
  // The tariffs of the workspaces: whether they give names (docs/plan/73-pages-sites.md, Дер32).
  const live = await db.subscription.findMany({
    where: {
      workspaceId: { in: [...roleOf.keys()] },
      status: { in: [...liveSubscriptionStatuses] },
    },
    select: { workspaceId: true, plan: { select: { pageCustomNames: true } } },
  })
  const names = new Map(live.map((each) => [each.workspaceId, each.plan.pageCustomNames]))
  return pages.map((page) => {
    // A home page answers for its site: the take-down of the host is its (Дер18).
    const hostDown = page.parentId === null ? page.tree.takenDownBy : null
    return {
      pageId: page.id,
      workspaceId: page.workspaceId,
      treeId: page.treeId,
      parentId: page.parentId,
      path: page.path,
      position: page.position,
      title: page.title,
      url: pageAddressUrl(page.tree.name ?? page.tree.slug, address, page.path),
      name: page.tree.name,
      namesAllowed: names.get(page.workspaceId) ?? false,
      kind: page.kind as CabinetPage['kind'],
      state: (hostDown !== null ? 'taken_down' : page.state) as CabinetPage['state'],
      version: page.currentVersion,
      hasPassword: page.tree.passwordHash !== null,
      takenDownBy: (hostDown ?? page.takenDownBy) as CabinetPage['takenDownBy'],
      trash:
        page.deletedAt && page.purgeAfter
          ? { deletedAt: page.deletedAt.toISOString(), purgeAfter: page.purgeAfter.toISOString() }
          : null,
      sourceFileName: page.documentId === null ? page.sourceFileName : null,
      canManage: isManagerRole(roleOf.get(page.workspaceId) ?? null),
      updatedAt: page.updatedAt.toISOString(),
    }
  })
}

/** The workspace of a page the user may manage; NOT_FOUND for a stranger, FORBIDDEN for a member. */
async function managedWorkspace(db: PrismaClient, pageId: string, userId: string): Promise<string> {
  const page = await db.page.findUnique({ where: { id: pageId }, select: { workspaceId: true } })
  if (!page) throw pageNotFound()
  const role = await memberRole(db, page.workspaceId, userId)
  if (role === null) throw pageNotFound()
  if (!isManagerRole(role))
    throw new DomainError('FORBIDDEN', 'Only the owner or an administrator manages a page', 403)
  return page.workspaceId
}

export async function setCabinetPagePassword(
  db: PrismaClient,
  input: { pageId: string; password: string | null; userId: string },
): Promise<void> {
  const workspaceId = await managedWorkspace(db, input.pageId, input.userId)
  if (input.password !== null && pagePasswordProblem(input.password) !== null)
    throw new DomainError('BAD_REQUEST', 'The password is out of its bounds', 400)
  const passwordHash = input.password === null ? null : await hashPagePassword(input.password)
  await setPagePassword(db, { workspaceId, pageId: input.pageId, passwordHash })
}

export async function takeDownCabinetPage(
  db: PrismaClient,
  input: { pageId: string; userId: string },
): Promise<void> {
  const workspaceId = await managedWorkspace(db, input.pageId, input.userId)
  await takeDownPage(db, { pageId: input.pageId, by: 'client', workspaceId })
}

export async function restoreCabinetPage(
  db: PrismaClient,
  input: { pageId: string; userId: string },
): Promise<void> {
  const workspaceId = await managedWorkspace(db, input.pageId, input.userId)
  await restorePage(db, { pageId: input.pageId, workspaceId })
}

/** «Удалить» (docs/plan/73-pages-sites.md, Дер1–Дер4): to the trash for `trashDays`. */
export async function deleteCabinetPage(
  db: PrismaClient,
  input: { pageId: string; userId: string },
): Promise<{ purgeAfter: string }> {
  const workspaceId = await managedWorkspace(db, input.pageId, input.userId)
  const { purgeAfter } = await deletePage(db, {
    pageId: input.pageId,
    workspaceId,
    by: 'client',
    actor: { type: 'user', userId: input.userId },
  })
  return { purgeAfter: purgeAfter.toISOString() }
}

/**
 * «Переименовать», «Изменить адрес», «Переместить», «Выше» / «Ниже» (docs/plan/73-pages-sites.md,
 * Дер30): at once; the former addresses of the branch keep leading to its pages (Дер19).
 */
export async function updateCabinetPage(
  db: PrismaClient,
  input: {
    pageId: string
    userId: string
    title?: string
    segment?: string
    parentId?: string
    position?: number
  },
): Promise<{ path: string }> {
  const workspaceId = await managedWorkspace(db, input.pageId, input.userId)
  const { userId: _, ...change } = input
  return updatePage(db, { ...change, workspaceId })
}

/** «Адрес сайта…» (Дер32): the own name of the site of a page, on a tariff that gives names. */
export async function nameCabinetSite(
  db: PrismaClient,
  input: { pageId: string; userId: string; name: string },
): Promise<{ name: string }> {
  const workspaceId = await managedWorkspace(db, input.pageId, input.userId)
  return setTreeName(db, { pageId: input.pageId, workspaceId, name: input.name })
}

/** The workspace and site of a page of a member: NOT_FOUND for a stranger (Ст20). */
async function readableSite(db: PrismaClient, pageId: string, userId: string) {
  const page = await db.page.findUnique({
    where: { id: pageId },
    select: { workspaceId: true, treeId: true },
  })
  if (!page) throw pageNotFound()
  if ((await memberRole(db, page.workspaceId, userId)) === null) throw pageNotFound()
  return page
}

/** «Файлы сайта» (docs/plan/73-pages-sites.md, Дер34): the shared files of the site of a page. */
export async function cabinetSiteFiles(
  db: PrismaClient,
  input: { pageId: string; userId: string },
): Promise<{ path: string; type: string; sizeBytes: number; updatedAt: string }[]> {
  const site = await readableSite(db, input.pageId, input.userId)
  return (await listTreeFiles(db, site)).map((file) => ({
    ...file,
    updatedAt: file.updatedAt.toISOString(),
  }))
}

/** «Удалить файл»: at once, by the owner or an administrator. */
export async function deleteCabinetSiteFile(
  db: PrismaClient,
  input: { pageId: string; userId: string; path: string },
): Promise<void> {
  const workspaceId = await managedWorkspace(db, input.pageId, input.userId)
  const site = await readableSite(db, input.pageId, input.userId)
  await deleteTreeFile(db, { workspaceId, treeId: site.treeId, path: input.path })
}

/** «Вернуть» from the trash: the same address and version, as before. */
export async function returnCabinetPage(
  db: PrismaClient,
  input: { pageId: string; userId: string },
): Promise<void> {
  const workspaceId = await managedWorkspace(db, input.pageId, input.userId)
  await returnDeletedPage(db, {
    pageId: input.pageId,
    workspaceId,
    actor: { type: 'user', userId: input.userId },
  })
}

/** «Удалить навсегда»: a page in the trash, at once. */
export async function purgeCabinetPage(
  db: PrismaClient,
  input: { pageId: string; userId: string },
): Promise<void> {
  const workspaceId = await managedWorkspace(db, input.pageId, input.userId)
  await purgeDeletedPage(db, {
    pageId: input.pageId,
    workspaceId,
    actor: { type: 'user', userId: input.userId },
  })
}

/** A document of a workspace the user is a member of, in one query; NOT_FOUND otherwise (Ст20). */
async function readableDocument(db: PrismaClient, documentId: string, userId: string) {
  const document = await db.chatDocument.findFirst({
    where: { id: documentId, workspace: { members: { some: { userId } } } },
    select: { workspaceId: true, title: true },
  })
  if (!document) throw docNotFound()
  return document
}

export interface CabinetDocument {
  docId: string
  title: string
  version: number
  revision: number
  /** Written and checked of all: «Разделы: N из M». */
  progress: { written: number; total: number }
  sections: {
    key: string
    intent: string
    /** `pending` — a placeholder; `unchecked` — written, shown once the turn ends; `shown`. */
    state: 'pending' | 'unchecked' | 'shown'
    heading: string | null
    markdown: string | null
  }[]
  /** The page it is published as, if it is. */
  page: { pageId: string; state: string; version: number } | null
  /** The owner or an administrator: may publish it (Ст25). */
  canManage: boolean
}

/**
 * The live card and the full view of a document (Ст19, Ст22): the client gets the heading and the
 * text of a section only once core checked it.
 */
export async function cabinetDocument(
  db: PrismaClient,
  input: { documentId: string; userId: string },
): Promise<CabinetDocument> {
  const { workspaceId } = await readableDocument(db, input.documentId, input.userId)
  const read = await readChatDocument(db, {
    workspaceId,
    documentId: input.documentId,
    reader: 'client',
  })
  const sections = read.sections.map((section) => ({
    key: section.key,
    intent: section.intent,
    state:
      section.state === 'pending'
        ? ('pending' as const)
        : section.checked
          ? ('shown' as const)
          : ('unchecked' as const),
    heading: section.heading,
    markdown: section.markdown,
  }))
  return {
    docId: read.id,
    title: read.title,
    version: read.version,
    revision: read.revision,
    progress: {
      written: sections.filter((section) => section.state === 'shown').length,
      total: sections.length,
    },
    sections,
    page: read.page
      ? { pageId: read.page.id, state: read.page.state, version: read.page.currentVersion }
      : null,
    canManage: isManagerRole(await memberRole(db, workspaceId, input.userId)),
  }
}

/** «Скачать .md» (Ст12): the Markdown of the current version, named by the title; null — none yet. */
export async function cabinetDocMarkdown(
  db: PrismaClient,
  input: { documentId: string; userId: string },
): Promise<{ name: string; markdown: string; version: number } | null> {
  // Not there, another workspace's, or gone between the two reads: one answer, 404. Any other
  // failure goes up: the route says 503 and logs it.
  const notFound = (error: unknown) => {
    if (isDomainError(error) && error.code === 'DOC_NOT_FOUND') return null
    throw error
  }
  const document = await readableDocument(db, input.documentId, input.userId).catch(notFound)
  if (!document) return null
  const current = await currentDocMarkdown(db, {
    workspaceId: document.workspaceId,
    documentId: input.documentId,
  }).catch(notFound)
  if (!current) return null
  const base =
    document.title
      .replace(/[/:*?"<>|\\\p{Cc}\p{Cf}]+/gu, ' ')
      .replace(/^[.\s]+/u, '')
      .trim()
      .slice(0, 120) || 'Документ'
  return { name: `${base}.md`, markdown: current.markdown, version: current.version }
}

// ———————————————————————————————— the client's own publications (Ст25, Ст32)

export interface ClientPublication {
  pageId: string
  url: string
  version: number
}

const managerOnly = () =>
  new DomainError('FORBIDDEN', 'Only the owner or an administrator publishes a page', 403)

const encode = (text: string) => new TextEncoder().encode(text)

/** What a viewer gets is checked as such: a page drawn of checked text too. */
function checked(bytes: Uint8Array): Uint8Array {
  const verdict = checkPageContent(bytes)
  if (!verdict.ok) throw pageContentRefused(verdict.reason)
  return bytes
}

/**
 * «Опубликовать по ссылке» of a document (Ст25): its current version — checked section by section
 * at the end of the turns that wrote it — drawn into its page for reading, a new version of the
 * page every time. A document with no version yet is not published.
 */
export async function publishDocumentPage(
  db: PrismaClient,
  address: PagesAddress,
  input: { documentId: string; userId: string },
): Promise<ClientPublication> {
  const document = await db.chatDocument.findFirst({
    where: {
      id: input.documentId,
      workspace: { members: { some: { userId: input.userId } } },
      // A document of a removed chat, or of a chat of a removed project, is not published.
      OR: [
        { taskId: null },
        { task: { deletedAt: null, OR: [{ siteId: null }, { site: { deletedAt: null } }] } },
      ],
    },
    select: { workspaceId: true, taskId: true, title: true },
  })
  if (!document) throw docNotFound()
  if (!isManagerRole(await memberRole(db, document.workspaceId, input.userId))) throw managerOnly()
  const current = await currentDocMarkdown(db, {
    workspaceId: document.workspaceId,
    documentId: input.documentId,
  })
  if (current === null)
    throw new DomainError('DOC_NOT_READY', 'The document has no version yet', 409)
  const page = await publishClientPage(db, {
    workspaceId: document.workspaceId,
    taskId: document.taskId,
    title: document.title,
    target: { documentId: input.documentId },
    bytes: checked(
      encode(await readingPage({ title: document.title, markdown: current.markdown })),
    ),
  })
  return {
    pageId: page.pageId,
    url: pageAddressUrl(page.slug, address, page.path),
    version: page.version,
  }
}

/** The name of a file without its extension, as the title of its page in the cabinet. */
function titleOfFile(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '').trim() || name
  return [...stem].slice(0, pageLimits.titleChars).join('')
}

/** Where a file of a chat goes (docs/plan/73-pages-sites.md, Дер9): a new page, or a version of one. */
export type FilePublicationTarget =
  { new: { title?: string } } | { pageId: string; expectedVersion: number }

/**
 * «Опубликовать как страницу» of a document of the chat (Ст32): a `.html` as the agent made it, a
 * `.md` drawn into a page for reading, after the very check of a page of a turn. The file passed
 * the scan of its turn's outbox for the keys of the turn and the values of the client (Ст6), so
 * no second scan of values here. The client says where it goes — a new page, or the next version
 * of a page of the workspace, whatever chat made that one (docs/plan/73-pages-sites.md, Дер9);
 * the chat is only where the file lies.
 */
export async function publishChatFilePage(
  db: PrismaClient,
  storage: Pick<ObjectStorage, 'get'>,
  address: PagesAddress,
  input: { taskId: string; fileId: string; userId: string; target: FilePublicationTarget },
): Promise<ClientPublication> {
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId.toLowerCase()),
    select: { id: true, workspaceId: true },
  })
  if (task === null) throw taskNotFound()
  if (!isManagerRole(await memberRole(db, task.workspaceId, input.userId))) throw managerOnly()
  const file = await readChatFile(db, storage, { taskId: task.id, fileId: input.fileId })
  if (file === null) throw taskNotFound()
  const kind = documentKindOf(file.name)
  if (kind === null)
    throw new DomainError('PAGE_NOT_PUBLISHABLE', 'Only a .html or .md document is a page', 400)
  const bytes = checked(new Uint8Array(file.bytes))
  let served = bytes
  if (kind === 'markdown') {
    const markdown = new TextDecoder().decode(bytes)
    // The heading is the file's own, which its turn's scan read (as core draws a `.md`, Ст11).
    served = checked(
      encode(await readingPage({ title: markdownTitleOf(markdown) ?? 'Документ', markdown })),
    )
  }
  const { target } = input
  const page = await publishClientPage(db, {
    workspaceId: task.workspaceId,
    taskId: task.id,
    title: ('new' in target ? target.new.title?.trim() : undefined) || titleOfFile(file.name),
    target: { fileName: file.name },
    ...('pageId' in target
      ? { into: { pageId: target.pageId, expectedVersion: target.expectedVersion } }
      : {}),
    bytes: served,
  })
  return {
    pageId: page.pageId,
    url: pageAddressUrl(page.slug, address, page.path),
    version: page.version,
  }
}

/** A page a file of this chat may become the next version of (docs/plan/73-pages-sites.md, Дер9). */
export interface PublishTargetPage {
  pageId: string
  title: string
  version: number
  sourceFileName: string | null
}

/**
 * The pages of the workspace of this chat a file may go into, newest first: pages of files, out
 * of the trash, taken down by no one, the user its owner or an administrator. Others' workspaces
 * are not offered — the server would refuse them; nor are pages that would be refused here.
 */
export async function publishTargetsOfChat(
  db: PrismaClient,
  input: { taskId: string; userId: string },
): Promise<PublishTargetPage[]> {
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId.toLowerCase()),
    select: { workspaceId: true },
  })
  if (task === null) throw taskNotFound()
  if (!isManagerRole(await memberRole(db, task.workspaceId, input.userId))) return []
  const pages = await db.page.findMany({
    where: {
      workspaceId: task.workspaceId,
      documentId: null,
      deletedAt: null,
      state: 'live',
      // A site taken down takes its pages with it (Дер18): none of them would take a version.
      tree: { takenDownBy: null },
    },
    orderBy: { updatedAt: 'desc' },
    take: 200,
    select: { id: true, title: true, currentVersion: true, sourceFileName: true },
  })
  return pages.map((page) => ({
    pageId: page.id,
    title: page.title,
    version: page.currentVersion,
    sourceFileName: page.sourceFileName,
  }))
}

/** Whether the user may publish the documents of this chat as pages: its owner or an administrator. */
export async function canPublishOfChat(
  db: PrismaClient,
  input: { taskId: string; userId: string },
): Promise<boolean> {
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId.toLowerCase()),
    select: { workspaceId: true },
  })
  return task !== null && isManagerRole(await memberRole(db, task.workspaceId, input.userId))
}
