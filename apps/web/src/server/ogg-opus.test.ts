import { describe, expect, it } from 'vitest'

import { oggOpusSeconds, splitOggOpus } from './ogg-opus'

const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let r = i << 24
  for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
  return r >>> 0
})
const crc = (page: Uint8Array) => {
  let c = 0
  page.forEach((byte, i) => {
    c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ (i >= 22 && i < 26 ? 0 : byte)) & 0xff]!) >>> 0
  })
  return c
}

/** One Ogg page of one packet (at most 255 bytes) as an encoder writes it. */
function page(body: Uint8Array, granule: bigint, sequence: number, headerType = 0): Uint8Array {
  const out = new Uint8Array(28 + body.length)
  const view = new DataView(out.buffer)
  out.set([0x4f, 0x67, 0x67, 0x53, 0, headerType])
  view.setBigInt64(6, granule, true)
  view.setUint32(14, 0x1234, true)
  view.setUint32(18, sequence, true)
  out[26] = 1
  out[27] = body.length
  out.set(body, 28)
  view.setUint32(22, crc(out), true)
  return out
}

const text = (s: string) => new TextEncoder().encode(s)

/** A voice of `seconds`: OpusHead, OpusTags, then a page per second. */
function voice(seconds: number): Uint8Array {
  const pages = [
    page(text('OpusHead\u0001\u00018\u0001\u0080»\u0000\u0000\u0000\u0000\u0000'), 0n, 0, 2),
    page(text('OpusTagsxxxx'), 0n, 1),
    ...Array.from({ length: seconds }, (_, i) =>
      page(
        new Uint8Array(40).fill(i % 255),
        BigInt((i + 1) * 48_000),
        i + 2,
        i === seconds - 1 ? 4 : 0,
      ),
    ),
  ]
  const out = new Uint8Array(pages.reduce((sum, p) => sum + p.length, 0))
  let at = 0
  for (const p of pages) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** The pages of a piece: their sequence numbers, flags and whether each checksum holds. */
function inspect(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const pages: { sequence: number; flags: number; crcOk: boolean; granule: bigint }[] = []
  let at = 0
  while (at < data.length) {
    const length = 27 + data[at + 26]! + data[at + 27]!
    const bytes = data.subarray(at, at + length)
    pages.push({
      sequence: view.getUint32(at + 18, true),
      flags: data[at + 5]!,
      crcOk: view.getUint32(at + 22, true) === crc(bytes),
      granule: view.getBigInt64(at + 6, true),
    })
    at += length
  }
  return pages
}

describe('splitOggOpus', () => {
  it('gives back a short voice as it is', () => {
    const short = voice(20)
    expect(splitOggOpus(short)).toEqual([short])
    expect(oggOpusSeconds(short)).toBe(20)
  })

  it('cuts a voice of 70 seconds into three pieces of at most 28 seconds, each a whole stream', () => {
    const pieces = splitOggOpus(voice(70))
    expect(pieces).toHaveLength(3)
    let previousEnd = 0n
    for (const piece of pieces!) {
      const pages = inspect(piece)
      // The header pages come first in every piece.
      expect(new TextDecoder().decode(piece.subarray(28, 36))).toBe('OpusHead')
      expect(pages.map((p) => p.sequence)).toEqual(pages.map((_, i) => i))
      expect(pages.every((p) => p.crcOk)).toBe(true)
      expect(pages[0]!.flags & 0x02).toBe(0x02)
      expect(pages.at(-1)!.flags & 0x04).toBe(0x04)
      const audio = pages.slice(2)
      expect(audio.at(-1)!.granule - previousEnd).toBeLessThanOrEqual(28n * 48_000n)
      previousEnd = audio.at(-1)!.granule
    }
    expect(previousEnd).toBe(70n * 48_000n)
  })

  it('refuses what is not Ogg Opus', () => {
    expect(splitOggOpus(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(oggOpusSeconds(text('OggS'))).toBeNull()
  })
})
