import { describe, expect, it } from 'vitest'

import { DICTATION_MAX_SECONDS, toPcm16 } from './dictation'

describe('the sound of a dictation (docs/plan/75, ВВ16)', () => {
  it('becomes 16-bit PCM at 16 kHz, from the rate the browser recorded at', () => {
    const second = new Float32Array(48_000).fill(0.5)
    const pcm = new DataView(toPcm16([second], 48_000))
    expect(pcm.byteLength).toBe(16_000 * 2)
    expect(pcm.getInt16(0, true)).toBe(Math.floor(0.5 * 0x7fff))
  })

  it('keeps no more than 30 seconds, and clamps what is too loud', () => {
    const long = new Float32Array(16_000 * (DICTATION_MAX_SECONDS + 5)).fill(2)
    const pcm = new DataView(toPcm16([long], 16_000))
    expect(pcm.byteLength).toBe(16_000 * DICTATION_MAX_SECONDS * 2)
    expect(pcm.getInt16(0, true)).toBe(0x7fff)
  })
})
