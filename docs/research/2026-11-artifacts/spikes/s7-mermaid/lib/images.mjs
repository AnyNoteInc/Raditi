// PNG helpers for rough image comparison: ink share, pixel difference, thumbnail difference.
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

export const decode = (buf) => PNG.sync.read(buf)

/** Share of pixels that are not (near) white, in percent. */
export function ink(png) {
  const { data, width, height } = png
  let n = 0
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255
    const lum = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * a + 255 * (1 - a)
    if (lum < 235) n++
  }
  return +(100 * n / (width * height)).toFixed(2)
}

/** Percent of differing pixels for two images of the same size, or null if sizes differ. */
export function pixelDiff(a, b, threshold = 0.1) {
  if (a.width !== b.width || a.height !== b.height) return null
  const n = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold })
  return +(100 * n / (a.width * a.height)).toFixed(2)
}

/** Grayscale thumbnail by box averaging (default 48×48), white padding to keep the aspect ratio. */
function thumb(png, size = 48) {
  const { width, height, data } = png
  const scale = Math.max(width, height) / size
  const tw = size, th = size
  const out = new Float64Array(tw * th).fill(255)
  const cnt = new Float64Array(tw * th)
  const sum = new Float64Array(tw * th)
  const ox = (size - width / scale) / 2, oy = (size - height / scale) / 2
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tx = Math.min(tw - 1, Math.floor(x / scale + ox)), ty = Math.min(th - 1, Math.floor(y / scale + oy))
      const i = (y * width + x) * 4
      const a = data[i + 3] / 255
      const lum = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * a + 255 * (1 - a)
      sum[ty * tw + tx] += lum
      cnt[ty * tw + tx]++
    }
  }
  for (let i = 0; i < out.length; i++) if (cnt[i]) out[i] = sum[i] / cnt[i]
  return out
}

/** Rough difference of two pictures of any size: mean absolute grey difference of thumbnails, 0–100. */
export function roughDiff(a, b, size = 48) {
  const ta = thumb(a, size), tb = thumb(b, size)
  let s = 0
  for (let i = 0; i < ta.length; i++) s += Math.abs(ta[i] - tb[i])
  return +(100 * s / (ta.length * 255)).toFixed(2)
}

/** Percent of differing pixels over the common top-left area (sizes may differ by a pixel or two). */
export function pixelDiffCrop(a, b, threshold = 0.1) {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height)
  if (!w || !h) return null
  const crop = (img) => {
    const out = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) out.set(img.data.subarray(y * img.width * 4, y * img.width * 4 + w * 4), y * w * 4)
    return out
  }
  const n = pixelmatch(crop(a), crop(b), null, w, h, { threshold })
  return +(100 * n / (w * h)).toFixed(2)
}
