import { describe, expect, it } from 'vitest'

import { TurnCapacity } from './turn-capacity.ts'

describe('the places for turns of the platform (plan 70, ВР17)', () => {
  it('gives out no more places than its limit, and each back once', () => {
    const capacity = new TurnCapacity(2)
    const first = capacity.tryAcquire()!
    const second = capacity.tryAcquire()!
    expect(capacity.tryAcquire()).toBeNull()
    first()
    first()
    expect(capacity.held).toBe(1)
    expect(capacity.tryAcquire()).not.toBeNull()
    second()
  })

  it('gives no more than the places the runners report, and none without a runner', () => {
    let slots = 0
    const capacity = new TurnCapacity(8, { slots: () => slots })
    expect(capacity.tryAcquire()).toBeNull()
    slots = 1
    const one = capacity.tryAcquire()!
    expect(capacity.tryAcquire()).toBeNull()
    slots = 20
    expect(capacity.size).toBe(8)
    one()
  })

  it.each([
    [16, 16],
    [10, 10],
  ])(
    'runs two clients of eight on %i places as %i turns, the second never behind the first',
    (places, running) => {
      // The limit of a workspace keeps the ninth pass of a client from its claim; only passes
      // within it ask for a place, so one client never takes the places of another beyond eight.
      const capacity = new TurnCapacity(places)
      const workspaceLimit = 8
      const runningOf = new Map<string, number>([
        ['a', 0],
        ['b', 0],
      ])
      const order = ['a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'b', 'b', 'b', 'b', 'b']
      for (const client of order) {
        if (runningOf.get(client)! >= workspaceLimit) continue
        if (!capacity.tryAcquire()) continue
        runningOf.set(client, runningOf.get(client)! + 1)
      }
      expect(runningOf.get('a')! + runningOf.get('b')!).toBe(Math.min(running, 13))
      expect(runningOf.get('a')).toBeLessThanOrEqual(workspaceLimit)
      // With 10 places the first client takes its eight; the second still gets the other two.
      expect(runningOf.get('b')).toBe(Math.min(5, places - 8))
    },
  )

  it('refuses a limit that is no number of places', () => {
    expect(() => new TurnCapacity(0)).toThrow()
  })
})
