import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'

import {
  signUpConsentRows,
  signUpConsentSchema,
  type ConsentRow,
  type SignUpConsent,
} from './consents.ts'
import { requestMeta } from './request-meta.ts'

const SIGN_UP_PATH = '/sign-up/email'

export const CONSENT_ERROR_CODES = {
  TERMS_NOT_ACCEPTED: {
    code: 'TERMS_NOT_ACCEPTED',
    message:
      'Чтобы зарегистрироваться, примите пользовательское соглашение и публичную оферту и подтвердите, что ознакомились с политикой обработки персональных данных',
  },
  PERSONAL_DATA_NOT_ACCEPTED: {
    code: 'PERSONAL_DATA_NOT_ACCEPTED',
    message: 'Нужно дать согласие на обработку персональных данных',
  },
  INVALID_MARKETING_CONSENT: {
    code: 'INVALID_MARKETING_CONSENT',
    message: 'Не удалось прочитать ответ о рассылках. Обновите страницу и попробуйте ещё раз',
  },
} as const

/** Anything that can append consent rows: the Prisma client or a transaction client. */
export interface ConsentWriter {
  userConsent: { createMany(args: { data: ConsentRow[] }): PromiseLike<unknown> }
}

/** The first failed field in form order; a body that is not an object fails the terms. */
function consentError(failed: ReadonlySet<PropertyKey | undefined>) {
  const onlyLaterFields = [...failed].every(
    (field) => field === 'acceptPersonalData' || field === 'marketing',
  )
  if (!onlyLaterFields) return CONSENT_ERROR_CODES.TERMS_NOT_ACCEPTED
  if (failed.has('acceptPersonalData')) return CONSENT_ERROR_CODES.PERSONAL_DATA_NOT_ACCEPTED
  return CONSENT_ERROR_CODES.INVALID_MARKETING_CONSENT
}

/** Validates the consent fields of a sign-up body; throws a Russian APIError otherwise. */
export function parseSignUpConsent(body: unknown): SignUpConsent {
  const parsed = signUpConsentSchema.safeParse(body)
  if (parsed.success) return parsed.data
  const failed = new Set(parsed.error.issues.map((issue) => issue.path[0]))
  throw APIError.from('BAD_REQUEST', consentError(failed))
}

/**
 * 152-FZ consents at sign-up: the server itself checks both required checkboxes (the terms
 * and the separate consent to personal data processing) and logs every document with its
 * edition, the IP and the user agent.
 *
 * Rows are written from databaseHooks.user.create.after, not from hooks.after: with
 * requireEmailVerification a sign-up with a taken email answers with a made-up user
 * (no enumeration), so only the database hook knows a user was really created. better-auth
 * runs it after the sign-up handler has finished its writes.
 */
export const consents = (options: { db: ConsentWriter }) =>
  ({
    id: 'consents',
    $ERROR_CODES: CONSENT_ERROR_CODES,
    hooks: {
      before: [
        {
          matcher: (context) => context.path === SIGN_UP_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            parseSignUpConsent(ctx.body)
          }),
        },
      ],
    },
    init: () => ({
      options: {
        databaseHooks: {
          user: {
            create: {
              after: async (user, ctx) => {
                if (ctx?.path !== SIGN_UP_PATH) return
                const consent = signUpConsentSchema.safeParse(ctx.body)
                // Unreachable over HTTP and auth.api: the before hook rejected such a body.
                if (!consent.success) return
                const meta = requestMeta(ctx.headers ?? ctx.request?.headers)
                const rows = signUpConsentRows(consent.data, { userId: user.id, ...meta })
                try {
                  await options.db.userConsent.createMany({ data: rows })
                } catch (error) {
                  // The account already exists; failing the response now would only make the
                  // user sign up again. The cabinet asks for missing consents before any work.
                  ctx.context.logger.error('Could not record sign-up consents', {
                    userId: user.id,
                    error,
                  })
                }
              },
            },
          },
        },
      },
    }),
  }) satisfies BetterAuthPlugin
