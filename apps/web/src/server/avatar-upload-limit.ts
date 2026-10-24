import 'server-only'

import type { PrismaClient } from '@repo/db'

export const AVATAR_UPLOADS_PER_WINDOW = 10
export const AVATAR_UPLOAD_WINDOW_MS = 10 * 60_000

/**
 * Counts one upload attempt of the user and tells whether it fits the current window. The
 * counter lives in `rate_limits` (admitInWindow).
 */
export function admitAvatarUpload(
  db: Pick<PrismaClient, '$queryRaw'>,
  userId: string,
  now: number = Date.now(),
): Promise<boolean> {
  return admitInWindow(db, {
    key: `avatar-upload:${userId}`,
    limit: AVATAR_UPLOADS_PER_WINDOW,
    windowMs: AVATAR_UPLOAD_WINDOW_MS,
    now,
  })
}

/**
 * Files a user may attach to messages in a window (docs/plan/57-browser-tasks.md, Б26): ten a
 * message, a few messages at once — a bound on bytes streamed to the inbox, not a quota.
 */
export const ATTACHMENT_UPLOADS_PER_WINDOW = 60
export const ATTACHMENT_UPLOAD_WINDOW_MS = 10 * 60_000

/** One upload of an attached file (`PUT /api/attachments/<id>`), counted like the avatar's. */
export function admitAttachmentUpload(
  db: Pick<PrismaClient, '$queryRaw'>,
  userId: string,
  now: number = Date.now(),
): Promise<boolean> {
  return admitInWindow(db, {
    key: `attachment-upload:${userId}`,
    limit: ATTACHMENT_UPLOADS_PER_WINDOW,
    windowMs: ATTACHMENT_UPLOAD_WINDOW_MS,
    now,
  })
}

/**
 * Counts one attempt under `key` and tells whether it fits the current window. The counter
 * lives in `rate_limits`, next to the limits of the sign-in routes, so every web replica sees
 * it. For these keys `last_request` is the END of the window: better-auth deletes every row of
 * the table whose last_request is older than its own longest window (one minute), so a row
 * holding the start would vanish long before the window ends. One statement: parallel attempts
 * cannot pass the limit together.
 */
async function admitInWindow(
  db: Pick<PrismaClient, '$queryRaw'>,
  window: { key: string; limit: number; windowMs: number; now: number },
): Promise<boolean> {
  const { key, limit } = window
  const at = BigInt(window.now)
  const windowEnd = BigInt(window.now + window.windowMs)
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limits (id, key, count, last_request)
    VALUES (gen_random_uuid(), ${key}, 1, ${windowEnd}::bigint)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.last_request <= ${at}::bigint THEN 1
        ELSE LEAST(rate_limits.count, ${limit}::int) + 1
      END,
      last_request = CASE
        WHEN rate_limits.last_request <= ${at}::bigint THEN ${windowEnd}::bigint
        ELSE rate_limits.last_request
      END
    RETURNING count
  `
  const count = rows[0]?.count
  // No row back is a broken counter, not a free pass.
  if (count === undefined) throw new Error('Upload counter returned no row')
  return count <= limit
}
