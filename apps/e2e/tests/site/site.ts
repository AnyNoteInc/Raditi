import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'
import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { createPrismaClient, insertFeedEvent, type SiteStatus } from '@repo/db'

import { authEnv, databaseUrl } from '../../fixtures/billing-stand.ts'

/**
 * A site of the signed-in user, as «Новый проект» leaves it: not connected yet. `status` makes
 * it a site in another state; only the status is set, nothing of a real connection exists.
 */
export async function addSite(userId: string, status: SiteStatus = 'onboarding'): Promise<string> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const site = await prisma.site.create({
      data: {
        name: 'Кофейня «Крошка»',
        url: `https://kroshka-${userId.slice(0, 8)}.example`,
        stack: 'wordpress',
        status,
        workspace: {
          create: {
            name: 'Мои проекты',
            createdById: userId,
            dataClass: 'synthetic',
            members: { create: { userId, role: 'owner' } },
          },
        },
      },
      select: { id: true },
    })
    return site.id
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * A connected site of the signed-in user in the personal workspace, as the product makes it:
 * the workspace comes with the gift of the registration, so the first dialog of the site is
 * taken on gift credits, and the site has the row of its repository — `activateSite` connects
 * no site without one, and the cabinet offers a dialog with the copy of the site only where it
 * is (`capabilities.repository`, docs/plan/57-browser-tasks.md, Б9). Nothing of a real
 * connection exists: no core works on the dialog, so it waits in the queue. The workspace, its
 * credits, its tasks and the repository row go with the user.
 */
export async function addConnectedSite(userId: string): Promise<string> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const workspace = await prisma.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: authEnv.APP_ENV }),
    )
    const site = await prisma.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Кофейня «Крошка»',
        // An address of its own: a site spends gift credits in one workspace only.
        url: `https://kroshka-${randomUUID()}.example`,
        stack: 'wordpress',
        status: 'active',
      },
      select: { id: true },
    })
    await prisma.gitRepository.create({
      data: {
        siteId: site.id,
        provider: 'gitea',
        owner: 'sites',
        name: `site-${site.id}`,
        url: `https://gitea.raditi.test/sites/site-${site.id}`,
      },
    })
    return site.id
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * A task in the browser on a connected site of the signed-in user (docs/plan/57-browser-tasks.md),
 * as a first pass leaves it when the agent asks the client to sign in: waiting for the client,
 * its browser open and asking for a login, the request and the question in its feed. No worker
 * and no core run here: the window of the task is drawn from these rows alone. Everything goes
 * with the user (its workspace, tasks and their sessions).
 */
export async function addBrowserTask(
  userId: string,
): Promise<{ siteId: string; taskId: string; title: string }> {
  const siteId = await addConnectedSite(userId)
  const title = 'Новость о летней веранде'
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const site = await prisma.site.findUniqueOrThrow({
      where: { id: siteId },
      select: { workspaceId: true },
    })
    const task = await prisma.task.create({
      data: {
        workspaceId: site.workspaceId,
        siteId,
        createdById: userId,
        status: 'awaiting_user',
        title,
        turnNo: 1,
        needsRepository: false,
        needsBrowser: true,
      },
      select: { id: true },
    })
    await prisma.browserSession.create({
      data: {
        taskId: task.id,
        siteId,
        workspaceId: site.workspaceId,
        status: 'ready',
        // The reason and the words of the agent's request come together (browser_sessions_help_check).
        helpReason: 'login',
        helpMessage: 'Войдите, пожалуйста, в админку сайта: без входа я не могу добавить новость.',
        expiresAt: new Date(Date.now() + 4 * 3_600_000),
        readyAt: new Date(),
      },
    })
    const requestId = randomUUID()
    await insertFeedEvent(prisma, {
      taskId: task.id,
      row: {
        type: 'feed.request',
        payload: {
          v: 1,
          kind: 'first',
          authorId: userId,
          requestId,
          text: 'Добавьте новость: с 1 июня открываем летнюю веранду.',
        },
      },
    })
    await insertFeedEvent(prisma, {
      taskId: task.id,
      row: { type: 'feed.question', payload: { v: 1, kind: 'browser', turn: 1, reason: 'login' } },
    })
    return { siteId, taskId: task.id, title }
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * Takes the indicator of `next dev` off every page the test opens. It stands in the bottom
 * right corner (next.config.ts), over «Ещё» of the bottom bar, and takes the click meant for
 * it; a production build has no indicator.
 */
export async function hideDevIndicator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const style = document.createElement('style')
    style.textContent = 'nextjs-portal { display: none }'
    const add = () => document.head.append(style)
    if (document.head) add()
    else document.addEventListener('DOMContentLoaded', add)
  })
}

/**
 * The statuses in which a site keeps «Обзор» alone open, each with its name on «Обзор» and the
 * phrase that says why the other sections are closed.
 */
export const closedSites = [
  ['paused', 'На паузе', 'Пока работа приостановлена, остальные разделы сайта недоступны.'],
  [
    'disconnected',
    'Нет подключения',
    'Пока связи с сайтом нет, остальные разделы сайта недоступны.',
  ],
  ['archived', 'В архиве', 'Пока сайт в архиве, остальные разделы сайта недоступны.'],
] as const

/** The phrase the closed items of the navigation are described by: it is in the markup, unseen. */
export const CLOSED_NOTE_ID = 'site-closed-sections'

/** What follows the label of a closed item for a screen reader: in its text, unseen. */
export const CLOSED_SUFFIX = ', раздел недоступен'

/**
 * A site of another person, whom the signed-in user shares no workspace with. `remove` takes
 * that person and the site away again: the fixture of the run knows nothing about them.
 */
export async function addForeignSite(): Promise<{ siteId: string; remove: () => Promise<void> }> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const stranger = await prisma.user.create({
      data: {
        name: 'Чужой владелец',
        email: `stranger-${crypto.randomUUID()}@site-page.example.ru`,
      },
      select: { id: true },
    })
    const siteId = await addSite(stranger.id)
    return {
      siteId,
      remove: async () => {
        const db = createPrismaClient({ databaseUrl: databaseUrl() })
        try {
          const owned = { createdById: stranger.id }
          await db.site.deleteMany({ where: { workspace: owned } })
          await db.workspace.deleteMany({ where: owned })
          await db.user.delete({ where: { id: stranger.id } })
        } finally {
          await db.$disconnect()
        }
      },
    }
  } finally {
    await prisma.$disconnect()
  }
}
