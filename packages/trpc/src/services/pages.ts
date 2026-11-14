import {
  currentDocMarkdown,
  hashPagePassword,
  listWorkspacePages,
  pagePasswordProblem,
  publishClientPage,
  readChatDocument,
  restorePage,
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
  pageAddressUrl,
  pageContentRefused,
  pageLimits,
  pageNotFound,
  type ObjectStorage,
  type PagesAddress,
} from '@repo/domain'

import { accessibleTask, isManagerRole, memberRole, taskNotFound } from './chat/access.ts'
import { readChatFile } from './chat/files.ts'

// The section «Страницы» of the cabinet and the card of a page in the chat (docs/plan/69-pages.md,
// Ст13–Ст15, Ст30): the pages of every workspace the user is a member of; a member reads them, the
// owner and an administrator set the password, take a page down and put it back. A page of another
// workspace answers the same NOT_FOUND as one that is not there (Ст20).

export interface CabinetPage {
  pageId: string
  workspaceId: string
  title: string
  url: string
  kind: 'html' | 'markdown' | 'doc'
  state: 'pending' | 'live' | 'taken_down'
  version: number
  hasPassword: boolean
  /** null — the page was taken down by the client; `operator` — by the support. */
  takenDownBy: 'client' | 'operator' | null
  chat: { id: string; title: string | null } | null
  canManage: boolean
  updatedAt: string
}

/** The pages of the user's workspaces, newest first. */
export async function listCabinetPages(
  db: PrismaClient,
  address: PagesAddress,
  userId: string,
): Promise<CabinetPage[]> {
  const members = await db.member.findMany({
    where: { userId },
    select: { workspaceId: true, role: true },
  })
  const out: CabinetPage[] = []
  for (const member of members) {
    const pages = await listWorkspacePages(db, member.workspaceId)
    const chats = await db.task.findMany({
      where: {
        id: { in: pages.flatMap((page) => (page.taskId ? [page.taskId] : [])) },
        deletedAt: null,
        // A chat the user may open (accessibleTask): not of a deleted project either.
        OR: [{ siteId: null }, { site: { deletedAt: null } }],
      },
      select: { id: true, title: true },
    })
    const chatOf = new Map(chats.map((chat) => [chat.id, chat]))
    for (const page of pages)
      out.push({
        pageId: page.id,
        workspaceId: member.workspaceId,
        title: page.title,
        url: pageAddressUrl(page.slug, address),
        kind: page.kind as CabinetPage['kind'],
        state: page.state as CabinetPage['state'],
        version: page.currentVersion,
        hasPassword: page.hasPassword,
        takenDownBy: page.takenDownBy as CabinetPage['takenDownBy'],
        chat: page.taskId ? (chatOf.get(page.taskId) ?? null) : null,
        canManage: isManagerRole(member.role),
        updatedAt: page.updatedAt.toISOString(),
      })
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
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
  return { pageId: page.pageId, url: pageAddressUrl(page.slug, address), version: page.version }
}

/** The name of a file without its extension, as the title of its page in the cabinet. */
function titleOfFile(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '').trim() || name
  return [...stem].slice(0, pageLimits.titleChars).join('')
}

/**
 * «Опубликовать как страницу» of a document of the chat (Ст32): a `.html` as the agent made it, a
 * `.md` drawn into a page for reading, after the very check of a page of a turn. The file passed
 * the scan of its turn's outbox for the keys of the turn and the values of the client (Ст6), so
 * no second scan of values here. The same file of the same chat again is a new version of the
 * same page; a new version of the file in the tab changes no page by itself.
 */
export async function publishChatFilePage(
  db: PrismaClient,
  storage: Pick<ObjectStorage, 'get'>,
  address: PagesAddress,
  input: { taskId: string; fileId: string; userId: string },
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
  const page = await publishClientPage(db, {
    workspaceId: task.workspaceId,
    taskId: task.id,
    title: titleOfFile(file.name),
    target: { fileName: file.name },
    bytes: served,
  })
  return { pageId: page.pageId, url: pageAddressUrl(page.slug, address), version: page.version }
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
