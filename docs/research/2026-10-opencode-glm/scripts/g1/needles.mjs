// Forms in which a credential may sit in a file, an output or a process memory: as is, JSON-escaped,
// URL-encoded, hex, UTF-16 and base64 (every alignment, standard and URL alphabet); and, when none of
// these is there, any 20 consecutive characters of it — a value cut by a log, wrapped at a line break or
// used as a part of a name. Shared by the host side (outputs, records) and the container side (files).
// Not searched: a value in another case, reversed, compressed or encrypted.

/** The part of a base64 text that is the same whatever surrounds the value. */
function base64Cores(value) {
  const cores = []
  for (const alphabet of ['base64', 'base64url'])
    for (let shift = 0; shift < 3; shift += 1) {
      const encoded = Buffer.concat([Buffer.alloc(shift, 0x41), Buffer.from(value)])
        .toString(alphabet)
        .replace(/=+$/, '')
      // The first group mixes in the bytes before the value, the last one the bytes after it.
      const core = encoded.slice(shift === 0 ? 0 : 4, encoded.length - 4)
      if (core.length >= 16) cores.push(core)
    }
  return cores
}

/** `[{ form, bytes }]` for one value; forms equal to the raw value are left out. */
export function formsOf(value) {
  const forms = [{ form: 'raw', bytes: Buffer.from(value) }]
  const add = (form, text, encoding = 'utf8') => {
    const bytes = Buffer.from(text, encoding)
    if (!forms.some((item) => item.bytes.equals(bytes))) forms.push({ form, bytes })
  }
  add('json', JSON.stringify(value).slice(1, -1))
  add('url', encodeURIComponent(value))
  add('hex', Buffer.from(value).toString('hex'))
  add('utf16le', value, 'utf16le')
  base64Cores(value).forEach((core, index) => add(`base64#${index}`, core))
  return forms
}

// Windows of 12 characters every 8: any 20 consecutive characters of a value hold one of them whole.
const WINDOW = 12
const STRIDE = 8
function hasFragment(buffer, value) {
  const bytes = Buffer.from(value)
  if (bytes.length <= WINDOW) return false
  const starts = new Set([bytes.length - WINDOW])
  for (let start = 0; start + WINDOW <= bytes.length; start += STRIDE) starts.add(start)
  for (const start of starts)
    if (buffer.includes(bytes.subarray(start, start + WINDOW))) return true
  return false
}

/**
 * Which of `needles` (`{ label: value }`) a buffer holds: `[{ label, form }]`. A value that is there in
 * no whole form but in part is reported once, as `fragment`.
 */
export function findNeedles(buffer, needles) {
  const found = []
  for (const [label, value] of Object.entries(needles)) {
    const before = found.length
    for (const { form, bytes } of formsOf(value))
      if (buffer.includes(bytes)) found.push({ label, form })
    if (found.length === before && hasFragment(buffer, value))
      found.push({ label, form: 'fragment' })
  }
  return found
}

/**
 * Throws when `text` holds one of `needles` in any form. For what leaves the stand as a record (the fake's
 * records, the sink): the message names the label and the form, never the value.
 */
export function assertNoNeedles(text, needles, what) {
  const found = findNeedles(Buffer.from(text), needles)
  if (found.length)
    throw new Error(
      `${what} holds a credential of the stand: ${found.map(({ label, form }) => `${label} (${form})`).join(', ')}`,
    )
}
