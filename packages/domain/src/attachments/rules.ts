import { z } from 'zod'

import { badRequest } from '../errors.ts'

/**
 * Files a customer attaches to a message (docs/plan/57-browser-tasks.md, Б26). The browser
 * announces a file (`attachment.start`), sends its bytes through web into `raditi-inbox`, web
 * checks the stored object (`ObjectStorage.stat`) and marks it `ready`; a task binds it in the
 * transaction of the message, and the browser worker reads it for a page of the site. The model
 * never gets the bytes, a key or a link. There is no presigned URL for the inbox: the bytes go
 * through web, which checks the session, the consents, the size and the first bytes.
 *
 * Pure rules only, safe in a browser: which files are taken, how the first bytes are told, how a
 * name is cleaned, where the object lies.
 */

const MIB = 1024 * 1024

export const attachmentLimits = Object.freeze({
  /** One file. */
  fileBytes: 20 * MIB,
  /** Files of one message: the limit of `feed.request.attachments`. */
  perMessage: 10,
  /** A display name as UTF-8: what a file system and a download header take. */
  nameBytes: 255,
  /** A name as the browser sends it, before cleaning. */
  rawNameLength: 1024,
  /** The first bytes sniffAttachmentType() reads; what lies past them is not looked at. */
  sniffBytes: 4096,
})

type Signature = 'jpeg' | 'png' | 'webp' | 'gif' | 'pdf' | 'zip' | 'text'

interface AttachmentTypeEntry {
  readonly mime: string
  /** Lowercase, without the dot. No two types share an extension. */
  readonly extensions: readonly string[]
  /** What the customer reads: «Изображение JPEG». */
  readonly label: string
  /** An image a page can show as one; anything else is a file to link. */
  readonly kind: 'image' | 'document'
  readonly signature: Signature
}

/** The files a customer may attach — and nothing else. */
export const attachmentTypes = Object.freeze([
  {
    mime: 'image/jpeg',
    extensions: ['jpg', 'jpeg'],
    label: 'Изображение JPEG',
    kind: 'image',
    signature: 'jpeg',
  },
  {
    mime: 'image/png',
    extensions: ['png'],
    label: 'Изображение PNG',
    kind: 'image',
    signature: 'png',
  },
  {
    mime: 'image/webp',
    extensions: ['webp'],
    label: 'Изображение WebP',
    kind: 'image',
    signature: 'webp',
  },
  {
    mime: 'image/gif',
    extensions: ['gif'],
    label: 'Изображение GIF',
    kind: 'image',
    signature: 'gif',
  },
  {
    mime: 'application/pdf',
    extensions: ['pdf'],
    label: 'Документ PDF',
    kind: 'document',
    signature: 'pdf',
  },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['docx'],
    label: 'Документ Word',
    kind: 'document',
    signature: 'zip',
  },
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['xlsx'],
    label: 'Таблица Excel',
    kind: 'document',
    signature: 'zip',
  },
  {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extensions: ['pptx'],
    label: 'Презентация PowerPoint',
    kind: 'document',
    signature: 'zip',
  },
  {
    mime: 'application/vnd.oasis.opendocument.text',
    extensions: ['odt'],
    label: 'Документ OpenDocument',
    kind: 'document',
    signature: 'zip',
  },
  {
    mime: 'application/vnd.oasis.opendocument.spreadsheet',
    extensions: ['ods'],
    label: 'Таблица OpenDocument',
    kind: 'document',
    signature: 'zip',
  },
  {
    mime: 'text/plain',
    extensions: ['txt'],
    label: 'Текстовый файл',
    kind: 'document',
    signature: 'text',
  },
  {
    mime: 'text/csv',
    extensions: ['csv'],
    label: 'Таблица CSV',
    kind: 'document',
    signature: 'text',
  },
] as const satisfies readonly AttachmentTypeEntry[])
export type AttachmentType = (typeof attachmentTypes)[number]
export type AttachmentMime = AttachmentType['mime']
export const attachmentMimeTypes: readonly AttachmentMime[] = Object.freeze(
  attachmentTypes.map((type) => type.mime),
)

/** The `accept` of a file input: the extensions and the types, comma-separated. */
export const attachmentAcceptAttribute = attachmentTypes
  .flatMap((type) => [...type.extensions.map((extension) => `.${extension}`), type.mime])
  .join(',')

// `Text/CSV; charset=utf-8` is `text/csv`: the parameters and the case are not the type.
const normalMime = (mime: string) => mime.split(';', 1)[0]!.trim().toLowerCase()

/** The listed type of a declared MIME type, or null. */
export function attachmentTypeOf(mime: string): AttachmentType | null {
  const wanted = normalMime(mime)
  return attachmentTypes.find((type) => type.mime === wanted) ?? null
}

// What a name ends with when it has an extension: a dot and up to sixteen letters or digits.
const EXTENSION = /\.([\p{L}\p{N}]{1,16})$/u

/** The extension of a name in lowercase, without the dot; null when it has none. */
export function attachmentExtension(name: string): string | null {
  return EXTENSION.exec(name)?.[1]?.toLowerCase() ?? null
}

/**
 * The listed type a name stands for, by its extension: what the page sends as the type of a
 * file. A browser's own guess (`File.type`) is not used — it differs between systems (a CSV is
 * `application/vnd.ms-excel` on Windows) and is empty for many files.
 */
export function attachmentTypeByName(name: string): AttachmentType | null {
  const extension = attachmentExtension(name)
  if (extension === null) return null
  return (
    attachmentTypes.find((type) => (type.extensions as readonly string[]).includes(extension)) ??
    null
  )
}

// ---------------------------------------------------------------------------------------------
// The first bytes
// ---------------------------------------------------------------------------------------------

/**
 * Why a file is refused, in rules this module knows:
 * - `type_not_allowed` — the type is not on the list, or the name does not end in its extension;
 * - `content_mismatch` — the first bytes are not those of a file of this type;
 * - `text_encoding` — a text file that is not UTF-8 (a NUL byte or an invalid sequence);
 * - `empty` — no bytes, or a name with nothing left after cleaning;
 * - `too_large` — over `attachmentLimits.fileBytes`;
 * - `too_many` — over `attachmentLimits.perMessage` files in one message.
 */
export const attachmentRefusals = [
  'type_not_allowed',
  'content_mismatch',
  'text_encoding',
  'empty',
  'too_large',
  'too_many',
] as const
export type AttachmentRefusal = (typeof attachmentRefusals)[number]

export type AttachmentSniff =
  | { ok: true; type: AttachmentType }
  | {
      ok: false
      reason: Extract<
        AttachmentRefusal,
        'type_not_allowed' | 'content_mismatch' | 'text_encoding' | 'empty'
      >
    }

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0))
const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  bytes.length >= at + prefix.length && prefix.every((byte, i) => bytes[at + i] === byte)

const RIFF = ascii('RIFF')
const WEBP = ascii('WEBP')
const GIF87 = ascii('GIF87a')
const GIF89 = ascii('GIF89a')
const PDF = ascii('%PDF-')
// A local file header: every OOXML and ODF document is a ZIP package.
const ZIP = [0x50, 0x4b, 0x03, 0x04]

/**
 * UTF-8 without a NUL byte. The prefix may end inside a character: a decoder in stream mode
 * keeps an unfinished sequence at the end instead of calling it invalid.
 */
function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true })
    return true
  } catch {
    return false
  }
}

const signatures: Readonly<Record<Signature, (bytes: Uint8Array) => boolean>> = {
  jpeg: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  png: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  webp: (bytes) => startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8),
  gif: (bytes) => startsWith(bytes, GIF87) || startsWith(bytes, GIF89),
  pdf: (bytes) => startsWith(bytes, PDF),
  zip: (bytes) => startsWith(bytes, ZIP),
  text: isUtf8Text,
}

/**
 * Whether the first bytes of a file are what its declared type says (at most
 * `attachmentLimits.sniffBytes` of them are read). The declared type must be listed: the bytes
 * are checked against it, never guessed. A ZIP package passes for any of the five office types —
 * the check keeps out what is plainly something else, it does not open the package.
 */
export function sniffAttachmentType(firstBytes: Uint8Array, declaredMime: string): AttachmentSniff {
  const type = attachmentTypeOf(declaredMime)
  if (type === null) return { ok: false, reason: 'type_not_allowed' }
  if (firstBytes.byteLength === 0) return { ok: false, reason: 'empty' }
  const bytes = firstBytes.subarray(0, attachmentLimits.sniffBytes)
  if (signatures[type.signature](bytes)) return { ok: true, type }
  return { ok: false, reason: type.signature === 'text' ? 'text_encoding' : 'content_mismatch' }
}

// ---------------------------------------------------------------------------------------------
// The name
// ---------------------------------------------------------------------------------------------

// Control and format characters (a right-to-left override would show `photo‮gpj.exe` as
// `photoexe.jpg`) and half of a surrogate pair, which PostgreSQL would refuse.
const invisible = /[\p{Cc}\p{Cf}\p{Cs}]/gu
// Characters other systems refuse in a file name.
const reserved = /[<>:"|?*]/gu
const separator = /[\\/]/u
const edges = /^[\s.]+|[\s.]+$/gu

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength

/** The longest start of `text` of at most `maxBytes` UTF-8 bytes, whole code points only. */
function fitBytes(text: string, maxBytes: number): string {
  let used = 0
  let end = 0
  for (const char of text) {
    used += utf8Bytes(char)
    if (used > maxBytes) break
    end += char.length
  }
  return text.slice(0, end)
}

/**
 * The name a file is shown and stored under, from the name the browser gave: the last part of a
 * path, without control, invisible or reserved characters, NFC, single spaces, no dots or spaces
 * at the ends, at most `attachmentLimits.nameBytes` bytes of UTF-8 with the extension kept.
 * null — nothing is left to call the file by.
 */
export function attachmentFileName(raw: string): string | null {
  let name = (raw.split(separator).at(-1) ?? '').replace(invisible, '').replace(reserved, '_')
  // NFC over a long run of combining marks is slow: an overlong name is cut before it.
  if (name.length > attachmentLimits.rawNameLength) {
    const extension = EXTENSION.exec(name)?.[0] ?? ''
    name =
      name.slice(0, attachmentLimits.rawNameLength - extension.length).replace(/\p{Cs}$/u, '') +
      extension
  }
  name = name.normalize('NFC').replace(/\s+/gu, ' ')
  const extension = EXTENSION.exec(name)?.[0] ?? ''
  let base = name.slice(0, name.length - extension.length).replace(edges, '')
  base = fitBytes(base, attachmentLimits.nameBytes - utf8Bytes(extension)).replace(edges, '')
  return base === '' ? null : base + extension
}

/** A name the browser sent, cleaned by attachmentFileName(); refused when nothing is left. */
export const attachmentNameSchema = z
  .string()
  .max(attachmentLimits.rawNameLength, { abort: true })
  .transform((raw, ctx) => {
    const name = attachmentFileName(raw)
    if (name === null) {
      ctx.addIssue({ code: 'custom', message: 'the file name is empty' })
      return z.NEVER
    }
    return name
  })

// ---------------------------------------------------------------------------------------------
// The object and its row
// ---------------------------------------------------------------------------------------------

/**
 * `uploading` — announced, the bytes are on their way; `ready` — stored and checked, not yet
 * sent; `bound` — sent with a message of a task; `deleted` — removed before it was sent.
 */
export const attachmentStatuses = ['uploading', 'ready', 'bound', 'deleted'] as const
export type AttachmentStatus = (typeof attachmentStatuses)[number]

/** Only a file not yet sent may be removed: a task's message keeps its files. */
export const attachmentDeletable = (status: AttachmentStatus): boolean =>
  status === 'uploading' || status === 'ready'

// Ids as PostgreSQL prints them: a key built from another spelling would name another object.
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The key of an attachment in `raditi-inbox`: `inbox/<workspaceId>/<attachmentId>`. */
export function attachmentKey(workspaceId: string, attachmentId: string): string {
  if (!ID.test(workspaceId) || !ID.test(attachmentId))
    throw badRequest('An attachment key is built from two lowercase ids')
  return `inbox/${workspaceId}/${attachmentId}`
}

/**
 * `attachment.start`: the site the file is for, the name as the browser gave it (cleaned here),
 * the size in bytes and the listed type, which must be the type of the name's extension.
 */
export const attachmentStartInputSchema = z
  .strictObject({
    siteId: z.uuid(),
    name: attachmentNameSchema,
    size: z.number().int().min(1).max(attachmentLimits.fileBytes),
    type: z.enum(attachmentMimeTypes),
  })
  .refine(
    (input) =>
      typeof input.name === 'string' && attachmentTypeByName(input.name)?.mime === input.type,
    { message: 'the extension of the name is not one of the type', path: ['name'] },
  )
export type AttachmentStartInput = z.infer<typeof attachmentStartInputSchema>
