import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import {
  AVATAR_SIDE,
  MAX_AVATAR_BYTES,
  MAX_AVATAR_PIXELS,
  MAX_WAITING_AVATARS,
  normalizeAvatar,
} from './avatar-image'

const raster = (width = 12, height = 8) =>
  sharp({ create: { width, height, channels: 4, background: '#ff6820' } })

/** A baseline JPEG whose scan header ends its spectral selection at 0: decoders only warn. */
function withNonStandardScanHeader(jpeg: Buffer): Buffer<ArrayBuffer> {
  const patched = Buffer.from(jpeg)
  for (let offset = 2; ;) {
    const length = patched.readUInt16BE(offset + 2)
    if (patched[offset + 1] === 0xda) {
      patched[offset + length] = 0
      return patched
    }
    offset += 2 + length
  }
}

describe('normalizeAvatar', () => {
  it.each(['jpeg', 'png', 'webp'] as const)(
    'fully decodes a real %s and returns safe WebP',
    async (format) => {
      const source = await raster().toFormat(format).toBuffer()
      const output = await normalizeAvatar(new File([source], 'photo', { type: `image/${format}` }))
      const metadata = await sharp(output).metadata()
      expect(metadata.format).toBe('webp')
      expect(metadata.width).toBe(12)
      expect(metadata.height).toBe(8)
      expect(metadata.exif).toBeUndefined()
      expect(metadata.icc).toBeUndefined()
    },
  )

  it('resizes larger photographs and strips private metadata', async () => {
    const source = await raster(1800, 900)
      .jpeg()
      .withExif({ IFD0: { Artist: 'Private author' } })
      .toBuffer()
    const output = await normalizeAvatar(new File([source], 'photo.jpg', { type: 'image/jpeg' }))
    const metadata = await sharp(output).metadata()
    expect(metadata.width).toBe(AVATAR_SIDE)
    expect(metadata.height).toBe(AVATAR_SIDE / 2)
    expect(metadata.exif).toBeUndefined()
  })

  it('rejects SVG and HTML even when they claim to be raster images', async () => {
    for (const body of [
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      '<html><script>bad()</script></html>',
    ]) {
      await expect(
        normalizeAvatar(new File([body], 'photo.png', { type: 'image/png' })),
      ).rejects.toMatchObject({ status: 415 })
    }
    await expect(
      normalizeAvatar(new File(['<svg/>'], 'photo.svg', { type: 'image/svg+xml' })),
    ).rejects.toMatchObject({ status: 415 })
  })

  it('rejects a MIME mismatch and a truncated image with plausible magic bytes', async () => {
    const png = await raster().png().toBuffer()
    await expect(
      normalizeAvatar(new File([png], 'photo.jpg', { type: 'image/jpeg' })),
    ).rejects.toMatchObject({ status: 415 })
    await expect(
      normalizeAvatar(new File([png.subarray(0, 40)], 'broken.png', { type: 'image/png' })),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('accepts a JPEG the decoder only warns about and still rejects a truncated one', async () => {
    const jpeg = await raster(640, 480).jpeg().toBuffer()
    const output = await normalizeAvatar(
      new File([withNonStandardScanHeader(jpeg)], 'camera.jpg', { type: 'image/jpeg' }),
    )
    expect((await sharp(output).metadata()).width).toBe(AVATAR_SIDE)
    await expect(
      normalizeAvatar(
        new File([jpeg.subarray(0, jpeg.length >> 1)], 'cut.jpg', { type: 'image/jpeg' }),
      ),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('rejects empty and oversized files before decoding', async () => {
    await expect(
      normalizeAvatar(new File([], 'empty.png', { type: 'image/png' })),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      normalizeAvatar(
        new File([new Uint8Array(MAX_AVATAR_BYTES + 1)], 'large.png', { type: 'image/png' }),
      ),
    ).rejects.toMatchObject({ status: 413 })
    await expect(normalizeAvatar('file-name.png')).rejects.toMatchObject({ status: 400 })
  })

  it('rejects small compressed files that expand beyond the pixel limit', async () => {
    const side = Math.ceil(Math.sqrt(MAX_AVATAR_PIXELS))
    const source = await raster(side, side).png().toBuffer()
    expect(source.byteLength).toBeLessThan(MAX_AVATAR_BYTES)
    await expect(
      normalizeAvatar(new File([source], 'large-pixels.png', { type: 'image/png' })),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('rejects animated WebP rather than silently keeping only its first frame', async () => {
    const pixels = new Uint8Array(8 * 16 * 3).fill(255)
    pixels.fill(0, pixels.byteLength / 2)
    const source = await sharp(pixels, {
      raw: { width: 8, height: 16, pageHeight: 8, channels: 3 },
    })
      .webp({ delay: [100, 100] })
      .toBuffer()
    expect((await sharp(source).metadata()).pages).toBe(2)
    await expect(
      normalizeAvatar(new File([source], 'animated.webp', { type: 'image/webp' })),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('decodes one image at a time on one thread and refuses uploads beyond a short queue', async () => {
    expect(sharp.concurrency()).toBe(1)
    const source = await raster(1600, 1600).png().toBuffer()
    const broken = source.subarray(0, source.length >> 1)
    let busiest = 0
    let running = true
    const watch = (async () => {
      while (running) {
        // Pipelines inside the thread pool; the queued count moves on another thread.
        busiest = Math.max(busiest, sharp.counters().process)
        await new Promise((resolve) => setImmediate(resolve))
      }
    })()

    // The first, broken image must hand its slot on when it fails.
    const results = await Promise.allSettled(
      [broken, ...Array<typeof source>(MAX_WAITING_AVATARS + 2).fill(source)].map((bytes) =>
        normalizeAvatar(new File([bytes], 'photo.png', { type: 'image/png' })),
      ),
    )
    running = false
    await watch

    expect(results[0]).toMatchObject({ status: 'rejected', reason: { status: 400 } })
    for (const result of results.slice(1, MAX_WAITING_AVATARS + 1))
      expect(result.status).toBe('fulfilled')
    for (const result of results.slice(MAX_WAITING_AVATARS + 1))
      expect(result).toMatchObject({ status: 'rejected', reason: { status: 503 } })
    expect(busiest).toBe(1)
    // The slot is free again afterwards.
    await expect(
      normalizeAvatar(new File([source], 'photo.png', { type: 'image/png' })),
    ).resolves.toBeInstanceOf(Uint8Array)
  })
})
