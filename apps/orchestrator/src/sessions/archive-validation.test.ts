import { Buffer } from 'node:buffer'
import { zstdCompressSync } from 'node:zlib'

import {
  envValueForms,
  isSnapshotCredential,
  snapshotLimits,
  type SessionState,
} from '@repo/domain'
import { pack, type Header } from 'tar-stream'
import { describe, expect, it } from 'vitest'

import { sampleDriverId } from '../testing/ids.ts'
import {
  validateSnapshotArchives,
  validateUntrackedArchive,
  type SnapshotArchives,
} from './archive-validation.ts'

const state: SessionState = {
  root: `/agent-home/${sampleDriverId}`,
  include: ['sessions'],
  exclude: ['sessions/private'],
}

interface Entry {
  name: string
  body?: string | Buffer
  type?: Header['type']
  linkname?: string
  mode?: number
}

async function rawTar(entries: Entry[]): Promise<Buffer> {
  const writer = pack()
  const result = (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of writer) chunks.push(Buffer.from(chunk as Uint8Array))
    return Buffer.concat(chunks)
  })()
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      writer.entry(
        {
          name: entry.name,
          type: entry.type ?? 'file',
          linkname: entry.linkname,
          mode: entry.mode ?? 0o600,
        },
        entry.body ?? '',
        (err) => (err ? reject(err) : resolve()),
      )
    })
  }
  writer.finalize()
  return result
}

const archive = async (entries: Entry[]) => zstdCompressSync(await rawTar(entries))
const parts = async (home: Uint8Array, untracked?: Uint8Array): Promise<SnapshotArchives> => ({
  home,
  untracked: untracked ?? (await archive([])),
  patch: Buffer.from('diff --git a/file b/file\n'),
})

function checksum(header: Buffer): void {
  header.fill(32, 148, 156)
  let value = 0
  for (const byte of header.subarray(0, 512)) value += byte
  header.write(`${value.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
}

const numericFields = [
  ['mode', 100, 8],
  ['uid', 108, 8],
  ['gid', 116, 8],
  ['size', 124, 12],
  ['mtime', 136, 12],
  ['checksum', 148, 8],
  ['devmajor', 329, 8],
  ['devminor', 337, 8],
] as const

describe('validateSnapshotArchives', () => {
  it('accepts USTAR directories, native session files, binary files and empty archives', async () => {
    const home = await archive([
      { name: 'sessions/', type: 'directory' },
      { name: 'sessions/run.jsonl', body: '{"event":"message"}\n' },
    ])
    const untracked = await archive([
      { name: 'media/picture.bin', body: Buffer.from([0, 255, 1, 2]) },
    ])
    const input = await parts(home, untracked)
    const owned = await validateSnapshotArchives(state, input)
    for (const name of ['home', 'untracked', 'patch'] as const) {
      const expected = Buffer.from(input[name])
      input[name].fill(0)
      expect(Buffer.from(owned[name])).toEqual(expected)
    }
    await expect(
      validateSnapshotArchives(state, await parts(await archive([]))),
    ).resolves.toBeDefined()
  })

  it('validates a lone untracked archive and returns the copy it checked', async () => {
    const input = await archive([{ name: 'new dir/file.txt', body: 'new' }])
    const expected = Buffer.from(input)
    const owned = await validateUntrackedArchive(input)
    input.fill(0)
    expect(Buffer.from(owned)).toEqual(expected)
    await expect(validateUntrackedArchive(await archive([{ name: '../escape' }]))).rejects.toThrow(
      /archive/,
    )
    await expect(
      validateUntrackedArchive(Buffer.alloc(snapshotLimits.archiveBytes + 1)),
    ).rejects.toMatchObject({ code: 'PUBLICATION_TOO_LARGE', httpStatus: 413 })
  })

  it.each([
    '../outside',
    '/etc/passwd',
    'sessions/../outside',
    'sessions//a',
    'sessions/./a',
    'sessions/a\\b',
    'sessions/a\nb',
    '.git/config',
    'sessions/.GiT/config',
    '--checkpoint-action=exec=touch',
    'C:/escape',
  ])('rejects unsafe paths: %s', async (name) => {
    const untracked = await archive([{ name }])
    await expect(
      validateSnapshotArchives(state, await parts(await archive([]), untracked)),
    ).rejects.toThrow(/archive/)
  })

  it.each([
    'link',
    'symlink',
    'character-device',
    'block-device',
    'fifo',
    'contiguous-file',
  ] as const)('rejects non-file tar entries: %s', async (type) => {
    const untracked = await archive([{ name: 'payload', type, linkname: '/run/secrets/token' }])
    await expect(
      validateSnapshotArchives(state, await parts(await archive([]), untracked)),
    ).rejects.toThrow(/archive/)
  })

  it('enforces the literal home allowlist and excludes whole subtrees', async () => {
    for (const name of [
      'auth.json',
      'sessions/private',
      'sessions/private/key',
      'sessions-other/run',
    ]) {
      await expect(
        validateSnapshotArchives(state, await parts(await archive([{ name }]))),
      ).rejects.toThrow(/archive/)
    }
    await expect(
      validateSnapshotArchives(
        state,
        await parts(await archive([{ name: 'sessions/private-ok' }])),
      ),
    ).resolves.toBeDefined()
  })

  it('allows an ancestor directory of an explicitly included file, but not its siblings', async () => {
    const narrow = { ...state, include: ['sessions/run.jsonl'] }
    await expect(
      validateSnapshotArchives(
        narrow,
        await parts(
          await archive([{ name: 'sessions/', type: 'directory' }, { name: 'sessions/run.jsonl' }]),
        ),
      ),
    ).resolves.toBeDefined()
    await expect(
      validateSnapshotArchives(narrow, await parts(await archive([{ name: 'sessions/other' }]))),
    ).rejects.toThrow(/archive/)
  })

  it('rejects duplicate paths and file/directory prefix collisions in either order', async () => {
    for (const entries of [
      [{ name: 'same' }, { name: 'same' }],
      [{ name: 'a' }, { name: 'a/b' }],
      [{ name: 'a/b' }, { name: 'a' }],
      [{ name: 'a/', type: 'directory' as const }, { name: 'a' }],
    ]) {
      await expect(
        validateSnapshotArchives(state, await parts(await archive([]), await archive(entries))),
      ).rejects.toThrow(/archive/)
    }
  })

  it('refuses extended headers rather than trusting a different PAX interpretation', async () => {
    for (const type of ['x', 'g', 'L', 'K', 'S']) {
      const raw = await rawTar([{ name: 'sessions/run' }])
      raw[156] = type.charCodeAt(0)
      checksum(raw)
      await expect(
        validateSnapshotArchives(state, await parts(zstdCompressSync(raw))),
      ).rejects.toThrow(/archive/)
    }
  })

  it('refuses hidden names after a NUL, invalid UTF-8 and privileged modes', async () => {
    const hidden = await rawTar([{ name: 'sessions/run' }])
    hidden.write('sessions/run\0../escape', 0)
    checksum(hidden)
    const invalidUtf8 = await rawTar([{ name: 'sessions/run' }])
    invalidUtf8[0] = 0xff
    checksum(invalidUtf8)
    for (const home of [
      zstdCompressSync(hidden),
      zstdCompressSync(invalidUtf8),
      await archive([{ name: 'sessions/run', mode: 0o4755 }]),
    ]) {
      await expect(validateSnapshotArchives(state, await parts(home))).rejects.toThrow(/archive/)
    }
  })

  it.each(numericFields)(
    'rejects malformed raw %s fields with a valid checksum',
    async (_, offset, length) => {
      for (const corruption of ['suffix', 'high-bit', 'hidden-digit', 'tab', 'base-256']) {
        const raw = await rawTar([{ name: 'sessions/run' }])
        // Preserve the checksum's numeric value when testing that field itself: the final
        // terminator is outside its parsed octal prefix, and checksum bytes are not summed.
        if (offset === 148) checksum(raw)
        if (corruption === 'suffix') {
          const value = Number.parseInt(raw.toString('latin1', offset, offset + length), 8)
          raw.write(value.toString(8).padStart(length - 1, '0') + 'x', offset, 'latin1')
        }
        if (corruption === 'high-bit') raw[offset] = raw[offset]! | 0x80
        if (corruption === 'hidden-digit') {
          raw[offset + length - 2] = 0
          raw[offset + length - 1] = 49
        }
        if (corruption === 'tab') raw[offset] = 9
        if (corruption === 'base-256') raw[offset] = 0x80
        if (offset !== 148) checksum(raw)
        await expect(
          validateSnapshotArchives(state, await parts(zstdCompressSync(raw))),
        ).rejects.toThrow(/archive/)
      }
    },
  )

  it('accepts GNU octal fields and space/NUL padding, including unused empty device fields', async () => {
    for (const padding of ['gnu', 'spaces']) {
      const raw = await rawTar([{ name: 'sessions/run' }])
      for (const [, offset, length] of numericFields) {
        if (offset === 148) continue
        if (offset === 329 || offset === 337) {
          raw.fill(padding === 'gnu' ? 0 : 32, offset, offset + length)
        } else {
          const value = offset === 100 ? '600' : '0'
          raw.write(
            value.padStart(length - 1, padding === 'gnu' ? '0' : ' ') + '\0',
            offset,
            'latin1',
          )
        }
      }
      checksum(raw)
      await expect(
        validateSnapshotArchives(state, await parts(zstdCompressSync(raw))),
      ).resolves.toBeDefined()
    }
  })

  it.each(Array.from({ length: 8 }, (_, index) => 257 + index))(
    'rejects high-bit aliases in raw USTAR magic/version byte %i',
    async (offset) => {
      const raw = await rawTar([{ name: 'sessions/run' }])
      raw[offset] = raw[offset]! | 0x80
      checksum(raw)
      await expect(
        validateSnapshotArchives(state, await parts(zstdCompressSync(raw))),
      ).rejects.toThrow(/archive/)
    },
  )

  it('rejects malformed/truncated zstd and tar, bad checksums and appended archives', async () => {
    const raw = await rawTar([{ name: 'sessions/run', body: 'body' }])
    const compressed = zstdCompressSync(raw)
    const corrupt = Buffer.from(raw)
    corrupt[0] = 65
    for (const home of [
      Buffer.from('not zstd'),
      compressed.subarray(0, compressed.length - 1),
      zstdCompressSync(raw.subarray(0, 600)),
      zstdCompressSync(raw.subarray(0, 1024)),
      zstdCompressSync(corrupt),
      zstdCompressSync(Buffer.concat([raw, raw])),
    ]) {
      await expect(validateSnapshotArchives(state, await parts(home))).rejects.toThrow(/archive/)
    }
  })

  it('bounds compressed data, patch bytes, file sizes, depth and entry count', async () => {
    const empty = await archive([])
    const session = { code: 'SNAPSHOT_TOO_LARGE', httpStatus: 413 }
    const changes = { code: 'PUBLICATION_TOO_LARGE', httpStatus: 413 }
    await expect(
      validateSnapshotArchives(state, {
        home: Buffer.alloc(snapshotLimits.archiveBytes + 1),
        untracked: empty,
        patch: Buffer.alloc(0),
      }),
    ).rejects.toMatchObject(session)
    await expect(
      validateSnapshotArchives(state, {
        home: empty,
        untracked: empty,
        patch: Buffer.alloc(snapshotLimits.patchBytes + 1),
      }),
    ).rejects.toMatchObject(changes)
    const hugeHeader = await rawTar([{ name: 'sessions/run' }])
    hugeHeader.write(
      `${(snapshotLimits.fileBytes + 1).toString(8).padStart(11, '0')}\0`,
      124,
      'ascii',
    )
    checksum(hugeHeader)
    await expect(
      validateSnapshotArchives(state, await parts(zstdCompressSync(hugeHeader))),
    ).rejects.toMatchObject(session)
    // Depth is a path rule, not a size: an invalid archive, not a 413.
    await expect(
      validateSnapshotArchives(
        state,
        await parts(empty, await archive([{ name: Array(33).fill('a').join('/') }])),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const many = await archive(
      Array.from({ length: snapshotLimits.entries + 1 }, (_, i) => ({ name: `file-${i}` })),
    )
    await expect(validateSnapshotArchives(state, await parts(empty, many))).rejects.toMatchObject(
      changes,
    )
  })

  // Compresses and inflates past the expansion limit: seconds of CPU on a loaded machine.
  it(
    'bounds expanded bytes even for an archive consisting only of compressible zero padding',
    {
      timeout: 30_000,
    },
    async () => {
      const bomb = zstdCompressSync(Buffer.alloc(snapshotLimits.expandedBytes + 512))
      await expect(validateSnapshotArchives(state, await parts(bomb))).rejects.toMatchObject({
        code: 'SNAPSHOT_TOO_LARGE',
      })
    },
  )
})

describe('turn credentials in a captured snapshot', () => {
  const key = 'synthetic-llm-key-0123456789'
  const refuses = async (input: SnapshotArchives) => {
    const error: unknown = await validateSnapshotArchives(state, input, ['', key]).then(
      () => undefined,
      (failure: unknown) => failure,
    )
    expect(error).toMatchObject({ code: 'SNAPSHOT_NOT_WRITTEN', httpStatus: 502 })
    expect(isSnapshotCredential(error)).toBe(true)
    // Neither the message nor the details carry the value.
    expect(JSON.stringify(error) + String(error)).not.toContain(key)
  }

  it.each<[string, () => Promise<SnapshotArchives>]>([
    [
      'a session file of the agent home',
      async () =>
        parts(await archive([{ name: 'sessions/run.jsonl', body: `{"auth":"${key}"}\n` }])),
    ],
    [
      'a new site file',
      async () =>
        parts(
          await archive([]),
          await archive([{ name: 'wp-content/leak.php', body: `<?php // ${key}\n` }]),
        ),
    ],
    [
      'a binary new file',
      async () =>
        parts(
          await archive([]),
          await archive([
            {
              name: 'media/blob.bin',
              body: Buffer.concat([Buffer.from([0, 255]), Buffer.from(key)]),
            },
          ]),
        ),
    ],
    ['a file name', async () => parts(await archive([{ name: `sessions/${key}.jsonl` }]))],
    [
      'the patch of tracked files',
      async () => ({
        ...(await parts(await archive([]))),
        patch: Buffer.from(`+define('AUTH', '${key}');\n`),
      }),
    ],
  ])('refuses %s that contains one, without the value in the error', async (_, input) => {
    await refuses(await input())
  })

  it('finds a value split between two chunks of one large file', async () => {
    // Decompressed 16 KiB at a time, the first body chunk ends 512 bytes early (the header).
    const boundary = 16 * 1024 - 512
    const body = Buffer.alloc(64 * 1024, 'x')
    body.write(key, boundary - 5)
    await refuses(await parts(await archive([{ name: 'sessions/large.jsonl', body }])))
  })

  it('accepts the same kind of archives when they hold no credential', async () => {
    const home = await archive([{ name: 'sessions/run.jsonl', body: '{"auth":"file"}\n' }])
    await expect(validateSnapshotArchives(state, await parts(home), [key])).resolves.toBeDefined()
  })

  it("refuses a client's value left in the home archive, and leaves the site's change to publication", async () => {
    // A value of the client's variables (plan 53, Р13), as the session keeps it in JSON.
    const value = 'pay-secret-0001'
    const forms = envValueForms([value])
    const home = await archive([
      { name: 'sessions/run.jsonl', body: `{"output":${JSON.stringify(value)}}\n` },
    ])
    const error: unknown = await validateSnapshotArchives(state, await parts(home), [], forms).then(
      () => undefined,
      (failure: unknown) => failure,
    )
    expect(isSnapshotCredential(error)).toBe(true)
    expect(JSON.stringify(error) + String(error)).not.toContain(value)
    // The same value in a new file of the site: the publication refuses it in words of its own.
    const site = await archive([{ name: 'wp-content/env.txt', body: value }])
    await expect(
      validateSnapshotArchives(state, await parts(await archive([]), site), [], forms),
    ).resolves.toBeDefined()
  })
})
