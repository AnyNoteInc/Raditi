import 'server-only'

import { createHash } from 'node:crypto'

import type { ObjectStorage } from '@repo/domain'
import {
  projectFileRefusalText,
  projectLimits,
  projectTextOf,
  secretInContent,
  sniffProjectFile,
  type ProjectFileRefusal,
} from '@repo/domain/projects'
import { z } from 'zod'

import { AttachmentUploadError, declaredLength, headOf, isLengthRefusal } from './attachment-upload'
import { attachmentDisposition } from './task-file'

// The bytes of a file of the context of a project (docs/plan/84-projects.md, ПР8; slice 84.8):
// `projectFile.start` announced it, `PUT /api/project-files/<id>` streams it into raditi-inbox
// under projects/<workspaceId>/<id>, and `GET` gives it back to the author of the project. As for
// an attachment, the bytes pass through web, which checks the session, the Origin, the consents,
// the size and the first bytes before anything is stored; a text is read whole — UTF-8, no
// secret. A download is never opened by the browser on the origin of the cabinet: an opaque type,
// an attachment, `nosniff` and a sandbox — an HTML file of a project runs no script here. Nothing
// of the file — its name, its bytes, its key — is logged.

const CONSENT_REQUIRED_MESSAGE = 'Примите обновлённые документы, чтобы продолжить'
const uuid = z.uuid()

/** The announced file as the upload needs it: of this uploader, no project took it yet. */
export interface ProjectFileUploadTarget {
  id: string
  key: string
  kind: 'file' | 'text'
  mediaType: string
  sizeBytes: number
  status: 'uploading' | 'ready'
  expiresAt: Date | null
}

/** A file to download: of a project of the user, or one of theirs no project took. */
export interface ProjectFileDownload {
  /** The path in the project: the download is named by its last part. */
  name: string
  key: string
  sizeBytes: number
  status: 'uploading' | 'ready'
}

export interface ProjectFileDependencies {
  appOrigin: () => string
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>
  hasRequiredConsents: (headers: Headers) => Promise<boolean>
  /** Counts an upload attempt; false once the user has used up the limit of the window. */
  admitUpload: (userId: string) => Promise<boolean>
  findUpload: (id: string, userId: string) => Promise<ProjectFileUploadTarget | null>
  /** `markProjectFileReady` of @repo/db: false — no longer `uploading`, taken or expired. */
  markReady: (input: { id: string; sizeBytes: number; sha256: string }) => Promise<boolean>
  /** `ownedProjectFile` of @repo/db. */
  findDownload: (id: string, userId: string) => Promise<ProjectFileDownload | null>
  storage: () => ObjectStorage
  now?: () => Date
  onFailure?: (operation: string, error: unknown) => void
}

class ProjectFileError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** The words of the routes, Russian and on «вы». */
export const projectFileText = Object.freeze({
  signIn: 'Войдите в аккаунт, чтобы добавить файл.',
  signInDownload: 'Войдите в аккаунт, чтобы скачать файл.',
  account: 'Не удалось подтвердить аккаунт.',
  origin: 'Запрос отклонён. Обновите страницу и попробуйте снова.',
  notFound: 'Файл не найден. Добавьте его снова.',
  downloadNotFound: 'Файл не найден.',
  spent: 'Этот файл уже загружен или время на его загрузку истекло. Добавьте его снова.',
  sizeMismatch: 'Размер файла не совпадает с заявленным. Добавьте его снова.',
  broken: 'Файл загрузился не полностью. Попробуйте ещё раз.',
  busy: 'Файлы ещё загружаются. Дождитесь, пока закончится загрузка предыдущих.',
  tooOften: 'Вы добавляете слишком много файлов. Попробуйте через несколько минут.',
  failed: 'Не удалось сохранить файл. Попробуйте ещё раз.',
  downloadFailed: 'Не удалось скачать файл.',
})

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

const refused = (reason: ProjectFileRefusal) =>
  new ProjectFileError(reason === 'too_large' ? 413 : 422, `${projectFileRefusalText[reason]}.`)

/** Every chunk passes the hash on its way to the storage. */
async function* hashed(
  body: AsyncIterable<Uint8Array>,
  hash: ReturnType<typeof createHash>,
): AsyncIterable<Uint8Array> {
  for await (const chunk of body) {
    hash.update(chunk)
    yield chunk
  }
}

/** A whole body, at most `limit` bytes (headOf refuses more). */
async function whole(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of body) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function removeObject(deps: ProjectFileDependencies, key: string): Promise<void> {
  try {
    await deps.storage().delete('inbox', key)
  } catch (error) {
    // The row stays `uploading` and expires; core's collector deletes the object with it.
    deps.onFailure?.('project file object cleanup failed', error)
  }
}

async function storeUpload(
  request: Request,
  target: ProjectFileUploadTarget,
  deps: ProjectFileDependencies,
): Promise<Response> {
  const declared = target.sizeBytes
  const length = declaredLength(request)
  if (length !== null && (!Number.isFinite(length) || length > projectLimits.fileBytes))
    throw refused('too_large')
  if (length !== null && length !== declared)
    throw new ProjectFileError(400, projectFileText.sizeMismatch)
  if (!request.body) throw new ProjectFileError(400, projectFileText.broken)

  const body = await headOf(request.body, declared)
  const sniff = sniffProjectFile(body.head, target.mediaType)
  if (!sniff.ok) {
    await body.cancel()
    throw refused(sniff.reason)
  }

  const hash = createHash('sha256')
  let stored = false
  try {
    let payload: Uint8Array | AsyncIterable<Uint8Array>
    if (sniff.type.kind === 'text') {
      // A text is read whole (20 MiB at most): every byte UTF-8, and no secret in it (ПР8).
      const bytes = await whole(body.all)
      const text = projectTextOf(bytes)
      if (text === null) throw refused('text_encoding')
      if (secretInContent(text)) throw refused('has_secret')
      hash.update(bytes)
      payload = bytes
    } else payload = hashed(body.all, hash)
    stored = true
    await deps.storage().put('inbox', target.key, payload, {
      contentType: target.mediaType,
      sizeBytes: declared,
    })
    const stat = await deps.storage().stat('inbox', target.key)
    if (stat === null || stat.sizeBytes !== declared)
      throw new ProjectFileError(400, projectFileText.broken)
    if (!(await deps.markReady({ id: target.id, sizeBytes: declared, sha256: hash.digest('hex') })))
      throw new ProjectFileError(409, projectFileText.spent)
  } catch (error) {
    if (stored) await removeObject(deps, target.key)
    if (error instanceof ProjectFileError) throw error
    if (isLengthRefusal(error)) throw new ProjectFileError(400, projectFileText.broken)
    // headOf() refused a body longer than declared, in the words of attachments.
    if (error instanceof AttachmentUploadError)
      throw new ProjectFileError(error.status, projectFileText.sizeMismatch)
    throw error
  }
  return json({ fileId: target.id, size: declared })
}

/** Uploads of a user this process is handling: a few at once, the rest are refused. */
const uploading = new Map<string, number>()
export const PARALLEL_PROJECT_UPLOADS_PER_USER = 3

/** `PUT /api/project-files/<id>`: the bytes of a file the user announced. */
export async function uploadProjectFile(
  request: Request,
  params: { id: string },
  deps: ProjectFileDependencies,
): Promise<Response> {
  try {
    const session = await deps.getSession(request.headers)
    if (!session) throw new ProjectFileError(401, projectFileText.signIn)
    const userId = session.user.id
    if (!uuid.safeParse(userId).success) throw new ProjectFileError(401, projectFileText.account)
    if (request.headers.get('origin') !== new URL(deps.appOrigin()).origin)
      throw new ProjectFileError(403, projectFileText.origin)
    if (!(await deps.hasRequiredConsents(request.headers)))
      throw new ProjectFileError(428, CONSENT_REQUIRED_MESSAGE)
    if (!uuid.safeParse(params.id).success)
      throw new ProjectFileError(404, projectFileText.notFound)
    const id = params.id.toLowerCase()
    const running = uploading.get(userId) ?? 0
    if (running >= PARALLEL_PROJECT_UPLOADS_PER_USER)
      throw new ProjectFileError(429, projectFileText.busy)
    uploading.set(userId, running + 1)
    try {
      if (!(await deps.admitUpload(userId)))
        throw new ProjectFileError(429, projectFileText.tooOften)
      const target = await deps.findUpload(id, userId)
      if (target === null) throw new ProjectFileError(404, projectFileText.notFound)
      const now = deps.now?.() ?? new Date()
      if (
        target.status !== 'uploading' ||
        target.expiresAt === null ||
        target.expiresAt.getTime() <= now.getTime()
      )
        throw new ProjectFileError(409, projectFileText.spent)
      return await storeUpload(request, target, deps)
    } finally {
      const left = (uploading.get(userId) ?? 1) - 1
      if (left <= 0) uploading.delete(userId)
      else uploading.set(userId, left)
    }
  } catch (error) {
    if (error instanceof ProjectFileError) return json({ message: error.message }, error.status)
    if (error instanceof AttachmentUploadError)
      return json({ message: projectFileText.sizeMismatch }, error.status)
    deps.onFailure?.('project file upload failed', error)
    return json({ message: projectFileText.failed }, 503)
  }
}

/** A stored object as the body of a response, exactly `sizeBytes` long. */
function streamOf(body: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel() {
      await iterator.return?.()
    },
  })
}

/** The headers of a download: never opened, sniffed or framed on the origin of the cabinet (ПР8). */
export function projectFileDownloadHeaders(name: string, sizeBytes: number): HeadersInit {
  return {
    'content-type': 'application/octet-stream',
    'content-length': String(sizeBytes),
    'content-disposition': attachmentDisposition(name.split('/').at(-1) ?? name),
    // A file may be removed and its id never names another: the owner's browser keeps no copy.
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "default-src 'none'; sandbox",
  }
}

/** `GET /api/project-files/<id>`: «Скачать» of a file of the context. */
export async function downloadProjectFile(
  request: Request,
  params: { id: string },
  deps: ProjectFileDependencies,
): Promise<Response> {
  try {
    const session = await deps.getSession(request.headers)
    if (!session) return json({ message: projectFileText.signInDownload }, 401)
    if (!(await deps.hasRequiredConsents(request.headers)))
      return json({ message: CONSENT_REQUIRED_MESSAGE }, 428)
    if (!uuid.safeParse(params.id).success)
      return json({ message: projectFileText.downloadNotFound }, 404)
    // Someone else's file, one not stored yet and one that is gone answer the same.
    const file = await deps.findDownload(params.id.toLowerCase(), session.user.id)
    if (file === null || file.status !== 'ready')
      return json({ message: projectFileText.downloadNotFound }, 404)
    const body = await deps.storage().get('inbox', file.key)
    if (body === null) return json({ message: projectFileText.downloadNotFound }, 404)
    return new Response(streamOf(body), {
      headers: projectFileDownloadHeaders(file.name, file.sizeBytes),
    })
  } catch (error) {
    deps.onFailure?.('project file download failed', error)
    return json({ message: projectFileText.downloadFailed }, 503)
  }
}
