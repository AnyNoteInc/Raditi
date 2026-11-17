import { describe, expect, it } from 'vitest'

import { AppliedInputs } from './applied-inputs.ts'

describe('the inputs a frame shows (plan 85, ТР7)', () => {
  it('names the newest input taken before the frame was painted while input keeps coming', () => {
    const applied = new AppliedInputs()
    // A finger: an input every 10 ms; frames painted in between reach the viewer later.
    for (let seq = 1; seq <= 10; seq++) applied.taken(seq, 1_000 + seq * 10)
    expect(applied.shownBy(1_000)).toBeNull()
    expect(applied.shownBy(1_035)).toBe(3)
    expect(applied.shownBy(1_065)).toBe(6)
    // The slack: painted 2 ms before the answer of input 7 came, the frame shows it.
    expect(applied.shownBy(1_068)).toBe(7)
    expect(applied.shownBy(1_068)).toBeNull()
    for (let seq = 11; seq <= 12; seq++) applied.taken(seq, 1_000 + seq * 10)
    expect(applied.shownBy(1_200)).toBe(12)
    expect(applied.shownBy(1_300)).toBeNull()
  })

  it('never names an input it told already, nor one older', () => {
    const applied = new AppliedInputs()
    applied.taken(5, 100)
    expect(applied.shownBy(200)).toBe(5)
    applied.taken(5, 300)
    applied.taken(4, 310)
    expect(applied.shownBy(400)).toBeNull()
    applied.taken(6, 500)
    expect(applied.shownBy(500)).toBe(6)
  })

  it('forgets the oldest inputs past what it keeps', () => {
    const applied = new AppliedInputs()
    for (let seq = 1; seq <= 300; seq++) applied.taken(seq, seq)
    expect(applied.shownBy(1_000)).toBe(300)
  })
})
