import { z } from 'zod'

// Media of a candidate (docs/plan/53-chat-preview-release.md, Р12): the agent may only add files
// below the add-only directories of its stack, and only files that are what their name says —
// pictures, video, PDF, web fonts. Nothing a web server would run or a browser would render as a
// page: no scripts, no SVG, no server configuration, no hidden files.

export const mediaLimits = Object.freeze({
  /** One media file. */
  fileBytes: 8 * 1024 * 1024,
})

/** Bytes a file of an extension carries at an offset (a lower-case hex string). */
export const mediaSignatureSchema = z.strictObject({
  offset: z.number().int().min(0).max(64),
  hex: z.string().regex(/^(?:[0-9a-f]{2}){1,16}$/),
})
export type MediaSignature = z.infer<typeof mediaSignatureSchema>

/**
 * What a media file must be, apart from where it may go (`addOnlyPaths`). Every signature of
 * its extension must match; a name with one of `refusedNameParts` (letter case ignored) or a
 * part starting with a dot is refused at any depth below the add-only directory.
 */
export const mediaChecksSchema = z.strictObject({
  /** Lower-case extensions without the dot. */
  extensions: z.record(
    z.string().regex(/^[a-z0-9]{1,8}$/),
    z.array(mediaSignatureSchema).min(1).max(8),
  ),
  refusedNameParts: z.array(z.string().min(1).max(32)).max(32),
  maxFileBytes: z.number().int().positive().max(mediaLimits.fileBytes),
})
export type MediaChecks = z.infer<typeof mediaChecksSchema>

export type MediaProblem = 'hidden' | 'refused_name' | 'extension' | 'size' | 'signature'

/**
 * Why the file at `relative` — its path below the add-only directory — cannot be added, or null.
 * Only the name: the content is checked by mediaContentProblem. A file name is `<name>.<one
 * allowed extension>`: Apache gives a file the handler and the filter of every extension of its
 * name (mod_mime), so `x.shtml.gif` or `x.cgi.png` would be run on a hosting that maps them,
 * whatever the last one says — as WordPress itself does, a second extension is refused.
 */
export function mediaNameProblem(relative: string, checks: MediaChecks): MediaProblem | null {
  const parts = relative.split('/')
  if (parts.some((part) => part.startsWith('.'))) return 'hidden'
  const lower = relative.toLowerCase()
  if (checks.refusedNameParts.some((refused) => lower.includes(refused.toLowerCase())))
    return 'refused_name'
  const name = parts.at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  if (dot < 1) return 'extension'
  if (name.indexOf('.') !== dot) return 'refused_name'
  if (!Object.hasOwn(checks.extensions, name.slice(dot + 1).toLowerCase())) return 'extension'
  return null
}

/** Why `bytes` cannot be the file named `relative`, or null. Call after mediaNameProblem. */
export function mediaContentProblem(
  relative: string,
  bytes: Uint8Array,
  checks: MediaChecks,
): MediaProblem | null {
  if (bytes.byteLength > checks.maxFileBytes) return 'size'
  const name = relative.split('/').at(-1) ?? ''
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (!Object.hasOwn(checks.extensions, extension)) return 'extension'
  const signatures = checks.extensions[extension]!
  const matches = ({ offset, hex }: MediaSignature) => {
    if (offset + hex.length / 2 > bytes.byteLength) return false
    for (let i = 0; i < hex.length / 2; i++)
      if (bytes[offset + i] !== Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16)) return false
    return true
  }
  return signatures.every(matches) ? null : 'signature'
}
