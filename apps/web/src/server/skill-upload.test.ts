import { DomainError, skillInvalid, skillsTooMany } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import {
  skillFileName,
  skillUploadText,
  uploadSkill,
  type SkillUploadDependencies,
} from './skill-upload'

// «Добавить из файла» (docs/plan/97-skills.md, Нв9): the route checks the session, the Origin,
// the consents and the rate, reads the archive whole up to 10 MiB and answers in Russian.

const ORIGIN = 'http://localhost:3000'
const USER_ID = '019f1a21-1800-7f00-8abc-111111111111'
const SKILL_ID = '019f1a21-1800-7f00-8abc-222222222222'

function setup(overrides: Partial<SkillUploadDependencies> = {}) {
  const install = vi.fn<SkillUploadDependencies['install']>(async () => ({
    status: 'installed',
    skillId: SKILL_ID,
    name: 'brand-voice',
    enabled: true,
  }))
  const deps: SkillUploadDependencies = {
    appOrigin: () => ORIGIN,
    getSession: vi.fn(async () => ({ user: { id: USER_ID } })),
    hasRequiredConsents: vi.fn(async () => true),
    admitUpload: vi.fn(async () => true),
    install,
    onFailure: vi.fn(),
    ...overrides,
  }
  return { deps, install: (overrides.install as typeof install | undefined) ?? install }
}

const post = (
  body: BodyInit | null,
  {
    query = '?name=brand-voice.skill',
    origin = ORIGIN,
    headers = {} as Record<string, string>,
  } = {},
) =>
  new Request(`${ORIGIN}/api/skills/upload${query}`, {
    method: 'POST',
    headers: { origin, ...headers },
    body,
  })

describe('POST /api/skills/upload', () => {
  it('installs the archive under its file name and answers what the install did', async () => {
    const { deps, install } = setup()
    const response = await uploadSkill(post(new Uint8Array([80, 75, 3, 4])), deps)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'installed',
      skillId: SKILL_ID,
      name: 'brand-voice',
      enabled: true,
    })
    expect(install).toHaveBeenCalledExactlyOnceWith({
      userId: USER_ID,
      bytes: expect.any(Uint8Array),
      fileName: 'brand-voice.skill',
      replace: false,
    })
    expect(Buffer.from(install.mock.calls[0]![0].bytes)).toEqual(Buffer.from([80, 75, 3, 4]))
  })

  it('replaces a skill of the same name only when asked to', async () => {
    const { deps, install } = setup()
    await uploadSkill(post(new Uint8Array([1]), { query: '?name=a.zip&replace=1' }), deps)
    expect(install.mock.calls[0]![0].replace).toBe(true)
  })

  it('hands an answer «exists» to the page to ask about replacing', async () => {
    const { deps } = setup({
      install: vi.fn(async () => ({ status: 'exists' as const, name: 'x' })),
    })
    const response = await uploadSkill(post(new Uint8Array([1])), deps)
    expect(await response.json()).toEqual({ status: 'exists', name: 'x' })
  })

  it('refuses without a session, from another origin, without consents and too often', async () => {
    const cases: [Partial<SkillUploadDependencies>, { origin?: string }, number, string][] = [
      [{ getSession: async () => null }, {}, 401, skillUploadText.signIn],
      [{ getSession: async () => ({ user: { id: 'x' } }) }, {}, 401, skillUploadText.account],
      [{}, { origin: 'https://evil.example' }, 403, skillUploadText.origin],
      [
        { hasRequiredConsents: async () => false },
        {},
        428,
        'Примите обновлённые документы, чтобы продолжить',
      ],
      [{ admitUpload: async () => false }, {}, 429, skillUploadText.tooOften],
    ]
    for (const [overrides, request, status, message] of cases) {
      const { deps, install } = setup(overrides)
      const response = await uploadSkill(post(new Uint8Array([1]), request), deps)
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ message })
      expect(install).not.toHaveBeenCalled()
    }
  })

  it('refuses a body over 10 MiB, declared or not', async () => {
    const { deps, install } = setup()
    const declared = await uploadSkill(
      post(new Uint8Array([1]), { headers: { 'content-length': String(11 * 1024 * 1024) } }),
      deps,
    )
    expect(declared.status).toBe(413)

    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big.subarray(0, 5 * 1024 * 1024))
        controller.enqueue(big.subarray(5 * 1024 * 1024))
        controller.close()
      },
    })
    const streamed = await uploadSkill(
      new Request(`${ORIGIN}/api/skills/upload?name=a.zip`, {
        method: 'POST',
        headers: { origin: ORIGIN },
        body: stream,
        duplex: 'half',
      } as RequestInit),
      deps,
    )
    expect(streamed.status).toBe(413)
    expect(await streamed.json()).toEqual({ message: skillUploadText.tooLarge })
    expect(install).not.toHaveBeenCalled()
  })

  it('refuses an empty file', async () => {
    const { deps } = setup()
    const response = await uploadSkill(post(new Uint8Array(0)), deps)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ message: skillUploadText.empty })
  })

  it('tells the reason of a skill that does not fit, in Russian', async () => {
    const { deps } = setup({
      install: vi.fn(async () => {
        throw skillInvalid('no_skill_md')
      }),
    })
    const response = await uploadSkill(post(new Uint8Array([1])), deps)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      message: 'Навык не подходит: в папке навыка нет файла SKILL.md',
    })
  })

  it('tells the other refusals of skills by their texts', async () => {
    const { deps } = setup({
      install: vi.fn(async () => {
        throw skillsTooMany()
      }),
    })
    const response = await uploadSkill(post(new Uint8Array([1])), deps)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      message: 'Можно установить до 50 навыков — удалите ненужные',
    })
  })

  it('logs an unexpected failure and answers a short text', async () => {
    const failure = new Error('S3 is down')
    const { deps } = setup({
      install: vi.fn(async () => {
        throw failure
      }),
    })
    const response = await uploadSkill(post(new Uint8Array([1])), deps)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ message: skillUploadText.failed })
    expect(deps.onFailure).toHaveBeenCalledWith('skill upload failed', failure)

    const { deps: other } = setup({
      install: vi.fn(async () => {
        throw new DomainError('SOMETHING_ELSE', 'x', 409)
      }),
    })
    expect((await uploadSkill(post(new Uint8Array([1])), other)).status).toBe(503)
  })
})

describe('skillFileName', () => {
  it('keeps the last part of a printable name', () => {
    expect(skillFileName('C:\\Users\\me\\brand.skill')).toBe('brand.skill')
    expect(skillFileName('../../x.zip')).toBe('x.zip')
    expect(skillFileName('a\u0000b\u202e.zip')).toBe('ab.zip')
    expect(skillFileName(null)).toBe('skill.zip')
    expect(skillFileName('   ')).toBe('skill.zip')
    expect(skillFileName(`${'a'.repeat(300)}.zip`)).toHaveLength(255)
  })
})
