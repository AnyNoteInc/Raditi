import { createHash, randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'
import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { placeReserve, settleTaskCharge } from '@repo/billing/testing'
import {
  createPrismaClient,
  insertFeedEvent,
  markAttachmentReady,
  markProjectFileReady,
  type Prisma,
} from '@repo/db'
import type { AgentTodoItem } from '@repo/domain/tasks/agent-todo'

import { authEnv, databaseUrl } from '../../fixtures/billing-stand.ts'

/**
 * A task in the browser on a connected site of the signed-in user (docs/plan/57-browser-tasks.md),
 * as a first pass leaves it when the agent asks the client to sign in: waiting for the client,
 * its browser open and asking for a login, the request and the question in its feed. No worker
 * and no core run here: the window of the task is drawn from these rows alone. Everything goes
 * with the user (its workspace, tasks and their sessions).
 */
export async function addBrowserTask(userId: string): Promise<{ taskId: string; title: string }> {
  const title = 'Новость о летней веранде'
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const site = await prisma.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: authEnv.APP_ENV }),
    )
    const task = await prisma.task.create({
      data: {
        id: chatId(),
        workspaceId: site.id,
        createdById: userId,
        status: 'awaiting_user',
        title,
        turnNo: 1,
        needsBrowser: true,
      },
      select: { id: true },
    })
    await prisma.browserSession.create({
      data: {
        taskId: task.id,
        workspaceId: site.id,
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
    return { taskId: task.id, title }
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
): Promise<{ taskId: string; title: string }> {
  const title = 'Правки на странице «Меню»'
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const workspace = await prisma.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: authEnv.APP_ENV }),
    )
    const task = await prisma.task.create({
      data: {
        id: chatId(),
        workspaceId: workspace.id,
        createdById: userId,
        status: 'awaiting_user',
        title,
        turnNo: pairs,
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
        createdById: userId,
        status: 'awaiting_user',
        title,
        turnNo: pairs,
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
/**
 * A project of the signed-in user (docs/plan/84-projects.md, ПР1), written as `project.create`
 * writes it: in the personal workspace, by its author. It goes with the user.
 */
export async function addProject(
  userId: string,
  {
    name,
    goal = null,
    starred = false,
    archived = false,
  }: { name: string; goal?: string | null; starred?: boolean; archived?: boolean },
): Promise<{ projectId: string }> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const workspace = await prisma.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: authEnv.APP_ENV }),
    )
    const now = new Date()
    const project = await prisma.project.create({
      data: {
        id: chatId(),
        workspaceId: workspace.id,
        createdById: userId,
        name,
        goal,
        starredAt: starred ? now : null,
        archivedAt: archived ? now : null,
      },
      select: { id: true },
    })
    return { projectId: project.id }
  } finally {
    await prisma.$disconnect()
  }
}

function chatId(): string {
  const time = Date.now().toString(16).padStart(12, '0')
  return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`
}

type Db = ReturnType<typeof createPrismaClient>

/**
 * The agent's plan of its work (docs/plan/89-agent-todos.md, ТД2): the items of a `todo_list`
 * event, as the driver reads them from `todowrite`. The page shows the last list of the last turn.
 */
export type PlanItems = readonly AgentTodoItem[]

const planEvent = (plan: PlanItems) => ({
  type: 'todo_list',
  items: plan.map(({ text, status }) => ({ text, status })),
})

/**
 * A chat without a project and the client's first words in it, in the status a test wants it
 * in; `after` — when the feed wrote the words, which the first turn answers.
 */
async function addChatWith(
  prisma: Db,
  userId: string,
  {
    words,
    status,
    projectId = null,
    title = words,
  }: {
    words: string
    status: 'awaiting_user' | 'running' | 'cancelled'
    projectId?: string | null
    title?: string
  },
): Promise<{ taskId: string; after: Date }> {
  const workspace = await prisma.$transaction((tx) =>
    ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: authEnv.APP_ENV }),
  )
  const task = await prisma.task.create({
    data: {
      id: chatId(),
      workspaceId: workspace.id,
      createdById: userId,
      status,
      title,
      turnNo: 1,
      needsBrowser: false,
      projectId,
    },
    select: { id: true },
  })
  const after = await addRequest(prisma, {
    taskId: task.id,
    authorId: userId,
    words,
    answers: null,
  })
  return { taskId: task.id, after }
}

/**
 * The client's words in the feed and when it wrote them; `answers` — the row that left the chat
 * open for them, null for the first words.
 */
async function addRequest(
  prisma: Db,
  {
    taskId,
    authorId,
    words,
    answers,
  }: { taskId: string; authorId: string; words: string; answers: bigint | null },
): Promise<Date> {
  const base = { v: 1, authorId, requestId: randomUUID(), text: words } as const
  const request = await insertFeedEvent(prisma, {
    taskId,
    row: {
      type: 'feed.request',
      payload:
        answers === null
          ? { ...base, kind: 'first' }
          : { ...base, kind: 'answer', answersEventId: String(answers) },
    },
  })
  const { createdAt } = await prisma.taskEvent.findUniqueOrThrow({
    where: { id: request },
    select: { createdAt: true },
  })
  return createdAt
}

/**
 * One turn of a chat as core leaves it: its row in `status`, one batch of the agent's output in
 * its journal (`events`, as they stand after the mask) and the stage «work» in the feed. A turn at
 * work has not finished.
 */
async function addTurn(
  prisma: Db,
  {
    taskId,
    turnNo,
    status,
    after,
    events,
  }: {
    taskId: string
    turnNo: number
    status: 'running' | 'completed' | 'cancelled'
    /** The turn answers words written then: it started after them, by the clock that wrote them. */
    after: Date
    events: Prisma.InputJsonValue[]
  },
): Promise<void> {
  const startedAt = new Date(after.getTime() + 1)
  const turn = await prisma.taskTurn.create({
    data: {
      taskId,
      turnNo,
      status,
      driverId: 'opencode',
      image: `raditi/sbx@sha256:${'a'.repeat(64)}`,
      startedAt,
      finishedAt: status === 'running' ? null : startedAt,
    },
    select: { id: true },
  })
  await prisma.taskEvent.create({
    data: { taskId, turnId: turn.id, type: 'turn.output', payload: { turn: turnNo, events } },
  })
  await insertFeedEvent(prisma, {
    taskId,
    row: { type: 'feed.step', payload: { v: 1, turn: turnNo, attempt: 1, step: 'work' } },
  })
}

/** The answer of the turn `turn` that leaves the chat open for the client's next words. */
const answerRow = (turn: number, answer: string) =>
  ({
    type: 'feed.result',
    payload: {
      v: 1,
      turn,
      message: answer,
      site: 'none',
      next: 'awaiting_user',
      filesChanged: 0,
      changeType: 'none',
      needsApproval: false,
      risk: 'low',
    },
  }) as const

/**
 * A chat without a project as a finished turn leaves it, for what the page does with that turn
 * (docs/plan/61-chats-first.md, §5.14): the client's words, the stages of the turn and what the
 * model thought in its journal, the answer, and the chat open. No core runs here: `/undo` of this
 * chat is `task.undoTurn` in web, and `/thinking` reads the journal. `plan` — the last list of the
 * agent's plan in that turn (docs/plan/89-agent-todos.md). Everything goes with the user.
 */
export async function addAnsweredChat(
  userId: string,
  {
    words,
    answer,
    thought,
    projectId = null,
    title = words,
    plan,
    charged = false,
  }: {
    words: string
    answer: string
    thought: string
    projectId?: string | null
    /** The name of the chat, when its words are longer than a name may be. */
    title?: string
    plan?: PlanItems
    /** Set up the settled reserve when the browser will queue another paid pass. */
    charged?: boolean
  },
): Promise<{ taskId: string }> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const { taskId, after } = await addChatWith(prisma, userId, {
      words,
      status: 'awaiting_user',
      projectId,
      title,
    })
    await addTurn(prisma, {
      taskId,
      turnNo: 1,
      status: 'completed',
      after,
      events: [{ type: 'reasoning', text: thought }, ...(plan ? [planEvent(plan)] : [])],
    })
    await insertFeedEvent(prisma, { taskId, row: answerRow(1, answer) })
    if (charged) {
      const { workspaceId } = await prisma.task.update({
        where: { id: taskId },
        data: { modelClass: 'standard' },
        select: { workspaceId: true },
      })
      const now = new Date()
      await placeReserve(prisma, {
        taskId,
        workspaceId,
        attempt: 1,
        now,
        expiresAt: new Date(now.getTime() + 60_000),
      })
      await prisma.$transaction((tx) => settleTaskCharge(tx, { taskId, credits: 5, now }))
    }
    return { taskId }
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * Files the agent left for the client in its turn (`feed.file`, docs/plan/66-chat-visuals.md, В8):
 * rows only — the bytes are never read by what a test of «Результаты» looks at.
 */
export async function addChatFiles(
  taskId: string,
  files: readonly { name: string; sizeBytes: number }[],
): Promise<void> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    for (const file of files)
      await insertFeedEvent(prisma, {
        taskId,
        row: {
          type: 'feed.file',
          payload: { v: 1, name: file.name, fileId: randomUUID(), sizeBytes: file.sizeBytes },
        },
      })
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * The client writes again in an answered chat, and the agent answers with no plan this time
 * (docs/plan/89-agent-todos.md, ТД5): the next turn, completed, with no list in its journal, and
 * the chat open again.
 */
export async function answerAgain(
  taskId: string,
  { words, answer }: { words: string; answer: string },
): Promise<void> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const task = await prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { createdById: true, turnNo: true },
    })
    if (task.createdById === null) throw new Error('A chat of these tests has its author')
    const open = await prisma.taskEvent.findFirstOrThrow({
      where: { taskId, type: 'feed.result' },
      orderBy: { id: 'desc' },
      select: { id: true },
    })
    const turnNo = task.turnNo + 1
    const after = await addRequest(prisma, {
      taskId,
      authorId: task.createdById,
      words,
      answers: open.id,
    })
    await addTurn(prisma, {
      taskId,
      turnNo,
      status: 'completed',
      after,
      events: [{ type: 'message', text: answer }],
    })
    await insertFeedEvent(prisma, { taskId, row: answerRow(turnNo, answer) })
    await prisma.task.update({ where: { id: taskId }, data: { turnNo } })
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * A chat without a project whose first turn is at work on a plan (docs/plan/89-agent-todos.md,
 * §6): the client's words, the stage «work», the agent's list in the journal of the turn and the
 * chat `running`. No core runs here: the turn ends only by `endWorkingTurn`, and the page reads
 * the plan every 5 s while it works — this run has no stream of signals (no Redis).
 */
export async function addWorkingChat(
  userId: string,
  { words, plan }: { words: string; plan: PlanItems },
): Promise<{ taskId: string }> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const { taskId, after } = await addChatWith(prisma, userId, { words, status: 'running' })
    await addTurn(prisma, {
      taskId,
      turnNo: 1,
      status: 'running',
      after,
      events: [planEvent(plan)],
    })
    return { taskId }
  } finally {
    await prisma.$disconnect()
  }
}

/** The turn at work rewrites its plan: one more batch of its output, as `todowrite` leaves it. */
export async function writePlan(taskId: string, plan: PlanItems): Promise<void> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const task = await prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { turnNo: true },
    })
    const turn = await prisma.taskTurn.findUniqueOrThrow({
      where: { taskId_turnNo: { taskId, turnNo: task.turnNo } },
      select: { id: true },
    })
    await prisma.taskEvent.create({
      data: {
        taskId,
        turnId: turn.id,
        type: 'turn.output',
        payload: { turn: task.turnNo, events: [planEvent(plan)] },
      },
    })
  } finally {
    await prisma.$disconnect()
  }
}

/** The turn at work ends with an answer and leaves the chat open, in one transaction as core does. */
export async function endWorkingTurn(taskId: string, answer: string): Promise<void> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    await prisma.$transaction(async (tx) => {
      const { turnNo } = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { turnNo: true },
      })
      await tx.taskTurn.update({
        where: { taskId_turnNo: { taskId, turnNo } },
        data: { status: 'completed', finishedAt: new Date() },
      })
      await insertFeedEvent(tx, { taskId, row: answerRow(turnNo, answer) })
      await tx.task.update({ where: { id: taskId }, data: { status: 'awaiting_user' } })
    })
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * A chat the client stopped while its first turn worked on a plan: «Остановить» runs `/cancel`
 * (spec §7), so the turn and the chat are `cancelled`, and the feed says who stopped it.
 */
export async function addStoppedChat(
  userId: string,
  { words, plan }: { words: string; plan: PlanItems },
): Promise<{ taskId: string }> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const { taskId, after } = await addChatWith(prisma, userId, { words, status: 'cancelled' })
    await addTurn(prisma, {
      taskId,
      turnNo: 1,
      status: 'cancelled',
      after,
      events: [planEvent(plan)],
    })
    await insertFeedEvent(prisma, {
      taskId,
      row: {
        type: 'feed.cancelled',
        payload: {
          v: 1,
          turn: 1,
          by: 'customer',
          authorId: userId,
          site: 'none',
          credits: 'returned',
        },
      },
    })
    return { taskId }
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
 * Takes the place of the store of files for the context of a project (docs/plan/84-projects.md,
 * 84.10; this run has no S3): the bytes of a file chosen on `page` are answered as stored and its
 * row is marked ready, as `PUT /api/project-files/<id>` does. The announcement
 * (`projectFile.start`), the binding (`project.create({ fileIds })`, `projectFile.bind`) and the
 * lists are the server's own.
 */
export async function acceptProjectUploads(page: Page): Promise<void> {
  await page.route('**/api/project-files/*', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    const id = new URL(route.request().url()).pathname.split('/').at(-1) ?? ''
    const bytes = route.request().postDataBuffer() ?? Buffer.alloc(0)
    const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
    try {
      const { sizeBytes } = await prisma.projectFile.findUniqueOrThrow({
        where: { id },
        select: { sizeBytes: true },
      })
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      await markProjectFileReady(prisma, { id, sizeBytes, sha256 })
      await route.fulfill({ status: 200, json: { fileId: id, size: sizeBytes } })
    } finally {
      await prisma.$disconnect()
    }
  })
}

/** One answer of a tRPC batch of one call, as superjson sends it. */
const trpcAnswer = (data: unknown) => [{ result: { data: { json: data } } }]

/**
 * The two procedures of the context that touch the store themselves — `projectFile.addText` puts
 * the `.md` there, `projectFile.remove` deletes the object before its row — cannot run without S3.
 * Here they do what they do to the database, by the same rules: a text is a ready `.md` of the
 * workspace (taken by the project when it names one, else for a day), a removal deletes the row
 * of a file of the user. Their checks live in packages/trpc (project-file-db.test.ts).
 */
export async function standInProjectFileStore(page: Page, userId: string): Promise<void> {
  await page.route('**/api/trpc/projectFile.addText*', async (route) => {
    const body = route.request().postDataJSON() as Record<
      string,
      { json: { title: string; text: string; projectId?: string } }
    >
    const input = body['0']!.json
    const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
    try {
      const workspace = await prisma.workspace.findFirstOrThrow({
        where: { createdById: userId },
        select: { id: true },
      })
      const id = randomUUID().toLowerCase()
      const bytes = Buffer.from(input.text, 'utf8')
      const name = `${input.title}.md`
      await prisma.projectFile.create({
        data: {
          id,
          workspaceId: workspace.id,
          projectId: input.projectId ?? null,
          uploadedById: userId,
          kind: 'text',
          name,
          mediaType: 'text/markdown',
          sizeBytes: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          status: 'ready',
          s3Key: `projects/${workspace.id}/${id}`,
          expiresAt: input.projectId ? null : new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      })
      await route.fulfill({ status: 200, json: trpcAnswer({ fileId: id, name }) })
    } finally {
      await prisma.$disconnect()
    }
  })
  await page.route('**/api/trpc/projectFile.remove*', async (route) => {
    const body = route.request().postDataJSON() as Record<string, { json: { fileId: string } }>
    const fileId = body['0']!.json.fileId
    const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
    try {
      await prisma.projectFile.deleteMany({ where: { id: fileId, uploadedById: userId } })
      await route.fulfill({ status: 200, json: trpcAnswer({ fileId }) })
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
      vision: false,
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

/**
 * Entries of the memory of a project of the user — or, `projectId: null`, of the account — as the
 * end of a pass or the client leaves them (docs/plan/84-projects.md, ПР18); `feed` also writes the
 * row «Запомнено» or «Агент предлагает запомнить» of its chat, as core does after the answer.
 */
export async function addMemoryEntries(
  userId: string,
  projectId: string | null,
  entries: readonly {
    text: string
    status?: 'active' | 'proposed'
    author?: 'agent' | 'client'
    pendingAction?: 'update' | 'forget'
    pendingText?: string
    sourceTaskId?: string
    feed?: 'saved' | 'proposed'
  }[],
): Promise<{ ids: string[] }> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const workspace = await prisma.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: authEnv.APP_ENV }),
    )
    const ids: string[] = []
    for (const entry of entries) {
      const author = entry.author ?? 'agent'
      const row = await prisma.memoryEntry.create({
        data: {
          id: chatId(),
          workspaceId: workspace.id,
          userId,
          projectId,
          kind: 'preference',
          text: entry.text,
          status: entry.status ?? 'active',
          author,
          confirmedAt: author === 'client' ? new Date() : null,
          sourceTaskId: entry.sourceTaskId ?? null,
          sourceTurn: entry.sourceTaskId ? 1 : null,
          ...(entry.pendingAction ? { pendingAction: entry.pendingAction } : {}),
          ...(entry.pendingText ? { pendingText: entry.pendingText } : {}),
        },
        select: { id: true },
      })
      ids.push(row.id)
      if (entry.feed && entry.sourceTaskId)
        await insertFeedEvent(prisma, {
          taskId: entry.sourceTaskId,
          row: {
            type: 'feed.memory_change',
            payload: {
              v: 1,
              action: entry.feed,
              entryId: row.id,
              kind: 'preference',
              text: entry.text,
            },
          },
        })
    }
    return { ids }
  } finally {
    await prisma.$disconnect()
  }
}

/** The memory of the user now, newest first: what the windows and the chat changed. */
export async function memoryRows(userId: string) {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    return await prisma.memoryEntry.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, text: true, status: true, projectId: true, pendingAction: true },
    })
  } finally {
    await prisma.$disconnect()
  }
}

/** «Агент запоминает важное» of the user, as the agent's access and its section read it. */
export async function agentMemoryOf(userId: string): Promise<boolean> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl() })
  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { agentMemory: true },
    })
    return user.agentMemory
  } finally {
    await prisma.$disconnect()
  }
}
