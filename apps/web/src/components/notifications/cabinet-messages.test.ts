import { notificationPushPayloadSchema } from '@repo/domain/schedule'
import { describe, expect, it, vi } from 'vitest'

import {
  browserZone,
  cabinetPathOf,
  claimZoneMark,
  navigatePathOf,
  ZONE_MARK_KEY,
} from './cabinet-messages'

const ID = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

describe('the path the service worker asks a window to go to (docs/plan/82, Зп41)', () => {
  it('is a page of the cabinet, by the rule of the domain, and never an API route', () => {
    const samples = [
      `/chats/${ID}`,
      `/scheduled/${ID}`,
      '/chats',
      '/',
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      '/chats?x=1',
      '/a b',
      '',
    ]
    for (const sample of samples)
      expect(cabinetPathOf(sample) !== null, sample).toBe(
        notificationPushPayloadSchema.shape.path.safeParse(sample).success,
      )
    expect(cabinetPathOf('/api/notifications/x')).toBeNull()
    expect(cabinetPathOf('/api')).toBeNull()
    expect(cabinetPathOf('/_next/static/x')).toBeNull()
    expect(cabinetPathOf('/apiary')).toBe('/apiary')
    expect(cabinetPathOf(`/${'a'.repeat(200)}`)).toBeNull()
  })

  it('comes only in a message of its own type', () => {
    expect(navigatePathOf({ type: 'raditi:navigate', path: `/chats/${ID}` })).toBe(`/chats/${ID}`)
    expect(navigatePathOf({ type: 'raditi:navigate', path: '//evil.example' })).toBeNull()
    expect(navigatePathOf({ type: 'other', path: '/chats' })).toBeNull()
    expect(navigatePathOf('/chats')).toBeNull()
    expect(navigatePathOf(null)).toBeNull()
  })
})

/** A storage of the session in memory; `broken` — one that throws, as in a private window. */
function storage(broken = false): Storage {
  const values = new Map<string, string>()
  const fail = () => {
    throw new DOMException('blocked', 'SecurityError')
  }
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => (broken ? fail() : (values.get(key) ?? null)),
    setItem: (key, value) => (broken ? fail() : void values.set(key, value)),
    removeItem: (key) => void values.delete(key),
  }
}

describe('the zone of the browser (Зп12)', () => {
  it('is told once a browser session, again for another user or another zone', () => {
    const session = storage()
    expect(claimZoneMark(session, 'u1', 'Asia/Novosibirsk')).toBe(true)
    expect(session.getItem(ZONE_MARK_KEY)).toBe('u1:Asia/Novosibirsk')
    expect(claimZoneMark(session, 'u1', 'Asia/Novosibirsk')).toBe(false)
    expect(claimZoneMark(session, 'u2', 'Asia/Novosibirsk')).toBe(true)
    expect(claimZoneMark(session, 'u2', 'Europe/Moscow')).toBe(true)
  })

  it('is told every time where the storage cannot be used', () => {
    expect(claimZoneMark(storage(true), 'u1', 'Europe/Moscow')).toBe(true)
    expect(claimZoneMark(null, 'u1', 'Europe/Moscow')).toBe(true)
  })

  it('is the zone Intl names, or nothing', () => {
    expect(browserZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new RangeError('no zones')
    })
    expect(browserZone()).toBeNull()
    spy.mockRestore()
  })
})
