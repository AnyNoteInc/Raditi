import { describe, expect, it } from 'vitest'

import { jpegSize } from './jpeg.ts'

/** A JPEG up to its frame header: SOI, APP0 (JFIF), a fill byte, a restart marker, SOFn. */
function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]
  const frame = [0xff, sof, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3]
  const components = [1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
  const fillThenRestart = [0xff, 0xff, 0xd0]
  const soi = [0xff, 0xd8]
  const eoi = [0xff, 0xd9]
  return Uint8Array.from([...soi, ...app0, ...fillThenRestart, ...frame, ...components, ...eoi])
}

describe('the size of a screencast frame', () => {
  it('is read from the frame header, baseline or progressive', () => {
    expect(jpegSize(jpeg(1280, 800))).toEqual({ width: 1280, height: 800 })
    expect(jpegSize(jpeg(369, 800, 0xc2))).toEqual({ width: 369, height: 800 })
  })

  it('skips segments that only look like a frame header (Huffman tables)', () => {
    const tables = [0xff, 0xc4, 0x00, 0x06, 1, 2, 3, 4]
    const bytes = jpeg(640, 400)
    const withTables = Uint8Array.from([...bytes.slice(0, 2), ...tables, ...bytes.slice(2)])
    expect(jpegSize(withTables)).toEqual({ width: 640, height: 400 })
  })

  it('is none for bytes that are no JPEG, end too soon or scan before any frame header', () => {
    expect(jpegSize(new Uint8Array())).toBeNull()
    expect(jpegSize(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
    expect(jpegSize(jpeg(1280, 800).slice(0, 30))).toBeNull()
    expect(jpegSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]))).toBeNull()
    expect(jpegSize(jpeg(0, 800))).toBeNull()
  })
})
