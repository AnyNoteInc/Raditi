import {
  getCreditsOverview,
  getPlanOverview,
  getPromisedCreditsOverview,
  isSignupGiftGranted,
} from '@repo/billing'
import { findPersonalWorkspace, Prisma, type PrismaClient } from '@repo/db'
import {
  effortOfModelClass,
  taskStatusLabel,
  type AppEnv,
  type ChatInfo,
  type ChatStatusInfo,
  type ChatUsageInfo,
  type TaskStatus,
} from '@repo/domain'

import { accessibleTask, taskNotFound } from './access.ts'

// The facts of `/usage`, `/status` and `/context` (owner's request of 15.11.2026), read once for the
// cabinet (`task.info`) and for the bot of Telegram. Only reads: nothing is made, the gift of a
// user without a workspace is read as promised, as the settings pages read it.

/** The word of a status that waits for the client, whether the agent asked or answered. */
const WAITS_FOR_CLIENT = 'Агент ждёт вашего сообщения'

const statusWord = (status: TaskStatus): string =>
  status === 'awaiting_user' ? WAITS_FOR_CLIENT : taskStatusLabel[status]

/**
 * «GLM-5.3 · standard» → «GLM-5.3»: the class of the profile is told as the level of thinking. A
 * name the operator wrote without that ending is shown as it is.
 */
const modelWord = (name: string, modelClass: string): string => {
  const ending = ` · ${modelClass}`
  return name.endsWith(ending) ? name.slice(0, -ending.length).trim() : name
}

async function usageOf(
  db: PrismaClient,
  input: { userId: string; workspaceId: string | null; taskId: string | null; now: Date },
): Promise<ChatUsageInfo> {
  const { workspaceId } = input
  const [credits, plan, charged] = await Promise.all([
    workspaceId === null
      ? getPromisedCreditsOverview(db, {
          giftGranted: await isSignupGiftGranted(db, input.userId),
          now: input.now,
        })
      : getCreditsOverview(db, { workspaceId, now: input.now }),
    getPlanOverview(db, workspaceId),
    input.taskId === null
      ? null
      : db.creditLedger.aggregate({
          where: {
            taskId: input.taskId,
            unit: { in: ['credit_tariff', 'credit_gift', 'credit_pack'] },
            kind: { in: ['charge', 'refund'] },
          },
          _sum: { amount: true },
        }),
  ])
  const week = credits.windows.find((window) => window.kind === 'week' && window.limit !== null)
  return {
    plan: plan.subscription?.plan.name ?? null,
    total: credits.totalAvailable,
    tariff: credits.tariff.available,
    gift: credits.gift.available,
    pack: credits.pack.available,
    week:
      week === undefined || week.limit === null || week.left === null
        ? null
        : { limit: week.limit, used: week.used, left: week.left, resetsAt: week.resetsAt },
    // A charge is written below zero, its refund above.
    chat:
      charged === null
        ? null
        : Math.max(
            0,
            (charged._sum.amount ?? new Prisma.Decimal(0))
              .neg()
              .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
              .toNumber(),
          ),
  }
}

/** What `/usage`, `/status` and `/context` tell; taskId null — a new chat. */
export async function readChatInfo(
  db: PrismaClient,
  input: { userId: string; taskId: string | null; appEnv: AppEnv; now: Date },
): Promise<ChatInfo> {
  const task =
    input.taskId === null
      ? null
      : await db.task.findFirst({
          where: accessibleTask(input.userId, input.taskId),
          select: {
            id: true,
            workspaceId: true,
            status: true,
            title: true,
            modelClass: true,
            site: { select: { name: true } },
          },
        })
  if (input.taskId !== null && task === null) throw taskNotFound()
  const workspaceId =
    task?.workspaceId ??
    (await findPersonalWorkspace(db, { userId: input.userId, appEnv: input.appEnv }))?.id ??
    null
  const usage = await usageOf(db, {
    userId: input.userId,
    workspaceId,
    taskId: task?.id ?? null,
    now: input.now,
  })
  if (task === null) return { usage, status: null, context: null }

  const [turn, queued, browsers, call] = await Promise.all([
    db.taskTurn.findFirst({
      where: { taskId: task.id, modelId: { not: null } },
      orderBy: { turnNo: 'desc' },
      select: { model: { select: { name: true, modelClass: true } } },
    }),
    db.taskQueuedMessage.count({ where: { taskId: task.id } }),
    db.browserSession.count({ where: { taskId: task.id, closedAt: null } }),
    db.tokenUsage.findFirst({
      where: { taskId: task.id },
      orderBy: { occurredAt: 'desc' },
      select: {
        inputUncachedTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        outputTokens: true,
        model: { select: { contextTokens: true } },
      },
    }),
  ])
  const status: ChatStatusInfo = {
    title: task.title,
    status: statusWord(task.status),
    project: task.site?.name ?? null,
    model: turn?.model ? modelWord(turn.model.name, turn.model.modelClass) : null,
    effort: effortOfModelClass(
      task.modelClass === null || task.modelClass === 'service' ? 'standard' : task.modelClass,
    ),
    queued,
    browser: browsers > 0,
  }
  return {
    usage,
    status,
    context: {
      // The last request with its answer is what the next one starts from.
      used:
        call === null
          ? null
          : call.inputUncachedTokens +
            call.cacheReadTokens +
            call.cacheWriteTokens +
            call.outputTokens,
      window: call?.model.contextTokens ?? null,
    },
  }
}
