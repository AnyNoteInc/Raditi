import 'server-only'

import { createHash } from 'node:crypto'

import { checkPageContent, type ObjectStorage } from '@repo/domain'
import { artifactLimits, checkArtifactFile } from '@repo/domain/artifacts'
import { z } from 'zod'

// The bytes of a file of an artifact a person uploads (docs/plan/88-artifacts.md, Ар12; slice
// 88.12): `artifact.fileStart` announced it, `PUT /api/artifact-files/<id>` brings at most 5 MiB.
// The bytes pass through web, which checks the session, the Origin, the consents, the size, the
// type by the extension and the first bytes (an SVG as a page is) before the artifacts bucket gets
// them. Nothing of the file is logged.

const uuid = z.uuid()

export interface ArtifactFileUploadTarget {
  id: string
  name: string
  objectKey: string
  bytes: number
}

export interface ArtifactFileDependencies {
  appOrigin: () => string
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>
  hasRequiredConsents: (headers: Headers) => Promise<boolean>
  findUpload: (id: string, userId: string) => Promise<ArtifactFileUploadTarget | null>
  markReady: (input: {
    id: string
    contentType: string
    sizeBytes: number
    sha256: string
    objectKey: string
  }) => Promise<boolean>
  storage: () => Pick<ObjectStorage, 'put' | 'delete'>
  onFailure?: (operation: string, error: unknown) => void
}

export const artifactFileText = Object.freeze({
  signIn: 'Войдите в аккаунт, чтобы добавить файл.',
  origin: 'Запрос отклонён. Обновите страницу и попробуйте снова.',
  consents: 'Примите обновлённые документы, чтобы продолжить',
  notFound: 'Файл не найден. Добавьте его снова.',
  sizeMismatch: 'Размер файла не совпадает с заявленным. Добавьте его снова.',
  tooLarge: 'Файл больше 5 МБ.',
  type: 'Подойдёт картинка или шрифт: PNG, JPG, GIF, WebP, AVIF, SVG, WOFF2, WOFF.',
  content: 'В этом файле есть то, что нельзя показывать в артефакте.',
  spent: 'Этот файл уже загружен. Добавьте его снова.',
  failed: 'Не удалось сохранить файл. Попробуйте ещё раз.',
})

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/** The body, at most `limit` bytes; null — longer. */
async function bodyOf(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
    length += chunk.byteLength
    if (length > limit) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, length)
}

/** `PUT /api/artifact-files/<id>`: the bytes of a file the person announced. */
export async function uploadArtifactFile(
  request: Request,
  params: { id: string },
  deps: ArtifactFileDependencies,
): Promise<Response> {
  try {
    const session = await deps.getSession(request.headers)
    if (!session) return json({ message: artifactFileText.signIn }, 401)
    if (request.headers.get('origin') !== new URL(deps.appOrigin()).origin)
      return json({ message: artifactFileText.origin }, 403)
    if (!(await deps.hasRequiredConsents(request.headers)))
      return json({ message: artifactFileText.consents }, 428)
    if (!uuid.safeParse(params.id).success) return json({ message: artifactFileText.notFound }, 404)
    const target = await deps.findUpload(params.id.toLowerCase(), session.user.id)
    if (target === null) return json({ message: artifactFileText.notFound }, 404)
    const bytes = await bodyOf(request, Math.min(target.bytes, artifactLimits.fileBytes))
    if (bytes === null) return json({ message: artifactFileText.tooLarge }, 413)
    if (bytes.byteLength !== target.bytes)
      return json({ message: artifactFileText.sizeMismatch }, 400)
    const verdict = checkArtifactFile(target.name, bytes)
    if (!verdict.ok)
      return json(
        {
          message:
            verdict.reason === 'too_large' ? artifactFileText.tooLarge : artifactFileText.type,
        },
        verdict.reason === 'too_large' ? 413 : 422,
      )
    if (verdict.type === 'image/svg+xml' && !checkPageContent(bytes).ok)
      return json({ message: artifactFileText.content }, 422)
    // The bytes go under a key of their own hash: a second upload of the same row, racing this one,
    // never overwrites the bytes the row ends up naming.
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const objectKey = `${target.objectKey}.${sha256.slice(0, 16)}`
    await deps.storage().put('artifacts', objectKey, bytes, {
      contentType: verdict.type,
      sizeBytes: bytes.byteLength,
    })
    const ready = await deps.markReady({
      id: target.id,
      contentType: verdict.type,
      sizeBytes: bytes.byteLength,
      sha256,
      objectKey,
    })
    if (!ready) return json({ message: artifactFileText.spent }, 409)
    return json({ fileId: target.id, type: verdict.type, size: bytes.byteLength })
  } catch (error) {
    deps.onFailure?.('artifact file upload failed', error)
    return json({ message: artifactFileText.failed }, 503)
  }
}
