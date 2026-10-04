import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'

import { profileNameSchema } from './profile-schema.ts'

const SIGN_UP_PATH = '/sign-up/email'

/** RFC 5321: a forward path is at most 256 octets with its angle brackets. */
export const EMAIL_MAX_LENGTH = 254

/**
 * better-auth's own code, which the web already maps to Russian text: a longer address would
 * otherwise reach `users.email` (VarChar 255) and fail as FAILED_TO_CREATE_USER.
 */
const EMAIL_TOO_LONG = {
  code: 'INVALID_EMAIL',
  message: 'Проверьте адрес электронной почты: в нём есть ошибка',
} as const

export const PROFILE_ERROR_CODES = {
  INVALID_NAME: {
    code: 'INVALID_NAME',
    message: 'Укажите имя: до 255 символов, без переносов строк и служебных знаков',
  },
  IMAGE_NOT_ALLOWED: {
    code: 'IMAGE_NOT_ALLOWED',
    message: 'Фото профиля можно загрузить в личном кабинете после регистрации',
  },
} as const

/**
 * Sign-up takes the same name as the profile form and no image: better-auth itself accepts
 * any string for both. `users.image` is written only by the avatar upload, which stores its
 * own WebP and a relative URL. An address over 254 characters is refused as INVALID_EMAIL.
 * The checks run before the address lookup, so the answer does not depend on whether the
 * address is taken.
 */
export const signUpProfile = () =>
  ({
    id: 'sign-up-profile',
    $ERROR_CODES: PROFILE_ERROR_CODES,
    hooks: {
      before: [
        {
          matcher: (context) => context.path === SIGN_UP_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const body: Record<string, unknown> =
              typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {}
            if (typeof body.email === 'string' && body.email.length > EMAIL_MAX_LENGTH) {
              throw APIError.from('BAD_REQUEST', EMAIL_TOO_LONG)
            }
            if (body.image !== undefined) {
              throw APIError.from('BAD_REQUEST', PROFILE_ERROR_CODES.IMAGE_NOT_ALLOWED)
            }
            const name = profileNameSchema.safeParse(body.name)
            if (!name.success) throw APIError.from('BAD_REQUEST', PROFILE_ERROR_CODES.INVALID_NAME)
            return { context: { body: { ...body, name: name.data } } }
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin
