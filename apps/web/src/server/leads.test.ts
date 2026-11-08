import { describe, expect, it, vi } from 'vitest'

import {
  handleLeadRequest,
  leadAddressHash,
  LEADS_PER_ADDRESS_PER_HOUR,
  type LeadDeps,
} from './leads'

const APP_URL = 'https://raditi.ru'
const SECRET = 'x'.repeat(48)
const NOW = new Date('2026-11-08T10:00:00Z')

const lead = {
  name: 'Анна',
  phone: '+7 900 000-00-00',
  email: 'anna@example.ru',
  site: 'kofeinya.ru',
  about: 'Обновлять цены в меню',
  consent: true,
}

function stand(options: { recent?: number } = {}) {
  const created: Record<string, unknown>[] = []
  const outbox: Record<string, unknown>[] = []
  const tx = {
    lead: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data)
        return { id: '01900000-0000-7000-8000-000000000001', number: 12 }
      }),
    },
    outboxEvent: {
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        outbox.push(...data)
        return { count: 1 }
      }),
    },
  }
  const count = vi.fn(async () => options.recent ?? 0)
  const prisma = {
    lead: { count },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as LeadDeps['prisma']
  const lines: string[] = []
  const deps: LeadDeps = {
    prisma,
    appUrl: APP_URL,
    secret: SECRET,
    captchaServerKey: null,
    now: () => NOW,
    log: (line) => lines.push(line),
  }
  return { deps, created, outbox, count, lines }
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${APP_URL}/api/leads`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: APP_URL,
      'x-forwarded-for': '203.0.113.7',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('handleLeadRequest', () => {
  it('writes the lead and its outbox row in one transaction', async () => {
    const s = stand()
    const res = await handleLeadRequest(request(lead), s.deps)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(s.created).toEqual([
      {
        name: 'Анна',
        phone: '+79000000000',
        email: 'anna@example.ru',
        site: 'kofeinya.ru',
        about: 'Обновлять цены в меню',
        consentVersion: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        source: 'landing',
        ipHash: leadAddressHash(SECRET, '203.0.113.7'),
        createdAt: NOW,
      },
    ])
    expect(s.outbox).toEqual([
      expect.objectContaining({
        topic: 'leads',
        type: 'lead.send',
        payload: { leadId: '01900000-0000-7000-8000-000000000001' },
        dedupeKey: 'lead:01900000-0000-7000-8000-000000000001:send',
      }),
    ])
    // The log names the number of the lead, never what it says.
    expect(s.lines).toEqual(['lead_created number=12'])
  })

  it('keeps no address: the hash depends on the secret', () => {
    expect(leadAddressHash(SECRET, '203.0.113.7')).toMatch(/^[0-9a-f]{64}$/)
    expect(leadAddressHash(SECRET, '203.0.113.7')).not.toBe(
      leadAddressHash('y'.repeat(48), '203.0.113.7'),
    )
  })

  it.each([
    ['no origin', { origin: '' }],
    ['another origin', { origin: 'https://evil.example' }],
  ])('refuses a lead with %s', async (_, headers) => {
    const s = stand()
    const req = request(lead, headers)
    if (headers.origin === '') req.headers.delete('origin')
    const res = await handleLeadRequest(req, s.deps)
    expect(res.status).toBe(403)
    expect(s.created).toEqual([])
  })

  it('answers with the words of the form for invalid fields', async () => {
    const s = stand()
    const res = await handleLeadRequest(request({ ...lead, phone: '1', consent: false }), s.deps)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      message: 'Проверьте поля заявки.',
      fields: { phone: 'Нужен номер из 10–15 цифр', consent: 'Без согласия мы не сможем ответить' },
    })
  })

  it('refuses a body that is not JSON', async () => {
    const res = await handleLeadRequest(request('{'), stand().deps)
    expect(res.status).toBe(400)
  })

  it('tells a robot that filled the trap field it went through, and writes nothing', async () => {
    const s = stand()
    const res = await handleLeadRequest(request({ ...lead, check: 'Bots' }), s.deps)
    expect(res.status).toBe(200)
    expect(s.created).toEqual([])
    expect(s.outbox).toEqual([])
  })

  it('stops the sixth lead of an address within an hour', async () => {
    const s = stand({ recent: LEADS_PER_ADDRESS_PER_HOUR })
    const res = await handleLeadRequest(request(lead), s.deps)
    expect(res.status).toBe(429)
    expect(s.count).toHaveBeenCalledWith({
      where: {
        ipHash: leadAddressHash(SECRET, '203.0.113.7'),
        createdAt: { gt: new Date(NOW.getTime() - 60 * 60_000) },
      },
    })
    expect(s.created).toEqual([])
  })

  describe('with the captcha on', () => {
    const withCaptcha = (
      verdict: Awaited<ReturnType<NonNullable<LeadDeps['validateCaptcha']>>>,
    ) => {
      const s = stand()
      const validateCaptcha = vi.fn(async () => verdict)
      return {
        ...s,
        validateCaptcha,
        deps: { ...s.deps, captchaServerKey: 'ysc2_key', validateCaptcha },
      }
    }

    it('asks for a token', async () => {
      const s = withCaptcha({ kind: 'pass' })
      const res = await handleLeadRequest(request(lead), s.deps)
      expect(res.status).toBe(400)
      expect(s.validateCaptcha).not.toHaveBeenCalled()
    })

    it('checks the token with the client address', async () => {
      const s = withCaptcha({ kind: 'pass' })
      const res = await handleLeadRequest(request(lead, { 'x-captcha-response': 'tok' }), s.deps)
      expect(res.status).toBe(200)
      expect(s.validateCaptcha).toHaveBeenCalledWith({
        serverKey: 'ysc2_key',
        token: 'tok',
        ip: '203.0.113.7',
      })
    })

    it('refuses a failed check', async () => {
      const s = withCaptcha({ kind: 'fail', reason: 'failed' })
      const res = await handleLeadRequest(request(lead, { 'x-captcha-response': 'tok' }), s.deps)
      expect(res.status).toBe(403)
      expect(s.created).toEqual([])
    })

    it('lets the lead through when Yandex does not answer', async () => {
      const s = withCaptcha({ kind: 'unavailable', reason: 'TimeoutError' })
      const res = await handleLeadRequest(request(lead, { 'x-captcha-response': 'tok' }), s.deps)
      expect(res.status).toBe(200)
      expect(s.created).toHaveLength(1)
    })
  })
})
