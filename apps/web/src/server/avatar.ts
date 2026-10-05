import 'server-only'

import { randomUUID } from 'node:crypto'

import type { ObjectStorage } from '@repo/domain'
import { z } from 'zod'

import {
  AVATAR_CONTENT_TYPE,
  AvatarError,
  MAX_AVATAR_BYTES,
  MAX_STORED_AVATAR_BYTES,
  normalizeAvatar,
} from './avatar-image'
import { readBodyWithin } from './body-limit'

// The file plus a small multipart envelope; a forged Content-Length cannot bypass this cap.
export const MAX_AVATAR_REQUEST_BYTES = MAX_AVATAR_BYTES + 64 * 1024
/** The text consentedProcedure of @repo/trpc answers with its code CONSENT_REQUIRED. */
const CONSENT_REQUIRED_MESSAGE = 'Примите обновлённые документы, чтобы продолжить'
const uuid = z.uuid()
const filename = z.string().regex(/^[0-9a-f-]{36}\.webp$/)
const routeParams = z.object({ userId: uuid, filename })

export interface AvatarDependencies {
  appOrigin: () => string
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>
  /** Whether the user of these headers accepted the current required documents (152-FZ). */
  hasRequiredConsents: (headers: Headers) => Promise<boolean>
  /** Counts an upload attempt; false once the user has used up the limit of the window. */
  admitUpload: (userId: string) => Promise<boolean>
  getUserImage: (id: string) => Promise<{ image: string | null } | null>
  /** Compare-and-set keeps simultaneous uploads from deleting one another's objects. */
  setUserImage: (id: string, previous: string | null, image: string | null) => Promise<boolean>
  storage: () => ObjectStorage
  /** For the server log only: the cause never reaches the client. */
  onFailure?: (operation: string, error: unknown) => void
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

const avatarUrl = (userId: string, name: string) => `/api/profile/avatar/${userId}/${name}`
const avatarKey = (userId: string, name: string) => `avatars/${userId}/${name}`

/** Accept only our exact relative URL for this user; external and other users' photos stay put. */
function ownedAvatarKey(image: string | null, userId: string): string | null {
  const prefix = `/api/profile/avatar/${userId}/`
  if (!image?.startsWith(prefix)) return null
  const name = image.slice(prefix.length)
  if (!filename.safeParse(name).success || !uuid.safeParse(name.slice(0, -5)).success) return null
  return avatarKey(userId, name)
}

/** The signed-in user; a mutation must also come from a page of the app itself. */
async function signedIn(request: Request, deps: AvatarDependencies, mutation: boolean) {
  const session = await deps.getSession(request.headers)
  if (!session) throw new AvatarError(401, 'Войдите в аккаунт, чтобы изменить аватар.')
  if (!uuid.safeParse(session.user.id).success)
    throw new AvatarError(401, 'Не удалось подтвердить аккаунт.')
  if (mutation && request.headers.get('origin') !== new URL(deps.appOrigin()).origin)
    throw new AvatarError(403, 'Запрос отклонён. Обновите страницу и попробуйте снова.')
  return session.user.id
}

/**
 * Like every business procedure of the tRPC router: nothing new is stored before the current
 * documents are accepted.
 */
async function requireConsents(request: Request, deps: AvatarDependencies): Promise<void> {
  if (!(await deps.hasRequiredConsents(request.headers)))
    throw new AvatarError(428, CONSENT_REQUIRED_MESSAGE)
}

async function removeObject(deps: AvatarDependencies, key: string): Promise<void> {
  try {
    await deps.storage().delete('artifacts', key)
  } catch (error) {
    // The saved image is authoritative; an orphan must not undo a successful profile update.
    deps.onFailure?.('avatar object cleanup failed', error)
  }
}

async function avatarFile(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!/^multipart\/form-data(?:;|$)/i.test(contentType))
    throw new AvatarError(415, 'Загрузите изображение через форму выбора файла.')
  const body = await readBodyWithin(request, MAX_AVATAR_REQUEST_BYTES)
  if (!body) throw new AvatarError(413, 'Изображение должно быть не больше 5 МБ.')
  if (!request.body) throw new AvatarError(400, 'Выберите файл изображения.')

  try {
    const form = await new Response(body, { headers: { 'content-type': contentType } }).formData()
    const fields = [...form.keys()]
    if (fields.length !== 1 || fields[0] !== 'file')
      throw new AvatarError(400, 'Выберите один файл изображения.')
    return form.get('file')
  } catch (error) {
    if (error instanceof AvatarError) throw error
    throw new AvatarError(400, 'Не удалось прочитать загруженный файл.')
  }
}

function errorResponse(
  error: unknown,
  deps: AvatarDependencies,
  operation: string,
  message: string,
): Response {
  if (error instanceof AvatarError) return json({ message: error.message }, error.status)
  deps.onFailure?.(`${operation} failed`, error)
  return json({ message }, 503)
}

async function storeAvatar(
  request: Request,
  userId: string,
  deps: AvatarDependencies,
): Promise<Response> {
  const body = await normalizeAvatar(await avatarFile(request))
  const user = await deps.getUserImage(userId)
  if (!user) throw new AvatarError(401, 'Аккаунт не найден. Войдите снова.')

  const name = `${randomUUID()}.webp`
  const image = avatarUrl(userId, name)
  const key = avatarKey(userId, name)
  try {
    await deps.storage().put('artifacts', key, body, {
      contentType: AVATAR_CONTENT_TYPE,
      sizeBytes: body.byteLength,
    })
  } catch (error) {
    await removeObject(deps, key)
    throw error
  }

  let saved: boolean
  try {
    saved = await deps.setUserImage(userId, user.image, image)
  } catch (error) {
    // A connection can fail after PostgreSQL committed. Re-read before deleting the object;
    // if this check also fails, retain it rather than breaking a possibly saved profile.
    const current = await deps.getUserImage(userId)
    if (current?.image === image) {
      saved = true
    } else {
      await removeObject(deps, key)
      throw error
    }
  }
  if (!saved) {
    await removeObject(deps, key)
    throw new AvatarError(409, 'Аватар уже изменился. Обновите страницу и повторите загрузку.')
  }

  const previousKey = ownedAvatarKey(user.image, userId)
  if (previousKey) await removeObject(deps, previousKey)
  return json({ image })
}

// Users whose upload this process is handling: a parallel one is refused, not queued.
const uploading = new Set<string>()

/**
 * Buffering and decoding cost memory and CPU, so one account gets one upload at a time and a
 * limited number per window, both checked before the body is read.
 */
export async function uploadAvatar(request: Request, deps: AvatarDependencies): Promise<Response> {
  try {
    const userId = await signedIn(request, deps, true)
    await requireConsents(request, deps)
    if (uploading.has(userId))
      throw new AvatarError(429, 'Предыдущее фото ещё загружается. Дождитесь завершения.')
    uploading.add(userId)
    try {
      if (!(await deps.admitUpload(userId)))
        throw new AvatarError(
          429,
          'Вы слишком часто загружаете фото. Попробуйте через несколько минут.',
        )
      return await storeAvatar(request, userId, deps)
    } finally {
      uploading.delete(userId)
    }
  } catch (error) {
    return errorResponse(
      error,
      deps,
      'avatar upload',
      'Не удалось сохранить аватар. Попробуйте ещё раз.',
    )
  }
}

/**
 * No consent check: a user removes their own photo whether or not they accepted the current
 * documents. Deleting personal data cannot depend on agreeing to new terms (152-FZ).
 */
export async function deleteAvatar(request: Request, deps: AvatarDependencies): Promise<Response> {
  try {
    const userId = await signedIn(request, deps, true)
    const user = await deps.getUserImage(userId)
    if (!user) throw new AvatarError(401, 'Аккаунт не найден. Войдите снова.')
    if (user.image === null) return json({ image: null })
    if (!(await deps.setUserImage(userId, user.image, null)))
      throw new AvatarError(409, 'Аватар уже изменился. Обновите страницу и попробуйте снова.')
    const key = ownedAvatarKey(user.image, userId)
    if (key) await removeObject(deps, key)
    return json({ image: null })
  } catch (error) {
    return errorResponse(
      error,
      deps,
      'avatar removal',
      'Не удалось удалить аватар. Попробуйте ещё раз.',
    )
  }
}

export async function getAvatar(
  request: Request,
  params: { userId: string; filename: string },
  deps: AvatarDependencies,
): Promise<Response> {
  try {
    const userId = await signedIn(request, deps, false)
    const parsed = routeParams.safeParse(params)
    if (
      !parsed.success ||
      !uuid.safeParse(params.filename.slice(0, -5)).success ||
      userId !== params.userId
    )
      throw new AvatarError(404, 'Аватар не найден.')
    const user = await deps.getUserImage(userId)
    if (!user || user.image !== avatarUrl(userId, params.filename))
      throw new AvatarError(404, 'Аватар не найден.')
    // The address names one version of the image, so its bytes never change: the owner's browser
    // keeps a private copy for a day and then revalidates it here without a read from S3.
    const cache = {
      'cache-control': 'private, max-age=86400, immutable',
      etag: `"${params.filename.slice(0, -5)}"`,
    }
    // A proxy may weaken the validator; for this comparison it is the same version.
    if (request.headers.get('if-none-match')?.replace(/^W\//, '') === cache.etag)
      return new Response(null, { status: 304, headers: cache })
    const object = await deps.storage().get('artifacts', avatarKey(userId, params.filename))
    if (!object) throw new AvatarError(404, 'Аватар не найден.')
    const chunks: Uint8Array[] = []
    let length = 0
    for await (const chunk of object) {
      length += chunk.byteLength
      if (length > MAX_STORED_AVATAR_BYTES) throw new Error('Stored avatar exceeds its size limit')
      chunks.push(chunk)
    }
    return new Response(Buffer.concat(chunks), {
      headers: {
        'content-type': AVATAR_CONTENT_TYPE,
        'content-length': String(length),
        'content-disposition': 'inline; filename="avatar.webp"',
        ...cache,
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
      },
    })
  } catch (error) {
    return errorResponse(error, deps, 'avatar read', 'Не удалось загрузить аватар.')
  }
}
