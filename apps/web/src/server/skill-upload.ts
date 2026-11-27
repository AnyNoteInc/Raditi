import 'server-only'

import {
  accountSkillLimits,
  accountSkillRefusalTexts,
  isDomainError,
  skillInvalidText,
} from '@repo/domain'
import type { InstallAnswer } from '@repo/trpc'
import { z } from 'zod'

import { AttachmentUploadError, declaredLength, headOf, isLengthRefusal } from './attachment-upload'

// «Добавить из файла» of the page «Навыки» (docs/plan/97-skills.md, Нв9): the browser posts a
// `.zip` or `.skill` as the raw body of `POST /api/skills/upload?name=<file name>[&replace=1]`.
// A body of tRPC is 256 KiB at most, so the archive comes here; it is read whole in memory (10 MiB
// at most) and handed to `installSkillFromArchive`, which checks and stores it. As for the other
// uploads, web checks the session, the Origin, the consents and the rate first; nothing of the
// archive — its name, its bytes — is logged.

const CONSENT_REQUIRED_MESSAGE = 'Примите обновлённые документы, чтобы продолжить'
const uuid = z.uuid()

export interface SkillUploadDependencies {
  appOrigin: () => string
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>
  hasRequiredConsents: (headers: Headers) => Promise<boolean>
  /** Counts an upload attempt; false once the user has used up the limit of the window. */
  admitUpload: (userId: string) => Promise<boolean>
  /** `installSkillFromArchive` of @repo/trpc with the services of the process. */
  install: (input: {
    userId: string
    bytes: Uint8Array
    fileName: string
    replace: boolean
  }) => Promise<InstallAnswer>
  onFailure?: (operation: string, error: unknown) => void
}

/** The words of the route, Russian and on «вы». */
export const skillUploadText = Object.freeze({
  signIn: 'Войдите в аккаунт, чтобы добавить навык.',
  account: 'Не удалось подтвердить аккаунт.',
  origin: 'Запрос отклонён. Обновите страницу и попробуйте снова.',
  empty: 'Файл пустой. Выберите архив навыка (.zip или .skill).',
  tooLarge: 'Файл больше 10 МБ. Навык должен быть меньше.',
  broken: 'Файл загрузился не полностью. Попробуйте ещё раз.',
  tooOften: 'Вы добавляете слишком много навыков. Попробуйте через несколько минут.',
  failed: 'Не удалось добавить навык. Попробуйте ещё раз.',
})

class SkillUploadError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/**
 * The name the archive is recorded under: its last part, printable, 255 characters at most;
 * `skill.zip` when none is given.
 */
export function skillFileName(raw: string | null): string {
  const last = (raw ?? '').split(/[/\\]/u).at(-1) ?? ''
  // Control characters and the marks of bidirectional text never reach a row.
  const clean = last
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, 255)
  return clean === '' ? 'skill.zip' : clean
}

/** The Russian text of a refusal of the domain. */
function refusalText(code: string, details: unknown): string | null {
  if (code === 'SKILL_INVALID') {
    const reason =
      typeof details === 'object' && details !== null && 'reason' in details
        ? (details as { reason: unknown }).reason
        : undefined
    return skillInvalidText(reason)
  }
  return accountSkillRefusalTexts[code] ?? null
}

async function readWhole(request: Request): Promise<Uint8Array> {
  const limit = accountSkillLimits.uploadBytes
  const length = declaredLength(request)
  if (length !== null && (!Number.isFinite(length) || length > limit))
    throw new SkillUploadError(413, skillUploadText.tooLarge)
  if (!request.body) throw new SkillUploadError(400, skillUploadText.empty)
  try {
    const body = await headOf(request.body, limit)
    const chunks: Uint8Array[] = []
    for await (const chunk of body.all) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    if (length !== null && bytes.byteLength !== length)
      throw new SkillUploadError(400, skillUploadText.broken)
    return bytes
  } catch (error) {
    // headOf() refuses a body longer than the limit, whatever its Content-Length said.
    if (error instanceof AttachmentUploadError)
      throw new SkillUploadError(413, skillUploadText.tooLarge)
    if (isLengthRefusal(error)) throw new SkillUploadError(400, skillUploadText.broken)
    throw error
  }
}

/** `POST /api/skills/upload`: an archive of a skill into the user's account. */
export async function uploadSkill(
  request: Request,
  deps: SkillUploadDependencies,
): Promise<Response> {
  try {
    const session = await deps.getSession(request.headers)
    if (!session) throw new SkillUploadError(401, skillUploadText.signIn)
    const userId = session.user.id
    if (!uuid.safeParse(userId).success) throw new SkillUploadError(401, skillUploadText.account)
    if (request.headers.get('origin') !== new URL(deps.appOrigin()).origin)
      throw new SkillUploadError(403, skillUploadText.origin)
    if (!(await deps.hasRequiredConsents(request.headers)))
      throw new SkillUploadError(428, CONSENT_REQUIRED_MESSAGE)
    if (!(await deps.admitUpload(userId))) throw new SkillUploadError(429, skillUploadText.tooOften)

    const url = new URL(request.url)
    const fileName = skillFileName(url.searchParams.get('name'))
    const replace = url.searchParams.get('replace') === '1'
    const bytes = await readWhole(request)
    if (bytes.byteLength === 0) throw new SkillUploadError(400, skillUploadText.empty)

    const answer = await deps.install({ userId, bytes, fileName, replace })
    return json(answer)
  } catch (error) {
    if (error instanceof SkillUploadError) return json({ message: error.message }, error.status)
    if (isDomainError(error)) {
      const text = refusalText(error.code, error.details)
      if (text !== null) return json({ message: text }, error.httpStatus)
    }
    deps.onFailure?.('skill upload failed', error)
    return json({ message: skillUploadText.failed }, 503)
  }
}
