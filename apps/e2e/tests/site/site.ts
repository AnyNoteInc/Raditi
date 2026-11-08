import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'
import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { createPrismaClient, insertFeedEvent, markAttachmentReady, type SiteStatus } from '@repo/db'

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
 * A site the wizard imported and nothing connected yet: `onboarding`, its first import succeeded,
 * the first version `v0.0.0` saved and confirmed. No file of it exists anywhere.
 */
export async function addImportedSite(userId: string): Promise<string> {
  const siteId = await addSite(userId)
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const repository = await prisma.gitRepository.create({
      data: {
        siteId,
        provider: 'gitea',
        owner: 'sites',
        name: `site-${siteId}`,
        url: `https://gitea.raditi.test/sites/site-${siteId}`,
      },
      select: { id: true },
    })
    await prisma.siteInitialVersion.create({
      data: {
        siteId,
        gitRepositoryId: repository.id,
        commitSha: 'c'.repeat(40),
        tag: 'v0.0.0',
        files: 10,
        bytes: 2048,
        leaseEpoch: 1,
        importedAt: new Date(),
      },
    })
    await prisma.siteProvisioningStage.create({
      data: { siteId, stage: 'code_import', status: 'succeeded', finishedAt: new Date() },
    })
    return siteId
  } finally {
    await prisma.$disconnect()
  }
}

/** `count` sites of the user, each with a name and an address of its own. */
export async function addSites(userId: string, count: number): Promise<void> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    await prisma.workspace.create({
      data: {
        name: 'Мои проекты',
        createdById: userId,
        dataClass: 'synthetic',
        members: { create: { userId, role: 'owner' } },
        sites: {
          create: Array.from({ length: count }, () => {
            const mark = randomUUID().slice(0, 8)
            return {
              name: `Сайт ${mark}`,
              url: `https://site-${mark}.example`,
              stack: 'wordpress' as const,
              status: 'onboarding' as const,
            }
          }),
        },
      },
    })
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
 * A chat with the code as `/init` leaves it (docs/plan/61-chats-first.md, К31): the command, the
 * answer of the agent, and the chat open for the next words. The project has `notes` for the agent.
 * No core runs here. Everything goes with the user.
 */
export async function addInitAnswer(
  userId: string,
  { answer, notes }: { answer: string; notes: string },
): Promise<{ siteId: string; taskId: string }> {
  const siteId = await addConnectedSite(userId)
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const site = await prisma.site.update({
      where: { id: siteId },
      data: { agentNotes: notes },
      select: { workspaceId: true },
    })
    const task = await prisma.task.create({
      data: {
        workspaceId: site.workspaceId,
        siteId,
        createdById: userId,
        status: 'awaiting_user',
        title: 'Подсказки агенту',
        turnNo: 1,
        needsRepository: true,
        needsBrowser: false,
      },
      select: { id: true },
    })
    const person = { v: 1 as const, authorId: userId }
    for (const row of [
      {
        type: 'feed.request',
        payload: { ...person, kind: 'first', requestId: randomUUID(), text: 'Здравствуйте!' },
      },
      {
        type: 'feed.request',
        payload: { ...person, kind: 'agent_command', command: 'init', requestId: randomUUID() },
      },
      {
        type: 'feed.result',
        payload: {
          v: 1,
          turn: 1,
          message: answer,
          site: 'unchanged',
          next: 'awaiting_user',
          filesChanged: 0,
          changeType: 'none',
          needsApproval: false,
          risk: 'low',
        },
      },
    ] as const)
      await insertFeedEvent(prisma, { taskId: task.id, row })
    return { siteId, taskId: task.id }
  } finally {
    await prisma.$disconnect()
  }
}

/** The notes of a project as the next turn reads them. */
export async function agentNotesOf(siteId: string): Promise<string | null> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const site = await prisma.site.findUniqueOrThrow({
      where: { id: siteId },
      select: { agentNotes: true },
    })
    return site.agentNotes
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * A long dialog with the repository on a connected site of the signed-in user (docs/plan/59-
 * dialog-tools-panel.md, И19): `pairs` messages of the client, each answered by the agent, the last answer
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
        needsRepository: true,
        needsBrowser: false,
      },
      select: { id: true },
    })
    await addLongFeed(prisma, {
      taskId: task.id,
      userId,
      pairs,
      address: site.url,
      site: 'unchanged',
    })
    return { siteId, taskId: task.id, title }
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * The changes a pass left in a chat, as core records them: one changed file and one passed check,
 * no records. A chat has the tools of its changes only with something in them (docs/plan/61-chats-
 * first.md, К19). No core runs here, and no file behind the list is read.
 */
export async function addChanges(taskId: string): Promise<void> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    await prisma.taskCandidate.create({
      data: {
        taskId,
        revision: 1,
        turnNo: 1,
        baseSha: 'a'.repeat(40),
        baseTree: 'b'.repeat(40),
        headSha: 'c'.repeat(40),
        files: [
          {
            path: CHANGED_FILE,
            change: 'modified',
            sizeBytes: 1024,
            executable: false,
          },
        ],
        dbPlanSha256: 'd'.repeat(64),
        proposedBump: 'patch',
        proposedVersion: 'v1.0.1',
        facts: {
          changeType: 'code',
          risk: 'low',
          addedFiles: 0,
          modifiedFiles: 1,
          deletedFiles: 0,
          mediaFiles: 0,
          dbObjects: 0,
          newFunctionality: false,
        },
        checks: {
          create: { revision: 1, kind: 'php_lint', status: 'passed', finishedAt: new Date() },
        },
      },
    })
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * A chat of a project as it stands when the project closes (docs/plan/61-chats-first.md, К39): its
 * site paused, and the chat waiting for the client with what it had asked. `candidate` — it holds
 * the changes of `addChanges` and a card of them in its feed; `ceiling` — the question of the
 * platform about credits.
 */
export async function closeProject(
  siteId: string,
  taskId: string,
  { candidate = false, ceiling = false }: { candidate?: boolean; ceiling?: boolean } = {},
): Promise<void> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    await prisma.site.update({ where: { id: siteId }, data: { status: 'paused' } })
    if (candidate) {
      await prisma.task.update({ where: { id: taskId }, data: { status: 'awaiting_approval' } })
      await insertFeedEvent(prisma, {
        taskId,
        row: {
          type: 'feed.candidate',
          payload: {
            v: 1,
            turn: 1,
            revision: 1,
            version: 'v1.0.1',
            bump: 'patch',
            files: { added: 0, modified: 1, deleted: 0 },
            media: 0,
            records: 0,
          },
        },
      })
    }
    if (ceiling)
      await insertFeedEvent(prisma, {
        taskId,
        row: {
          type: 'feed.question',
          payload: { v: 1, kind: 'ceiling', turn: 1, reason: 'step', spent: 45, held: 45, left: 0 },
        },
      })
  } finally {
    await prisma.$disconnect()
  }
}

/** What a chat needs, as the server decided it when it was created. */
export async function requirementsOf(
  taskId: string,
): Promise<{ needsRepository: boolean; needsBrowser: boolean }> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    return await prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { needsRepository: true, needsBrowser: true },
    })
  } finally {
    await prisma.$disconnect()
  }
}

/** The one file of `addChanges`, as the tab «Файлы» lists it. */
export const CHANGED_FILE = 'wp-content/themes/kroshka/style.css'

/**
 * The same long chat without a project (docs/plan/61-chats-first.md, §5.11): nothing but the
 * words, on a personal workspace, the way `task.create` writes one when the run has no browser.
 */
export async function addLongChat(
  userId: string,
  pairs = 15,
): Promise<{ taskId: string; title: string }> {
  const title = 'Идеи для названия пекарни'
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const workspace = await prisma.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: authEnv.APP_ENV }),
    )
    const task = await prisma.task.create({
      data: {
        id: chatId(),
        workspaceId: workspace.id,
        siteId: null,
        createdById: userId,
        status: 'awaiting_user',
        title,
        turnNo: pairs,
        needsRepository: false,
        needsBrowser: false,
      },
      select: { id: true },
    })
    await addLongFeed(prisma, {
      taskId: task.id,
      userId,
      pairs,
      address: 'https://kroshka.example',
      site: 'none',
    })
    return { taskId: task.id, title }
  } finally {
    await prisma.$disconnect()
  }
}

/** The lease of a chat without a project takes its id, of version 7 only (`tasks_chat_id_check`). */
function chatId(): string {
  const time = Date.now().toString(16).padStart(12, '0')
  return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`
}

/**
 * A chat without a project as a finished turn leaves it, for what the page does with that turn
 * (docs/plan/61-chats-first.md, §5.14): the client's words, the stages of the turn and what the
 * model thought in its journal, the answer, and the chat open. No core runs here: `/undo` of this
 * chat is `task.undoTurn` in web, and `/thinking` reads the journal. Everything goes with the user.
 */
export async function addAnsweredChat(
  userId: string,
  { words, answer, thought }: { words: string; answer: string; thought: string },
): Promise<{ taskId: string }> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const workspace = await prisma.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: authEnv.APP_ENV }),
    )
    const task = await prisma.task.create({
      data: {
        id: chatId(),
        workspaceId: workspace.id,
        siteId: null,
        createdById: userId,
        status: 'awaiting_user',
        title: words,
        turnNo: 1,
        needsRepository: false,
        needsBrowser: false,
      },
      select: { id: true },
    })
    const request = await insertFeedEvent(prisma, {
      taskId: task.id,
      row: {
        type: 'feed.request',
        payload: { v: 1, kind: 'first', authorId: userId, requestId: randomUUID(), text: words },
      },
    })
    // The turn answers these words: it started after them, by the clock that wrote them.
    const { createdAt } = await prisma.taskEvent.findUniqueOrThrow({
      where: { id: request },
      select: { createdAt: true },
    })
    const startedAt = new Date(createdAt.getTime() + 1)
    const turn = await prisma.taskTurn.create({
      data: {
        taskId: task.id,
        turnNo: 1,
        status: 'completed',
        driverId: 'opencode',
        image: `raditi/sbx@sha256:${'a'.repeat(64)}`,
        startedAt,
        finishedAt: startedAt,
      },
      select: { id: true },
    })
    await prisma.taskEvent.create({
      data: {
        taskId: task.id,
        turnId: turn.id,
        type: 'turn.output',
        payload: { turn: 1, events: [{ type: 'reasoning', text: thought }] },
      },
    })
    await insertFeedEvent(prisma, {
      taskId: task.id,
      row: { type: 'feed.step', payload: { v: 1, turn: 1, attempt: 1, step: 'work' } },
    })
    await insertFeedEvent(prisma, {
      taskId: task.id,
      row: {
        type: 'feed.result',
        payload: {
          v: 1,
          turn: 1,
          message: answer,
          site: 'none',
          next: 'awaiting_user',
          filesChanged: 0,
          changeType: 'none',
          needsApproval: false,
          risk: 'low',
        },
      },
    })
    return { taskId: task.id }
  } finally {
    await prisma.$disconnect()
  }
}

/** `pairs` messages of the client, each answered by the agent; each answer leaves the chat open. */
async function addLongFeed(
  prisma: ReturnType<typeof createPrismaClient>,
  {
    taskId,
    userId,
    pairs,
    address,
    site,
  }: {
    taskId: string
    userId: string
    pairs: number
    address: string
    site: 'unchanged' | 'none'
  },
): Promise<void> {
  // Each answer leaves the dialog open; the next words answer it (`answersEventId`).
  let answer: bigint | null = null
  for (let turn = 1; turn <= pairs; turn += 1) {
    const text = `${turn}. Поменяйте, пожалуйста, на странице «Меню» описание напитка номер ${turn}: добавьте объём и уберите слово «авторский».`
    const base = { v: 1, authorId: userId, requestId: randomUUID(), text } as const
    await insertFeedEvent(prisma, {
      taskId,
      row: {
        type: 'feed.request',
        payload:
          answer === null
            ? { ...base, kind: 'first' }
            : { ...base, kind: 'answer', answersEventId: String(answer) },
      },
    })
    answer = await insertFeedEvent(prisma, {
      taskId,
      row: {
        type: 'feed.result',
        payload: {
          v: 1,
          turn,
          message: `Ответ ${turn}. Посмотрел [страницу «Меню»](${address}/menu/): напиток номер ${turn} описан в блоке «Кофе». Чтобы поменять описание, нужна правка в копии сайта — напишите, если начинать, и я подготовлю изменения для предпросмотра.`,
          site,
          next: 'awaiting_user',
          filesChanged: null,
          changeType: 'none',
          needsApproval: false,
          risk: 'low',
        },
      },
    })
  }
}

/**
 * Takes the place of the store of files (this run has no S3): the bytes of a file chosen on `page`
 * are answered as stored, and its row of the database says so, as `PUT /api/attachments/<id>` does.
 */
export async function acceptUploads(page: Page): Promise<void> {
  await page.route('**/api/attachments/*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1) ?? ''
    const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
    try {
      const { sizeBytes, contentType } = await prisma.attachment.findUniqueOrThrow({
        where: { id },
        select: { sizeBytes: true, contentType: true },
      })
      await markAttachmentReady(prisma, { id, sizeBytes, contentType })
      await route.fulfill({ status: 200, json: { attachmentId: id, size: sizeBytes } })
    } finally {
      await prisma.$disconnect()
    }
  })
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
