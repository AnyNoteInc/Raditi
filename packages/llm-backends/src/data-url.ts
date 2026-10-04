const prefix = /^data:image\/(?:png|jpeg|webp|gif);base64,/
const alphabet = new Uint8Array(128)
for (const char of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/')
  alphabet[char.charCodeAt(0)] = 1

/**
 * An inline image of an approved type with a non-empty canonical base64 body.
 * The body is megabytes long: a quantified group overflows the regex backtracking
 * stack near 4.5 MiB, so it is checked in one pass.
 */
export function isInlineImageDataUrl(value: string): boolean {
  const start = prefix.exec(value)?.[0].length
  if (start === undefined) return false
  let end = value.length
  if (end === start || (end - start) % 4 !== 0) return false
  // Padding is one or two `=` closing the final quantum; elsewhere `=` is not in the alphabet.
  if (value.charCodeAt(end - 1) === 61) end -= value.charCodeAt(end - 2) === 61 ? 2 : 1
  for (let index = start; index < end; index++) {
    const code = value.charCodeAt(index)
    if (code > 127 || alphabet[code] !== 1) return false
  }
  return true
}
