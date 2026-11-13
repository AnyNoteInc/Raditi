import {
  hashPagePassword,
  listWorkspacePages,
  pagePasswordProblem,
  restorePage,
  setPagePassword,
  takeDownPage,
  type PrismaClient,
} from '@repo/db'
import { DomainError, pageAddressUrl, pageNotFound, type PagesAddress } from '@repo/domain'

import { isManagerRole, memberRole } from './chat/access.ts'

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
