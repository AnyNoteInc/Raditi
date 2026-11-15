import { Prisma, type PrismaClient } from '@repo/db'
import { DomainError } from '@repo/domain'
import { TELEGRAM_LIMITS, generateLinkCode, hashLinkCode } from '@repo/telegram'

// The link of a Telegram account to an account of the cabinet (docs/plan/80-telegram.md, Т3): only
// from the cabinet, by a one-time code in `t.me/<bot>?start=<code>`, 15 minutes, its sha256 kept.
// One Telegram account per user and one user per Telegram account; `/stop` and the cabinet unlink.

/** At most this many codes a user can make in an hour: a code is cheap, a flood is not. */
export const LINK_CODES_PER_HOUR = 10

export const telegramOff = () =>
  new DomainError('TELEGRAM_OFF', 'The bot of the chat is not configured here', 409)
const tooManyCodes = () =>
  new DomainError('TELEGRAM_LINK_TOO_MANY', 'Too many link codes in an hour', 429)

export interface TelegramStatus {
  /** The bot is configured here: the cabinet offers to link it. */
  available: boolean
  linked: { username: string | null; since: Date } | null
  /** Notifications of the chats of the cabinet go to Telegram too (Т8). */
  notifications: boolean
}

export async function telegramStatus(
  db: PrismaClient,
  input: { userId: string; available: boolean },
): Promise<TelegramStatus> {
  const [identity, settings] = await Promise.all([
    db.channelIdentity.findUnique({
      where: { userId_channel: { userId: input.userId, channel: 'telegram' } },
      select: { username: true, createdAt: true },
    }),
    db.notificationSetting.findUnique({
      where: { userId: input.userId },
      select: { telegram: true },
    }),
  ])
  return {
    available: input.available,
    linked: identity && { username: identity.username, since: identity.createdAt },
    notifications: settings?.telegram ?? true,
  }
}

/** A new code for the link; the earlier unused codes of the user stop working. */
export async function startTelegramLink(
  db: PrismaClient,
  input: { userId: string; botUsername: string | null; now: Date },
): Promise<{ url: string; expiresAt: Date }> {
  if (input.botUsername === null) throw telegramOff()
  const code = generateLinkCode()
  const expiresAt = new Date(input.now.getTime() + TELEGRAM_LIMITS.linkCodeTtlMs)
  await db.$transaction(async (tx) => {
    const made = await tx.telegramLinkCode.count({
      where: { userId: input.userId, createdAt: { gt: new Date(input.now.getTime() - 3_600_000) } },
    })
    if (made >= LINK_CODES_PER_HOUR) throw tooManyCodes()
    await tx.telegramLinkCode.updateMany({
      where: { userId: input.userId, usedAt: null },
      data: { usedAt: input.now },
    })
    await tx.telegramLinkCode.create({
      data: { userId: input.userId, codeHash: hashLinkCode(code), expiresAt },
    })
  })
  return { url: `https://t.me/${input.botUsername}?start=${code}`, expiresAt }
}

export type LinkAnswer =
  { linked: true; userId: string; again: boolean } | { linked: false; reason: 'code' | 'taken' }

/**
 * `/start <code>`: the code is taken once, within its time. `taken` — this Telegram account is
 * linked to another user of the cabinet. Linking the same pair again is `again`.
 */
export async function takeTelegramLink(
  db: PrismaClient,
  input: { code: string; externalId: string; username: string | null; now: Date },
): Promise<LinkAnswer> {
  if (!/^[A-Z2-9]{8}$/u.test(input.code)) return { linked: false, reason: 'code' }
  try {
    return await db.$transaction(async (tx) => {
      const taken = await tx.telegramLinkCode.updateManyAndReturn({
        where: { codeHash: hashLinkCode(input.code), usedAt: null, expiresAt: { gt: input.now } },
        data: { usedAt: input.now },
        select: { userId: true },
      })
      const userId = taken[0]?.userId
      if (userId === undefined) return { linked: false, reason: 'code' } as const
      const holder = await tx.channelIdentity.findUnique({
        where: { channel_externalId: { channel: 'telegram', externalId: input.externalId } },
        select: { userId: true },
      })
      if (holder && holder.userId !== userId) return { linked: false, reason: 'taken' } as const
      if (holder) {
        await tx.channelIdentity.update({
          where: { channel_externalId: { channel: 'telegram', externalId: input.externalId } },
          data: { username: input.username },
        })
        return { linked: true, userId, again: true } as const
      }
      // Another Telegram account of the same user is replaced by this one.
      await tx.channelIdentity.deleteMany({ where: { userId, channel: 'telegram' } })
      await tx.channelIdentity.create({
        data: {
          userId,
          channel: 'telegram',
          externalId: input.externalId,
          username: input.username,
        },
      })
      return { linked: true, userId, again: false } as const
    })
  } catch (error) {
    // Two codes of two users for one Telegram account at the same moment: the second one loses.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      return { linked: false, reason: 'taken' }
    throw error
  }
}

/** Unlinks Telegram: from the cabinet, or `/stop` in the bot. */
export async function unlinkTelegram(
  db: PrismaClient,
  where: { userId: string } | { externalId: string },
): Promise<boolean> {
  const { count } = await db.channelIdentity.deleteMany({
    where: { channel: 'telegram', ...where },
  })
  return count > 0
}

export async function setTelegramNotifications(
  db: PrismaClient,
  input: { userId: string; on: boolean },
): Promise<void> {
  await db.notificationSetting.upsert({
    where: { userId: input.userId },
    create: { userId: input.userId, telegram: input.on },
    update: { telegram: input.on },
  })
}
