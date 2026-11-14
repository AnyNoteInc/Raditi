import 'server-only'

import { z } from 'zod'

// Dictation into the field of a chat (docs/plan/75-chat-input-output.md, ВВ16–ВВ19). The browser
// records PCM, 16 kHz, mono, 16 bits, at most 30 seconds; this route checks the session, the
// Origin, the consents and the limit per hour, and gives the sound to Yandex SpeechKit — servers in
// Russia (rule 1) — by its synchronous recognition. The sound is never stored and never logged:
// it passes through memory, and only the length and the outcome of the call are counted.

/** 16 kHz, 16 bits, mono: 32 000 bytes a second. */
export const SPEECH_BYTES_PER_SECOND = 32_000
/** The longest dictation SpeechKit recognises synchronously, and the bytes of it. */
export const SPEECH_MAX_SECONDS = 30
export const SPEECH_MAX_BYTES = SPEECH_BYTES_PER_SECOND * SPEECH_MAX_SECONDS
/** Recognitions per user and hour (ВВ19). */
export const SPEECH_HOURLY_LIMIT = 60

export interface SpeechConfig {
  apiKey: string
  folderId: string
  /** The recognition endpoint: SpeechKit's own; a fake only outside production. */
  url: string
}

export interface SpeechDependencies {
  appOrigin: () => string
  /** null — SpeechKit is not set up here: the field has no microphone. */
  config: () => SpeechConfig | null
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>
  hasRequiredConsents: (headers: Headers) => Promise<boolean>
  /** Recognitions of the user in the last hour. */
  countLastHour: (userId: string) => Promise<number>
  record: (input: { userId: string; seconds: number; outcome: SpeechOutcome }) => Promise<void>
  fetch?: typeof fetch
  /** For the server log only: never the sound, never the text. */
  onFailure?: (reason: string) => void
}

export type SpeechOutcome = 'recognized' | 'empty' | 'failed'

export const speechText = Object.freeze({
  signIn: 'Войдите в аккаунт, чтобы надиктовать сообщение.',
  origin: 'Запрос отклонён. Обновите страницу и попробуйте снова.',
  consent: 'Примите обновлённые документы, чтобы продолжить',
  unavailable: 'Голосовой ввод сейчас недоступен.',
  tooLong: `Запись длиннее ${SPEECH_MAX_SECONDS} секунд. Надиктуйте короче.`,
  limit: 'Вы много диктовали за последний час. Попробуйте немного позже или напишите текстом.',
  failed: 'Не удалось распознать речь. Попробуйте ещё раз.',
  empty: 'Не удалось разобрать слова. Попробуйте сказать громче или ближе к микрофону.',
})

const answer = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

const recognition = z.object({ result: z.string().max(5000) })

/** `POST /api/speech`: the sound in the body, the words in the answer as `{ text }`. */
export async function recognizeSpeech(
  request: Request,
  deps: SpeechDependencies,
): Promise<Response> {
  const config = deps.config()
  if (config === null) return answer(503, { message: speechText.unavailable })
  if (request.headers.get('origin') !== new URL(deps.appOrigin()).origin)
    return answer(403, { message: speechText.origin })
  const session = await deps.getSession(request.headers)
  if (!session) return answer(401, { message: speechText.signIn })
  if (!(await deps.hasRequiredConsents(request.headers)))
    return answer(403, { message: speechText.consent })
  // The length is declared before the body is read: a body of no declared length is not taken.
  const length = request.headers.get('content-length')
  if (length === null || !/^\d+$/.test(length)) return answer(411, { message: speechText.failed })
  if (Number(length) > SPEECH_MAX_BYTES) return answer(413, { message: speechText.tooLong })
  if ((await deps.countLastHour(session.user.id)) >= SPEECH_HOURLY_LIMIT)
    return answer(429, { message: speechText.limit })

  const sound = new Uint8Array(await request.arrayBuffer())
  if (sound.byteLength > SPEECH_MAX_BYTES) return answer(413, { message: speechText.tooLong })
  // A sample is two bytes: half a sample is not sound.
  if (sound.byteLength < SPEECH_BYTES_PER_SECOND / 10 || sound.byteLength % 2 !== 0)
    return answer(400, { message: speechText.empty })
  const seconds = Math.ceil(sound.byteLength / SPEECH_BYTES_PER_SECOND)

  const url = new URL(config.url)
  url.searchParams.set('lang', 'ru-RU')
  url.searchParams.set('format', 'lpcm')
  url.searchParams.set('sampleRateHertz', '16000')
  url.searchParams.set('folderId', config.folderId)
  const userId = session.user.id
  let response: Response
  try {
    response = await (deps.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { authorization: `Api-Key ${config.apiKey}` },
      body: sound,
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    deps.onFailure?.(`speech_fetch_failed ${error instanceof Error ? error.name : 'unknown'}`)
    await deps.record({ userId, seconds, outcome: 'failed' })
    return answer(502, { message: speechText.failed })
  }
  if (!response.ok) {
    deps.onFailure?.(`speech_refused status=${response.status}`)
    await deps.record({ userId, seconds, outcome: 'failed' })
    return answer(502, { message: speechText.failed })
  }
  const parsed = recognition.safeParse(await response.json().catch(() => null))
  const text = parsed.success ? parsed.data.result.trim() : ''
  await deps.record({ userId, seconds, outcome: text === '' ? 'empty' : 'recognized' })
  if (text === '') return answer(422, { message: speechText.empty })
  return answer(200, { text })
}
