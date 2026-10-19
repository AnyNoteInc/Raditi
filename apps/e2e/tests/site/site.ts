import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'
import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { createPrismaClient, type SiteStatus } from '@repo/db'

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
 * taken on gift credits. Nothing of a real connection exists: no core works on the dialog, so
 * it waits in the queue. The workspace, its credits and its tasks go with the user.
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
    return site.id
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
