import 'server-only'

import type { PrismaClient } from '@repo/db'

export const AVATAR_UPLOADS_PER_WINDOW = 10
export const AVATAR_UPLOAD_WINDOW_MS = 10 * 60_000

/**
 * Counts one upload attempt of the user and tells whether it fits the current window. The
 * counter lives in `rate_limits`, next to the limits of the sign-in routes, so every web replica
 * sees it. For these keys `last_request` is the END of the window: better-auth deletes every row
 * of the table whose last_request is older than its own longest window (one minute), so a row
 * holding the start would vanish long before the window ends. One statement: parallel attempts
 * cannot pass the limit together.
 */
export async function admitAvatarUpload(
  db: Pick<PrismaClient, '$queryRaw'>,
  userId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const key = `avatar-upload:${userId}`
  const at = BigInt(now)
  const windowEnd = BigInt(now + AVATAR_UPLOAD_WINDOW_MS)
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limits (id, key, count, last_request)
    VALUES (gen_random_uuid(), ${key}, 1, ${windowEnd}::bigint)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.last_request <= ${at}::bigint THEN 1
        ELSE LEAST(rate_limits.count, ${AVATAR_UPLOADS_PER_WINDOW}::int) + 1
      END,
      last_request = CASE
        WHEN rate_limits.last_request <= ${at}::bigint THEN ${windowEnd}::bigint
        ELSE rate_limits.last_request
      END
    RETURNING count
  `
  const count = rows[0]?.count
  // No row back is a broken counter, not a free pass.
  if (count === undefined) throw new Error('Avatar upload counter returned no row')
  return count <= AVATAR_UPLOADS_PER_WINDOW
}
