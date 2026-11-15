import { Transform } from 'node:stream'

import { ENV_VALUE_MASK } from '@repo/domain'

/**
 * Takes the secret values out of what a server answers (docs/plan/81, §3.2, п. 6): every whole
 * occurrence becomes the mask the platform shows for a client's variable. A value that a chunk
 * cuts in two is found across the cut: the stream holds back only the end that could be the start
 * of a value, so an event of a stream is never held for longer than that.
 */
export function maskingStream(values: readonly string[]): Transform {
  // Bytes as latin1 characters, one to one: a value is matched byte for byte, whatever the text.
  const secrets = [...new Set(values.filter((value) => value.length > 0))].map((value) =>
    Buffer.from(value, 'utf8').toString('latin1'),
  )
  const mask = Buffer.from(ENV_VALUE_MASK, 'utf8').toString('latin1')
  let rest = ''
  const replaced = (text: string) =>
    secrets.reduce((current, secret) => current.split(secret).join(mask), text)
  /** The longest end of `text` that is a start of a value but not the whole value. */
  const heldBack = (text: string) => {
    let longest = 0
    for (const secret of secrets)
      for (let size = Math.min(secret.length - 1, text.length); size > longest; size -= 1)
        if (text.endsWith(secret.slice(0, size))) {
          longest = size
          break
        }
    return longest
  }
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (secrets.length === 0) return done(null, chunk)
      const text = replaced(rest + chunk.toString('latin1'))
      const keep = heldBack(text)
      rest = text.slice(text.length - keep)
      const out = text.slice(0, text.length - keep)
      done(null, out.length > 0 ? Buffer.from(out, 'latin1') : undefined)
    },
    flush(done) {
      done(null, rest.length > 0 ? Buffer.from(replaced(rest), 'latin1') : undefined)
    },
  })
}
