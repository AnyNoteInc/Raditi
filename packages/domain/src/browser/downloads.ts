import { z } from 'zod'

/**
 * Files the site gives the task's browser to download — a form plugin's export of its entries,
 * a report, a list (the owner's decision of 09.11.2026, spec §20, «Данные сайта клиента»). They
 * live in the memory of the browser session alone: never in S3, Vault or a log, and gone with the
 * session (Б19); what the agent reads of one is a result of its tool and stays with the rest of
 * its session — in the encrypted snapshot of the turn (`raditi-sessions`). The agent reads one as text, part by part (`web_download`), and makes of it what
 * the client asked for — an Excel workbook in its outbox, say.
 */
export const browserDownloadLimits = Object.freeze({
  /** Downloads one session takes at all; later ones are cancelled as they start. */
  perSession: 20,
  /** Downloads read at once; one more while they run is cancelled and listed as `failed`. */
  inFlight: 2,
  /** A larger file is not kept: it is cancelled and listed as `too_large`. */
  fileBytes: 20 * 1024 * 1024,
  /** Bytes all kept files of one session hold together; past it a file is `too_large`. */
  sessionBytes: 40 * 1024 * 1024,
  /** Text of one file the agent can read, in UTF-16 code units, across all its parts. */
  textChars: 4_000_000,
  /**
   * One part of the text, in bytes of UTF-8. In the JSON of an answer a tab, a line break or a
   * quote takes two bytes: half of the answer's 64 KiB leaves room for that and for the list.
   */
  partBytes: 24 * 1024,
  /** A listing waits this long for downloads still under way. */
  settleMs: 10_000,
  /**
   * A download is read at most this long, from its start until the file is whole; one that takes
   * longer is cancelled and listed as `failed`, so that it does not hold one of the `inFlight`
   * places for the rest of the session.
   */
  readMs: 120_000,
  nameChars: 200,
})

/** How a download reads: as text, as the rows of a workbook, or not at all. */
export const browserDownloadKinds = ['text', 'workbook', 'binary', 'too_large', 'failed'] as const
export type BrowserDownloadKind = (typeof browserDownloadKinds)[number]

export const browserDownloadSchema = z.strictObject({
  /** 1 for the first download of the session; numbers never come back. */
  number: z.number().int().min(1),
  name: z.string().min(1).max(browserDownloadLimits.nameChars),
  sizeBytes: z.number().int().min(0).max(browserDownloadLimits.fileBytes),
  kind: z.enum(browserDownloadKinds),
})
export type BrowserDownload = z.infer<typeof browserDownloadSchema>

/** The text of a download as the adapter read it: a workbook as tab-separated rows by sheet. */
export interface BrowserDownloadText {
  name: string
  text: string
}

const encoder = new TextEncoder()
const bytes = (value: string) => encoder.encode(value).length

/**
 * The `part`-th piece (from 1) of a text: whole lines while they fit `partBytes` of UTF-8, a
 * longer line alone cut where it must. Pure; the same text gives the same parts.
 */
export function browserDownloadPart(
  text: string,
  part: number,
  partBytes: number = browserDownloadLimits.partBytes,
): { text: string; parts: number } {
  const parts: string[] = []
  let current = ''
  let size = 0
  const push = () => {
    parts.push(current)
    current = ''
    size = 0
  }
  for (const line of text.split(/(?<=\n)/)) {
    const length = bytes(line)
    if (size + length <= partBytes) {
      current += line
      size += length
      continue
    }
    if (size > 0) push()
    if (length <= partBytes) {
      current = line
      size = length
      continue
    }
    // A line longer than a part: cut by code points, never inside one.
    let piece = ''
    let pieceSize = 0
    for (const char of line) {
      const charSize = bytes(char)
      if (pieceSize + charSize > partBytes) {
        parts.push(piece)
        piece = ''
        pieceSize = 0
      }
      piece += char
      pieceSize += charSize
    }
    current = piece
    size = pieceSize
  }
  if (size > 0 || parts.length === 0) push()
  return { text: parts[part - 1] ?? '', parts: parts.length }
}
