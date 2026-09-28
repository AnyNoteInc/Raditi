import { inflateSync } from 'node:zlib'

import { publicationLimits, publicationTooLarge, turnOutputRejected } from '@repo/domain'

// Git binary patch encoding: https://github.com/git/git/blob/master/base85.c
// Delta headers: https://github.com/git/git/blob/master/patch-delta.c
const alphabet =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~'
// A broken patch is the agent's output, never the client's input.
const invalid = () => turnOutputRejected('Invalid binary publication patch')
const tooLarge = () => publicationTooLarge('Binary publication patch exceeds its limits')

function decodeLine(line: string): Buffer {
  const code = line.charCodeAt(0)
  const size = code >= 65 && code <= 90 ? code - 64 : code >= 97 && code <= 122 ? code - 70 : 0
  if (!size || line.length !== 1 + Math.ceil(size / 4) * 5) throw invalid()
  const result = Buffer.alloc(Math.ceil(size / 4) * 4)
  for (let at = 1, output = 0; at < line.length; at += 5, output += 4) {
    let value = 0
    for (const character of line.slice(at, at + 5)) {
      const digit = alphabet.indexOf(character)
      if (digit < 0) throw invalid()
      value = value * 85 + digit
    }
    if (value > 0xffff_ffff) throw invalid()
    result.writeUInt32BE(value, output)
  }
  return result.subarray(0, size)
}

/** Bound binary inflation and delta target allocations before handing bytes to native Git. */
export function assertBinaryPatchLimits(patch: Uint8Array): void {
  const lines = Buffer.from(patch).toString('latin1').split('\n')
  let total = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== 'GIT binary patch') continue
    i += 1
    let blocks = 0
    while (i < lines.length) {
      const match = /^(literal|delta) ([0-9]+)$/.exec(lines[i]!)
      if (!match) {
        if (blocks === 0) throw invalid()
        i -= 1
        break
      }
      if (++blocks > 2) throw invalid()
      const declared = Number(match[2])
      if (!Number.isSafeInteger(declared)) throw invalid()
      if (declared > publicationLimits.fileBytes) throw tooLarge()
      const chunks: Buffer[] = []
      for (i += 1; i < lines.length && lines[i] !== ''; i += 1) chunks.push(decodeLine(lines[i]!))
      let decoded: Buffer
      try {
        decoded = inflateSync(Buffer.concat(chunks), {
          maxOutputLength: publicationLimits.fileBytes,
        })
      } catch {
        throw invalid()
      }
      if (decoded.byteLength !== declared) throw invalid()
      let output = declared
      if (match[1] === 'delta') {
        let at = 0
        const number = () => {
          let value = 0
          for (let shift = 0; shift <= 28 && at < decoded.length; shift += 7) {
            const byte = decoded[at++]!
            value += (byte & 0x7f) * 2 ** shift
            if ((byte & 0x80) === 0) return value
          }
          throw invalid()
        }
        const source = number()
        output = number()
        if (source > publicationLimits.fileBytes || output > publicationLimits.fileBytes)
          throw tooLarge()
      }
      total += output
      if (total > publicationLimits.treeBytes) throw tooLarge()
      i += 1
    }
  }
}
