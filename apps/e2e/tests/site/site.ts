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
        // «Чат» is the dialog in the browser, as `task.create` writes it.
        mode: 'chat',
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
 * A long dialog of «Работа» on a connected site of the signed-in user (docs/plan/59-dialog-tools-
 * panel.md, И19): `pairs` messages of the client, each answered by the agent, the last answer
 * leaving the dialog open — `awaiting_user`, so the field takes words. Nothing changed on the site:
 * no candidate, no preview, no core. The feed is long enough to scroll on any screen, and every
 * answer links to the page it speaks of: the keyboard has stops all along the feed. Everything goes
 * with the user, as the task in the browser does.
 */
export async function addLongDialog(
  userId: string,
  pairs = 15,
): Promise<{ siteId: string; taskId: string; title: string }> {
  const siteId = await addConnectedSite(userId)
  const title = 'Правки на странице «Меню»'
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const site = await prisma.site.findUniqueOrThrow({
      where: { id: siteId },
      select: { workspaceId: true, url: true },
    })
    const task = await prisma.task.create({
      data: {
        workspaceId: site.workspaceId,
        siteId,
        createdById: userId,
        status: 'awaiting_user',
        title,
        turnNo: pairs,
        // «Работа» is the dialog with the copy of the site, as `task.create` writes it.
        mode: 'work',
        needsRepository: true,
        needsBrowser: false,
      },
      select: { id: true },
    })
    // Each answer leaves the dialog open; the next words answer it (`answersEventId`).
    let answer: bigint | null = null
    for (let turn = 1; turn <= pairs; turn += 1) {
      const text = `${turn}. Поменяйте, пожалуйста, на странице «Меню» описание напитка номер ${turn}: добавьте объём и уберите слово «авторский».`
      const base = { v: 1, authorId: userId, requestId: randomUUID(), text } as const
      await insertFeedEvent(prisma, {
        taskId: task.id,
        row: {
          type: 'feed.request',
          payload:
            answer === null
              ? { ...base, kind: 'first' }
              : { ...base, kind: 'answer', answersEventId: String(answer) },
        },
      })
      answer = await insertFeedEvent(prisma, {
        taskId: task.id,
        row: {
          type: 'feed.result',
          payload: {
            v: 1,
            turn,
            message: `Ответ ${turn}. Посмотрел [страницу «Меню»](${site.url}/menu/): напиток номер ${turn} описан в блоке «Кофе». Чтобы поменять описание, нужна правка в копии сайта — напишите, если начинать, и я подготовлю изменения для предпросмотра.`,
            site: 'unchanged',
            next: 'awaiting_user',
            filesChanged: null,
            changeType: 'none',
            needsApproval: false,
            risk: 'low',
          },
        },
      })
    }
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

/**
 * The class a dialog starts in priced for the time of a run: `task.create` takes a dialog only in
 * a class whose profile has a price (26.10.2026), and no price is ever seeded — an operator
 * approves them. The seeded model of `standard` (the reasoning «Высокое», what a dialog starts
 * with) and its provider are switched on and priced from before the credit rate of the run, which
 * so stays in force. The returned `restore` puts the switches back and removes the price.
 */
export async function priceDialogClass(): Promise<() => Promise<void>> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  const model = await prisma.llmModel.findFirst({
    where: {
      modelClass: 'standard',
      providerModelId: { not: null },
      // The seeded providers are the backends of Z.ai, both of the kind the planner takes.
      provider: { kind: 'subscription' },
    },
    orderBy: [{ provider: { slug: 'asc' } }, { slug: 'asc' }],
    select: { id: true, enabled: true, provider: { select: { id: true, enabled: true } } },
  })
  if (model === null) throw new Error('The seeds have no model of the class standard')
  const price = await prisma.llmModelPrice.create({
    data: {
      modelId: model.id,
      effectiveFrom: new Date('2025-12-31T00:00:00.000Z'),
      inputPer1m: '100',
      outputPer1m: '1000',
      vatRate: '0.2200',
      sourceUrl: 'https://rates.invalid/browser-run-of-the-site-page',
    },
    select: { id: true },
  })
  if (!model.enabled)
    await prisma.llmModel.update({ where: { id: model.id }, data: { enabled: true } })
  if (!model.provider.enabled)
    await prisma.llmProvider.update({ where: { id: model.provider.id }, data: { enabled: true } })
  return async () => {
    await prisma.llmModelPrice.delete({ where: { id: price.id } })
    if (!model.enabled)
      await prisma.llmModel.update({ where: { id: model.id }, data: { enabled: false } })
    if (!model.provider.enabled)
      await prisma.llmProvider.update({
        where: { id: model.provider.id },
        data: { enabled: false },
      })
    await prisma.$disconnect()
  }
}
