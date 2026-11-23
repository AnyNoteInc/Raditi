import { describe, expect, it } from 'vitest'

import { parseOriEdgeLines, parseOriJournal } from './ori-ports-cli.ts'

// The collector reads the edge's access lines for the ports of facts (plan 88, 88.16а-2).

const key = '0193f8a2-6c1e-7000-8000-00000000000a'
const other = '0193f8a2-6c1e-7000-8000-00000000000b'
const line = (extra: Record<string, unknown>) =>
  JSON.stringify({
    RouterName: 'web@file',
    RequestPath: '/api/auth/sign-in/email',
    ClientHost: '203.0.113.7',
    ClientPort: '59154',
    StartUTC: '2026-11-24T10:00:00.123456789Z',
    ...extra,
  })

describe('the access lines of the edge', () => {
  it('takes each key web answered with, with the port and the time of the edge', () => {
    expect(parseOriEdgeLines(line({ 'downstream_X-Raditi-Fact': `${key},${other}` }))).toEqual([
      { edgeKey: key, port: 59154, edgeAt: new Date('2026-11-24T10:00:00.123Z') },
      { edgeKey: other, port: 59154, edgeAt: new Date('2026-11-24T10:00:00.123Z') },
    ])
  })

  it('never takes what a client sent in a request header of the same name', () => {
    expect(parseOriEdgeLines(line({ 'request_X-Raditi-Fact': key }))).toEqual([])
  })

  it('skips the log of Traefik, broken lines, bad keys and ports', () => {
    const text = [
      '{"level":"info","msg":"Configuration loaded"}',
      '{not json downstream_X-Raditi-Fact',
      line({ 'downstream_X-Raditi-Fact': 'not-a-key' }),
      line({ 'downstream_X-Raditi-Fact': key, ClientPort: '70000' }),
      line({ 'downstream_X-Raditi-Fact': key, StartUTC: 'вчера' }),
      '',
      line({ 'downstream_X-Raditi-Fact': key.toUpperCase() }),
    ].join('\n')
    expect(parseOriEdgeLines(text)).toEqual([
      { edgeKey: key, port: 59154, edgeAt: new Date('2026-11-24T10:00:00.123Z') },
    ])
  })
})

describe('the entries of journald', () => {
  const entry = (message: string, extra: Record<string, string> = {}) =>
    JSON.stringify({ CONTAINER_NAME: 'raditi-app-traefik-1', MESSAGE: message, ...extra })

  it('joins the parts Docker split a line over 16 KB into, in their order', () => {
    // A client made the line long on purpose: `<` is 6 bytes in the JSON of Go.
    const whole = line({
      'downstream_X-Raditi-Fact': key,
      'request_X-Raditi-Fact': '\\u003c'.repeat(3000),
    })
    const cut = [whole.slice(0, 8000), whole.slice(8000, 16000), whole.slice(16000)]
    const partial = (at: number, last = false) => ({
      CONTAINER_PARTIAL_MESSAGE: 'true',
      CONTAINER_PARTIAL_ID: 'p1',
      CONTAINER_PARTIAL_ORDINAL: String(at + 1),
      ...(last ? { CONTAINER_PARTIAL_LAST: 'true' } : {}),
    })
    const text = [
      entry(cut[1]!, partial(1)),
      entry(cut[0]!, partial(0)),
      entry(cut[2]!, partial(2, true)),
    ].join('\n')
    expect(parseOriJournal(text)).toEqual({
      ports: [{ edgeKey: key, port: 59154, edgeAt: new Date('2026-11-24T10:00:00.123Z') }],
      unread: 0,
    })
  })

  it('counts a line with the header it could not read, and parts without their end', () => {
    const text = [
      entry('{"downstream_X-Raditi-Fact": broken'),
      entry(line({ 'downstream_X-Raditi-Fact': key }).slice(0, 50) + 'downstream_X-Raditi-Fact', {
        CONTAINER_PARTIAL_MESSAGE: 'true',
        CONTAINER_PARTIAL_ID: 'p2',
        CONTAINER_PARTIAL_ORDINAL: '1',
      }),
      entry(line({ 'downstream_X-Raditi-Fact': other })),
    ].join('\n')
    expect(parseOriJournal(text)).toEqual({
      ports: [{ edgeKey: other, port: 59154, edgeAt: new Date('2026-11-24T10:00:00.123Z') }],
      unread: 2,
    })
  })

  it('reads a message journald gave as bytes', () => {
    const bytes = [...new TextEncoder().encode(line({ 'downstream_X-Raditi-Fact': key }))]
    expect(parseOriJournal(JSON.stringify({ MESSAGE: bytes })).ports).toHaveLength(1)
  })
})
