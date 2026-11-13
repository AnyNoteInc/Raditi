import { describe, expect, it } from 'vitest'

import { TurnCapacity } from './turn-capacity.ts'

describe('the places for turns of the platform (plan 70, ВР17, ВР26)', () => {
  it('gives out no more places than the runners report, and each back once', () => {
    let slots = 2
    const capacity = new TurnCapacity({ slots: () => slots })
    const first = capacity.tryAcquire()!
    const second = capacity.tryAcquire()!
    expect(capacity.tryAcquire()).toBeNull()
    first()
    first()
    expect(capacity.held).toBe(1)
    expect(capacity.tryAcquire()).not.toBeNull()
    second()
    // No runner polls: no place to run a container in.
    slots = 0
    expect(capacity.size).toBe(0)
  })

  it('has no limit of its own: without runners to count, any number of turns', () => {
    const capacity = new TurnCapacity()
    for (let turn = 0; turn < 1_000; turn++) expect(capacity.tryAcquire()).not.toBeNull()
    expect(capacity.held).toBe(1_000)
  })

  it.each([
    [16, 13],
    [10, 10],
  ])(
    'runs two clients on %i places as %i turns, the second never behind the first',
    (places, running) => {
      // The limit of a workspace keeps the ninth pass of a client from its claim; only passes
      // within it ask for a place, so one client never takes the places of another beyond eight.
      const capacity = new TurnCapacity({ slots: () => places })
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
      expect(runningOf.get('a')! + runningOf.get('b')!).toBe(running)
      expect(runningOf.get('a')).toBe(workspaceLimit)
      expect(runningOf.get('b')).toBe(Math.min(5, places - 8))
    },
  )
})
