import { siteConnectionLimits } from '@repo/domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  noteRefusedLogin,
  passSiteConnectionGate,
  resetSiteConnectionGate,
} from './site-connection-gate.ts'

const limited = { code: 'SITE_CHECKS_LIMITED', httpStatus: 429 }
const endpoint = { host: 'files.example.ru', port: 22 }
const check = (userId: string, units = 1, endpoints = [endpoint]) =>
  passSiteConnectionGate({ userId, units, endpoints }, async () => 'checked')

/** A check that stays in flight until `finish` is called. */
function held(userId: string) {
  let finish!: () => void
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const running = passSiteConnectionGate({ userId, units: 1, endpoints: [endpoint] }, () => done)
  return { running, finish }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-17T10:00:00Z'))
  resetSiteConnectionGate()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the units of a window', () => {
  it('lets a user spend checkUnitsPerWindow units and refuses the next', async () => {
    for (let index = 0; index < siteConnectionLimits.checkUnitsPerWindow; index += 1) {
      await expect(check('anna')).resolves.toBe('checked')
    }
    await expect(check('anna')).rejects.toMatchObject(limited)
    // Another user has units of their own.
    await expect(check('boris')).resolves.toBe('checked')
  })

  it('charges create and replaceAccess two units', async () => {
    for (let index = 0; index < siteConnectionLimits.checkUnitsPerWindow / 2; index += 1) {
      await check('anna', 2)
    }
    await expect(check('anna', 1)).rejects.toMatchObject(limited)
  })

  it('gives the units back once the window has passed', async () => {
    for (let index = 0; index < siteConnectionLimits.checkUnitsPerWindow; index += 1) {
      await check('anna')
    }
    vi.advanceTimersByTime(siteConnectionLimits.checkWindowMs - 1)
    await expect(check('anna')).rejects.toMatchObject(limited)
    vi.advanceTimersByTime(1)
    await expect(check('anna')).resolves.toBe('checked')
  })

  it('does not charge a request that is refused, and does not run it', async () => {
    const run = vi.fn(async () => 'checked')
    for (let index = 0; index < siteConnectionLimits.checkUnitsPerWindow; index += 1) {
      await check('anna')
    }
    await expect(
      passSiteConnectionGate({ userId: 'anna', units: 1, endpoints: [endpoint] }, run),
    ).rejects.toMatchObject(limited)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('refused logins', () => {
  it('stops checking an endpoint after refusedLoginsPerWindow refused logins of the user', async () => {
    for (let index = 0; index < siteConnectionLimits.refusedLoginsPerWindow; index += 1) {
      noteRefusedLogin('anna', endpoint)
    }
    await expect(check('anna')).rejects.toMatchObject(limited)
    // Not the same endpoint for another port, another host or another user.
    await expect(check('anna', 1, [{ ...endpoint, port: 2222 }])).resolves.toBe('checked')
    await expect(check('anna', 1, [{ ...endpoint, host: 'other.example.ru' }])).resolves.toBe(
      'checked',
    )
    await expect(check('boris')).resolves.toBe('checked')
    // The host is compared as a name: letter case does not make another endpoint.
    await expect(
      check('anna', 1, [{ ...endpoint, host: 'FILES.example.ru' }]),
    ).rejects.toMatchObject(limited)
    // A request that names a blocked endpoint among others is refused.
    await expect(
      check('anna', 2, [{ host: 'db.example.ru', port: 3306 }, endpoint]),
    ).rejects.toMatchObject(limited)
  })

  it('counts the refused logins of one window only', async () => {
    for (let index = 0; index < siteConnectionLimits.refusedLoginsPerWindow; index += 1) {
      noteRefusedLogin('anna', endpoint)
    }
    vi.advanceTimersByTime(siteConnectionLimits.checkWindowMs)
    await expect(check('anna')).resolves.toBe('checked')
  })
})

describe('checks in flight', () => {
  it('runs at most inFlightPerUser checks of a user at once; the next waits for a place', async () => {
    const running = Array.from({ length: siteConnectionLimits.inFlightPerUser }, () => held('anna'))
    const run = vi.fn(async () => 'checked')
    const waiting = passSiteConnectionGate({ userId: 'anna', units: 1, endpoints: [endpoint] }, run)
    await vi.advanceTimersByTimeAsync(siteConnectionLimits.gateWaitMs - 1)
    expect(run).not.toHaveBeenCalled()
    // Another user is not held up.
    await expect(check('boris')).resolves.toBe('checked')

    running[0]!.finish()
    await expect(waiting).resolves.toBe('checked')
    for (const { finish, running: done } of running) {
      finish()
      await done
    }
  })

  it('refuses a check that waited gateWaitMs without a place, and charges it nothing', async () => {
    const running = Array.from({ length: siteConnectionLimits.inFlightPerUser }, () => held('anna'))
    const waiting = check('anna')
    const refused = expect(waiting).rejects.toMatchObject(limited)
    await vi.advanceTimersByTimeAsync(siteConnectionLimits.gateWaitMs)
    await refused
    for (const { finish, running: done } of running) {
      finish()
      await done
    }
    // Two units went to the checks that ran; the refused one cost nothing.
    for (let index = 2; index < siteConnectionLimits.checkUnitsPerWindow; index += 1) {
      await check('anna')
    }
    await expect(check('anna')).rejects.toMatchObject(limited)
  })

  it('runs at most inFlightPerProcess checks of all users at once', async () => {
    const running = Array.from({ length: siteConnectionLimits.inFlightPerProcess }, (_, index) =>
      held(`user-${index}`),
    )
    const waiting = check('another')
    const refused = expect(waiting).rejects.toMatchObject(limited)
    await vi.advanceTimersByTimeAsync(siteConnectionLimits.gateWaitMs)
    await refused
    for (const { finish, running: done } of running) {
      finish()
      await done
    }
    await expect(check('another')).resolves.toBe('checked')
  })

  it('frees the place of a check that failed', async () => {
    for (let index = 0; index < siteConnectionLimits.inFlightPerUser + 1; index += 1) {
      await expect(
        passSiteConnectionGate({ userId: 'anna', units: 1, endpoints: [endpoint] }, async () => {
          throw new Error('broken')
        }),
      ).rejects.toThrow('broken')
    }
    await expect(check('anna')).resolves.toBe('checked')
  })
})
