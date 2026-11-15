import { Readable } from 'node:stream'
import { text } from 'node:stream/consumers'

import { ENV_VALUE_MASK } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { maskingStream } from './masking.ts'

const through = (values: string[], chunks: string[]) =>
  text(Readable.from(chunks.map((chunk) => Buffer.from(chunk))).pipe(maskingStream(values)))

describe('maskingStream', () => {
  it('takes every whole value out, also across chunks', async () => {
    const secret = 'sk_live_0123456789'
    expect(await through([secret], [`a ${secret} b ${secret}`])).toBe(
      `a ${ENV_VALUE_MASK} b ${ENV_VALUE_MASK}`,
    )
    expect(await through([secret], ['key=sk_li', 've_01234', '56789;'])).toBe(
      `key=${ENV_VALUE_MASK};`,
    )
  })

  it('holds back only the end that could start a value, and gives it back when it does not', async () => {
    const stream = maskingStream(['secret-value'])
    const out: string[] = []
    stream.on('data', (chunk: Buffer) => out.push(chunk.toString()))
    stream.write(Buffer.from('event: message\ndata: {}\n\n'))
    // A whole event of a stream comes out at once: nothing of it could start the value.
    expect(out).toEqual(['event: message\ndata: {}\n\n'])
    stream.write(Buffer.from('tail secr'))
    expect(out.at(-1)).toBe('tail ')
    stream.end(Buffer.from('et'))
    await new Promise((resolve) => stream.on('end', resolve))
    expect(out.join('')).toBe('event: message\ndata: {}\n\ntail secret')
  })

  it('keeps the bytes of a text as they are', async () => {
    expect(await through(['ключ-ключ'], ['Привет, ключ-', 'ключ!'])).toBe(
      `Привет, ${ENV_VALUE_MASK}!`,
    )
    expect(await through([], ['as is'])).toBe('as is')
  })
})
