// A voice message of Telegram is Ogg Opus; SpeechKit recognises at most 30 seconds of it at once
// (docs/plan/80-telegram.md, Т11). A longer one is cut into pieces without decoding: each piece is
// the header pages of the stream (OpusHead, OpusTags) and the audio pages of its time, renumbered,
// with their checksums made again and the last one marked as the end of the stream (RFC 3533,
// RFC 7845). Cuts fall between pages: a page that continues a packet stays with the piece before.

/** Opus in Ogg counts its granule positions in 48 kHz samples (RFC 7845, §4). */
const OPUS_RATE = 48_000
/** One piece: below SpeechKit's 30 seconds with room for the last page. */
export const VOICE_PIECE_SECONDS = 28

interface Page {
  bytes: Uint8Array
  headerType: number
  granule: bigint
  /** Where the page sets its sequence number and checksum. */
  start: number
  length: number
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let r = i << 24
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
    table[i] = r >>> 0
  }
  return table
})()

/** The checksum of a page (polynomial 0x04c11db7, no reflection), its own field as zero. */
function crcOf(page: Uint8Array): number {
  let crc = 0
  for (let i = 0; i < page.length; i++) {
    const byte = i >= 22 && i < 26 ? 0 : page[i]!
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0
  }
  return crc
}

/** The pages of a stream; null — not one Ogg stream of whole pages. */
function pagesOf(data: Uint8Array): Page[] | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const pages: Page[] = []
  let at = 0
  while (at < data.length) {
    if (at + 27 > data.length) return null
    if (
      data[at] !== 0x4f ||
      data[at + 1] !== 0x67 ||
      data[at + 2] !== 0x67 ||
      data[at + 3] !== 0x53
    )
      return null
    const segments = data[at + 26]!
    if (at + 27 + segments > data.length) return null
    let body = 0
    for (let i = 0; i < segments; i++) body += data[at + 27 + i]!
    const length = 27 + segments + body
    if (at + length > data.length) return null
    pages.push({
      bytes: data.subarray(at, at + length),
      headerType: data[at + 5]!,
      granule: view.getBigInt64(at + 6, true),
      start: at,
      length,
    })
    at += length
  }
  return pages
}

/**
 * A copy of the page with its sequence number, flags and checksum set; an audio page's granule
 * position moved back by `offset`, so every piece starts at zero and lasts what it holds.
 */
function rewrite(page: Page, sequence: number, last: boolean, offset = 0n): Uint8Array {
  const out = new Uint8Array(page.bytes)
  const view = new DataView(out.buffer)
  if (offset > 0n && page.granule > 0n) view.setBigInt64(6, page.granule - offset, true)
  out[5] = (page.headerType & ~0x06) | (last ? 0x04 : 0) | (sequence === 0 ? 0x02 : 0)
  view.setUint32(18, sequence, true)
  view.setUint32(22, crcOf(out), true)
  return out
}

const isOpusHead = (page: Page) =>
  new TextDecoder().decode(page.bytes.subarray(27 + page.bytes[26]!, 35 + page.bytes[26]!)) ===
  'OpusHead'

/**
 * The stream in pieces of at most `seconds` each; null — the bytes are not an Ogg Opus stream. A
 * stream that fits one piece is given back as it is.
 */
export function splitOggOpus(data: Uint8Array, seconds = VOICE_PIECE_SECONDS): Uint8Array[] | null {
  const pages = pagesOf(data)
  if (pages === null || pages.length < 3 || !isOpusHead(pages[0]!)) return null
  // OpusTags may span pages: the header ends at the first page with a granule position.
  let firstAudio = 1
  while (firstAudio < pages.length && pages[firstAudio]!.granule === 0n) firstAudio++
  const headers = pages.slice(0, firstAudio)
  const audio = pages.slice(firstAudio)
  if (audio.length === 0) return null
  const span = BigInt(seconds * OPUS_RATE)
  const lastGranule = audio.at(-1)!.granule
  if (lastGranule <= span) return [data]

  const groups: Page[][] = []
  let group: Page[] = []
  let groupStart = 0n
  for (const page of audio) {
    const continues = (page.headerType & 0x01) !== 0
    if (group.length > 0 && page.granule - groupStart > span && !continues) {
      groups.push(group)
      groupStart = group.at(-1)!.granule
      group = []
    }
    group.push(page)
  }
  if (group.length > 0) groups.push(group)

  return groups.map((pieces, group) => {
    const all = [...headers, ...pieces]
    // Where this piece starts: the end of the one before it.
    const offset = group === 0 ? 0n : groups[group - 1]!.at(-1)!.granule
    const parts = all.map((page, index) =>
      rewrite(page, index, index === all.length - 1, index < headers.length ? 0n : offset),
    )
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
    let at = 0
    for (const part of parts) {
      out.set(part, at)
      at += part.length
    }
    return out
  })
}

/** The seconds a stream lasts by its last granule position; null — not Ogg Opus. */
export function oggOpusSeconds(data: Uint8Array): number | null {
  const pages = pagesOf(data)
  if (pages === null || pages.length === 0 || !isOpusHead(pages[0]!)) return null
  return Number(pages.at(-1)!.granule) / OPUS_RATE
}
