// A small PNG reader for screenshots (8-bit RGB or RGBA, not interlaced): pixel colour checks.
import { inflateSync } from 'node:zlib'

export function decodePng(buf) {
  let p = 8
  let width = 0
  let height = 0
  let type = 0
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const kind = buf.toString('latin1', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported png')
      type = data[9]
    } else if (kind === 'IDAT') idat.push(data)
    else if (kind === 'IEND') break
    p += 12 + len
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0
  if (!bpp) throw new Error(`png colour type ${type}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0
      let v = line[x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[y * stride + x] = v & 255
    }
  }
  return {
    width,
    height,
    at(x, y) {
      const i = Math.round(y) * stride + Math.round(x) * bpp
      return [out[i], out[i + 1], out[i + 2]]
    },
  }
}

export const near = (rgb, want, tol = 24) => rgb.every((v, i) => Math.abs(v - want[i]) <= tol)
