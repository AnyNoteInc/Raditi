import { describe, expect, it } from 'vitest'

import { DICTATION_MAX_SECONDS, toPcm16, WAVE_BARS, waveLevels } from './dictation'

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

describe('the wave of a recording', () => {
  it('is quiet in silence and full where the sound is loud', () => {
    const silence = new Uint8Array(512).fill(128)
    expect(waveLevels(silence).every((level) => level === 0)).toBe(true)
    const loud = new Uint8Array(512).map((_, index) => (index % 2 === 0 ? 255 : 0))
    const levels = waveLevels(loud)
    expect(levels).toHaveLength(WAVE_BARS)
    expect(levels.every((level) => level === 1)).toBe(true)
  })
})
