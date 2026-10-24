/**
 * The size in pixels of a JPEG, read from its frame header (SOFn): what a frame of the stream
 * says it is (`CloudBrowserFrame.width`, `height`). The screencast scales a frame down to fit the
 * size it was started with, so the window's size is not the image's. null for bytes that are no
 * JPEG or end before a frame header.
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let at = 2
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1] ?? 0
    // Fill bytes before a marker, and markers without a length (RSTn, TEM).
    if (marker === 0xff) {
      at += 1
      continue
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2
      continue
    }
    // Start of scan or end of image before any frame header: none to read.
    if (marker === 0xda || marker === 0xd9) return null
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)
    if (length < 2) return null
    // SOF0–SOF15 but DHT (C4), JPG (C8) and DAC (CC): precision, height, width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 8 >= bytes.length) return null
      const height = ((bytes[at + 5] ?? 0) << 8) | (bytes[at + 6] ?? 0)
      const width = ((bytes[at + 7] ?? 0) << 8) | (bytes[at + 8] ?? 0)
      return width > 0 && height > 0 ? { width, height } : null
    }
    at += 2 + length
  }
  return null
}
