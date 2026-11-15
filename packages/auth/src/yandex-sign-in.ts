import { genericOAuth, yandex } from 'better-auth/plugins/generic-oauth'

import type { YandexOAuthKeys } from './config.ts'
import { profileNameSchema } from './profile-schema.ts'

/** The provider id: the callback is `<BETTER_AUTH_URL>/api/auth/callback/yandex`. */
export const YANDEX_PROVIDER_ID = 'yandex'

/**
 * Exactly the scopes of the registered app: the helper also asks for `login:avatar`, which
 * Yandex refuses for an app that has not been granted it.
 */
export const YANDEX_SCOPES = ['login:info', 'login:email']

/** A Yandex display name may be empty or hold characters `users.name` refuses. */
const FALLBACK_NAME = 'Пользователь'

type YandexConfig = ReturnType<typeof yandex>
type YandexUserInfo = NonNullable<Awaited<ReturnType<NonNullable<YandexConfig['getUserInfo']>>>>

/**
 * The profile Yandex hands over, as the platform stores it: the name passes the same rules as
 * the profile form, no image (`users.image` is only the avatar the user uploads, spec §16), and
 * the address counts as verified — Yandex ID gives out only confirmed default addresses.
 */
export function yandexProfile(info: YandexUserInfo): YandexUserInfo {
  const name = profileNameSchema.safeParse(info.name)
  const { image: _image, ...rest } = info
  return { ...rest, name: name.success ? name.data : FALLBACK_NAME, emailVerified: true }
}

/** Sign-in with Yandex ID through better-auth's own `signIn.social` and `callback/:id`. */
export function yandexSignIn(keys: YandexOAuthKeys) {
  const base = yandex({
    clientId: keys.clientId,
    clientSecret: keys.clientSecret,
    scopes: YANDEX_SCOPES,
  })
  const getUserInfo = base.getUserInfo
  return genericOAuth({
    config: [
      {
        ...base,
        // The address on Yandex may change; the platform keeps what the user set here.
        overrideUserInfo: false,
        getUserInfo: async (tokens) => {
          const info = await getUserInfo?.(tokens)
          return info ? yandexProfile(info) : null
        },
      },
    ],
  })
}

/**
 * Account rows keep no provider tokens: the platform never calls Yandex on the user's behalf,
 * and a token in PostgreSQL would be a secret outside Vault (rule 2).
 */
export function withoutProviderTokens<T extends Record<string, unknown>>(account: T): T {
  return {
    ...account,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  }
}
