import 'server-only'

import type { ObjectStorage } from '@repo/domain'
import { attachmentLimits, sniffAttachmentType } from '@repo/domain/attachments/rules'
import { attachmentRefusalText } from '@repo/domain/attachments/labels'
import { z } from 'zod'

// The bytes of a file a client attaches to a message (docs/plan/57-browser-tasks.md, Б26):
// `attachment.start` announced it, this route streams it into raditi-inbox. The inbox is never
// presigned: the bytes pass through web, which checks the session, the Origin, the consents, the
// size and the first bytes before anything is stored, confirms the stored object with stat() and
// only then marks the file `ready`. Nothing of the file — its name, its bytes, its key — is logged.

/** The text consentedProcedure of @repo/trpc answers with its code CONSENT_REQUIRED. */
const CONSENT_REQUIRED_MESSAGE = 'Примите обновлённые документы, чтобы продолжить'
const uuid = z.uuid()

/** The announced file as the route needs it: never another user's. */
export interface UploadTarget {
  id: string
  /** `inbox/<workspaceId>/<attachmentId>`, as `attachment.start` wrote it. */
  key: string
  contentType: string
  /** Declared by `attachment.start`; the stored object must have exactly this many bytes. */
  sizeBytes: number
  status: 'uploading' | 'ready' | 'bound' | 'deleted'
  expiresAt: Date
}

export interface AttachmentUploadDependencies {
  appOrigin: () => string
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>
  /** Whether the user of these headers accepted the current required documents (152-FZ). */
  hasRequiredConsents: (headers: Headers) => Promise<boolean>
  /** Counts an upload attempt; false once the user has used up the limit of the window. */
  admitUpload: (userId: string) => Promise<boolean>
  /** The file `userId` announced with this id; null — no such file of this user. */
  findUpload: (id: string, userId: string) => Promise<UploadTarget | null>
  /** `markAttachmentReady` of @repo/db: false — the file is no longer `uploading` or expired. */
  markReady: (input: { id: string; sizeBytes: number; contentType: string }) => Promise<boolean>
  storage: () => ObjectStorage
  now?: () => Date
  /** For the server log only: the cause never reaches the client. */
  onFailure?: (operation: string, error: unknown) => void
}

export class AttachmentUploadError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** The words of the route, Russian and on «вы». */
export const uploadText = Object.freeze({
  signIn: 'Войдите в аккаунт, чтобы прикрепить файл.',
  account: 'Не удалось подтвердить аккаунт.',
  origin: 'Запрос отклонён. Обновите страницу и попробуйте снова.',
  notFound: 'Файл не найден. Прикрепите его снова.',
  spent: 'Этот файл уже загружен или время на его загрузку истекло. Прикрепите его снова.',
  sizeMismatch: 'Размер файла не совпадает с заявленным. Прикрепите его снова.',
  broken: 'Файл загрузился не полностью. Попробуйте ещё раз.',
  busy: 'Файлы ещё загружаются. Дождитесь, пока закончится загрузка предыдущих.',
  tooOften: 'Вы прикрепляете слишком много файлов. Попробуйте через несколько минут.',
  failed: 'Не удалось сохранить файл. Попробуйте ещё раз.',
})

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/** The signed-in user of a request from a page of the app itself. */
async function signedIn(request: Request, deps: AttachmentUploadDependencies): Promise<string> {
  const session = await deps.getSession(request.headers)
  if (!session) throw new AttachmentUploadError(401, uploadText.signIn)
  if (!uuid.safeParse(session.user.id).success)
    throw new AttachmentUploadError(401, uploadText.account)
  if (request.headers.get('origin') !== new URL(deps.appOrigin()).origin)
    throw new AttachmentUploadError(403, uploadText.origin)
  return session.user.id
}

/** A declared length of the body; null when the request has none (a chunked body). */
function declaredLength(request: Request): number | null {
  const header = request.headers.get('content-length')
  if (header === null) return null
  return /^\d{1,15}$/.test(header.trim()) ? Number(header) : Number.NaN
}

/**
 * The first bytes of a body (up to `attachmentLimits.sniffBytes`, fewer when the body is
 * shorter) and an iterable of the whole body, those bytes first. More than `limit` bytes in all
 * end the iteration with a refusal: a forged Content-Length cannot carry more.
 */
async function headOf(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ head: Uint8Array; all: AsyncIterable<Uint8Array>; cancel: () => Promise<void> }> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let headBytes = 0
  let done = false
  while (headBytes < attachmentLimits.sniffBytes) {
    const next = await reader.read()
    if (next.done) {
      done = true
      break
    }
    chunks.push(next.value)
    headBytes += next.value.byteLength
    if (headBytes > limit) {
      await reader.cancel().catch(() => {})
      throw new AttachmentUploadError(400, uploadText.sizeMismatch)
    }
  }
  const head = Buffer.concat(chunks)
  async function* all(): AsyncIterable<Uint8Array> {
    let total = head.byteLength
    if (total > 0) yield head
    if (done) return
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      total += next.value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        throw new AttachmentUploadError(400, uploadText.sizeMismatch)
      }
      yield next.value
    }
  }
  return { head, all: all(), cancel: () => reader.cancel().catch(() => {}) }
}

async function removeObject(deps: AttachmentUploadDependencies, key: string): Promise<void> {
  try {
    await deps.storage().delete('inbox', key)
  } catch (error) {
    // The row stays `uploading` and expires; a collector may delete the object later.
    deps.onFailure?.('attachment object cleanup failed', error)
  }
}

async function storeUpload(
  request: Request,
  target: UploadTarget,
  deps: AttachmentUploadDependencies,
): Promise<Response> {
  const declared = target.sizeBytes
  const length = declaredLength(request)
  if (length !== null && (!Number.isFinite(length) || length > attachmentLimits.fileBytes))
    throw new AttachmentUploadError(413, attachmentRefusalText.too_large)
  if (length !== null && length !== declared)
    throw new AttachmentUploadError(400, uploadText.sizeMismatch)
  if (!request.body) throw new AttachmentUploadError(400, uploadText.broken)

  const body = await headOf(request.body, declared)
  // The first bytes must be those of the declared type: nothing else is stored at all.
  const sniff = sniffAttachmentType(body.head, target.contentType)
  if (!sniff.ok) {
    await body.cancel()
    throw new AttachmentUploadError(422, attachmentRefusalText[sniff.reason])
  }

  let stored = false
  try {
    stored = true
    await deps.storage().put('inbox', target.key, body.all, {
      contentType: target.contentType,
      sizeBytes: declared,
    })
    // The object as S3 keeps it: exactly the announced bytes, or the file is not taken.
    const stat = await deps.storage().stat('inbox', target.key)
    if (stat === null || stat.sizeBytes !== declared)
      throw new AttachmentUploadError(400, uploadText.broken)
    if (
      !(await deps.markReady({
        id: target.id,
        sizeBytes: declared,
        contentType: target.contentType,
      }))
    )
      throw new AttachmentUploadError(409, uploadText.spent)
  } catch (error) {
    if (stored) await removeObject(deps, target.key)
    if (error instanceof AttachmentUploadError) throw error
    // A body that broke off or did not match its length: the client's upload, not the storage.
    if (isLengthRefusal(error)) throw new AttachmentUploadError(400, uploadText.broken)
    throw error
  }
  return json({ attachmentId: target.id, size: declared })
}

/** The storage refused a stream shorter or longer than its declared size (`checkedLength`). */
function isLengthRefusal(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'BAD_REQUEST'
  )
}

/** Uploads of a user this process is handling: a few at once, the rest are refused. */
const uploading = new Map<string, number>()
export const PARALLEL_UPLOADS_PER_USER = 3

/**
 * `PUT /api/attachments/<id>`: the bytes of a file the user announced. The answer is the id and
 * the size once the file is `ready`; any refusal leaves nothing stored.
 */
export async function uploadAttachment(
  request: Request,
  params: { id: string },
  deps: AttachmentUploadDependencies,
): Promise<Response> {
  try {
    const userId = await signedIn(request, deps)
    if (!(await deps.hasRequiredConsents(request.headers)))
      throw new AttachmentUploadError(428, CONSENT_REQUIRED_MESSAGE)
    if (!uuid.safeParse(params.id).success)
      throw new AttachmentUploadError(404, uploadText.notFound)
    const id = params.id.toLowerCase()
    const running = uploading.get(userId) ?? 0
    if (running >= PARALLEL_UPLOADS_PER_USER) throw new AttachmentUploadError(429, uploadText.busy)
    uploading.set(userId, running + 1)
    try {
      if (!(await deps.admitUpload(userId)))
        throw new AttachmentUploadError(429, uploadText.tooOften)
      // Someone else's file and one that does not exist answer the same.
      const target = await deps.findUpload(id, userId)
      if (target === null) throw new AttachmentUploadError(404, uploadText.notFound)
      const now = deps.now?.() ?? new Date()
      if (target.status !== 'uploading' || target.expiresAt.getTime() <= now.getTime())
        throw new AttachmentUploadError(409, uploadText.spent)
      return await storeUpload(request, target, deps)
    } finally {
      const left = (uploading.get(userId) ?? 1) - 1
      if (left <= 0) uploading.delete(userId)
      else uploading.set(userId, left)
    }
  } catch (error) {
    if (error instanceof AttachmentUploadError)
      return json({ message: error.message }, error.status)
    deps.onFailure?.('attachment upload failed', error)
    return json({ message: uploadText.failed }, 503)
  }
}
