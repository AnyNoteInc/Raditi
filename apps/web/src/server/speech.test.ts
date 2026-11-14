import { describe, expect, it, vi } from 'vitest'

import {
  recognizeSpeech,
  SPEECH_BYTES_PER_SECOND,
  SPEECH_HOURLY_LIMIT,
  SPEECH_MAX_BYTES,
  speechText,
  type SpeechDependencies,
} from './speech'

vi.mock('server-only', () => ({}))

const ORIGIN = 'https://raditi.example'

function deps(patch: Partial<SpeechDependencies> = {}) {
  const recorded: { seconds: number; outcome: string }[] = []
  const speechkit = vi.fn(async () => Response.json({ result: 'Поменяйте телефон в шапке' }))
  const all: SpeechDependencies = {
    appOrigin: () => ORIGIN,
    config: () => ({
      apiKey: 'k'.repeat(40),
      folderId: 'b1gfolder000',
      url: 'https://stt.example/recognize',
    }),
    getSession: async () => ({ user: { id: '0199a3f2-0000-7000-8000-000000000001' } }),
    hasRequiredConsents: async () => true,
    countLastHour: async () => 0,
    record: async (input) => {
      recorded.push(input)
    },
    fetch: speechkit as unknown as typeof fetch,
    ...patch,
  }
  return { all, recorded, speechkit }
}

const sound = (seconds: number) =>
  new Uint8Array(new ArrayBuffer(SPEECH_BYTES_PER_SECOND * seconds))
const post = (body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/speech`, {
    method: 'POST',
    body,
    headers: { origin: ORIGIN, 'content-length': String(body.byteLength), ...headers },
  })

describe('dictation (docs/plan/75-chat-input-output.md, ВВ16–ВВ19)', () => {
  it('gives the sound to SpeechKit in Russian, as PCM of 16 kHz, and answers its words', async () => {
    const { all, recorded, speechkit } = deps()
    const response = await recognizeSpeech(post(sound(2)), all)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ text: 'Поменяйте телефон в шапке' })
    const [url, init] = speechkit.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.searchParams.get('lang')).toBe('ru-RU')
    expect(url.searchParams.get('format')).toBe('lpcm')
    expect(url.searchParams.get('sampleRateHertz')).toBe('16000')
    expect((init.headers as Record<string, string>).authorization).toMatch(/^Api-Key /)
    expect(recorded).toEqual([{ userId: expect.any(String), seconds: 2, outcome: 'recognized' }])
  })

  it('is closed without SpeechKit, a session, the Origin of the cabinet or a declared length', async () => {
    expect((await recognizeSpeech(post(sound(1)), deps({ config: () => null }).all)).status).toBe(
      503,
    )
    expect(
      (await recognizeSpeech(post(sound(1)), deps({ getSession: async () => null }).all)).status,
    ).toBe(401)
    expect(
      (await recognizeSpeech(post(sound(1), { origin: 'https://evil.example' }), deps().all))
        .status,
    ).toBe(403)
    const unsized = new Request(`${ORIGIN}/api/speech`, {
      method: 'POST',
      body: sound(1),
      headers: { origin: ORIGIN },
    })
    // Request computes the length of a byte body itself: a body of no length is a stream.
    unsized.headers.delete('content-length')
    expect((await recognizeSpeech(unsized, deps().all)).status).toBe(411)
  })

  it('refuses more than 30 seconds and more than the limit of an hour, without asking SpeechKit', async () => {
    const long = deps()
    expect(
      (await recognizeSpeech(post(new Uint8Array(new ArrayBuffer(SPEECH_MAX_BYTES + 2))), long.all))
        .status,
    ).toBe(413)
    const busy = deps({ countLastHour: async () => SPEECH_HOURLY_LIMIT })
    const response = await recognizeSpeech(post(sound(1)), busy.all)
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ message: speechText.limit })
    expect(long.speechkit).not.toHaveBeenCalled()
    expect(busy.speechkit).not.toHaveBeenCalled()
  })

  it('says it heard nothing, and counts a refusal of SpeechKit as a failure', async () => {
    const silent = deps({ fetch: (async () => Response.json({ result: '  ' })) as typeof fetch })
    expect((await recognizeSpeech(post(sound(1)), silent.all)).status).toBe(422)
    expect(silent.recorded[0]?.outcome).toBe('empty')
    const refused = deps({
      fetch: (async () => new Response('{}', { status: 401 })) as typeof fetch,
    })
    expect((await recognizeSpeech(post(sound(1)), refused.all)).status).toBe(502)
    expect(refused.recorded[0]?.outcome).toBe('failed')
  })
})
