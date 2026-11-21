// A minimal PNG reader for screenshots (8-bit RGB or RGBA, not interlaced): the colour at a point.
import { inflateSync } from 'node:zlib'
export function pixelAt(buf, x, y) {
  let off = 8
  let w = 0, h = 0, type = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const name = buf.toString('latin1', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (name === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9] }
    if (name === 'IDAT') idat.push(data)
    off += 12 + len
  }
  const bpp = type === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * bpp
  const rows = []
  let prev = Buffer.alloc(stride)
  for (let r = 0; r < h; r++) {
    const f = raw[r * (stride + 1)]
    const line = Buffer.from(raw.subarray(r * (stride + 1) + 1, (r + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      if (f === 1) line[i] = (line[i] + a) & 255
      else if (f === 2) line[i] = (line[i] + b) & 255
      else if (f === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    }
    rows.push(line)
    prev = line
  }
  const px = Math.round(x), py = Math.round(y)
  const l = rows[py]
  return [l[px * bpp], l[px * bpp + 1], l[px * bpp + 2]]
}
