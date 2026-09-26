import { Buffer } from 'node:buffer'
import { zstdCompressSync } from 'node:zlib'

import { snapshotLimits, type SessionState } from '@repo/domain'
import { pack, type Header } from 'tar-stream'
import { describe, expect, it } from 'vitest'

import { validateSnapshotArchives, type SnapshotArchives } from './archive-validation.ts'

const state: SessionState = {
  root: '/agent-home/codex',
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
    await expect(
      validateSnapshotArchives(state, await parts(home, untracked)),
    ).resolves.toBeUndefined()
    await expect(
      validateSnapshotArchives(state, await parts(await archive([]))),
    ).resolves.toBeUndefined()
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
    ).resolves.toBeUndefined()
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
    ).resolves.toBeUndefined()
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
      ).resolves.toBeUndefined()
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
    await expect(
      validateSnapshotArchives(state, {
        home: Buffer.alloc(snapshotLimits.archiveBytes + 1),
        untracked: empty,
        patch: Buffer.alloc(0),
      }),
    ).rejects.toThrow(/archive/)
    await expect(
      validateSnapshotArchives(state, {
        home: empty,
        untracked: empty,
        patch: Buffer.alloc(snapshotLimits.patchBytes + 1),
      }),
    ).rejects.toThrow(/archive/)
    const hugeHeader = await rawTar([{ name: 'sessions/run' }])
    hugeHeader.write(
      `${(snapshotLimits.fileBytes + 1).toString(8).padStart(11, '0')}\0`,
      124,
      'ascii',
    )
    checksum(hugeHeader)
    await expect(
      validateSnapshotArchives(state, await parts(zstdCompressSync(hugeHeader))),
    ).rejects.toThrow(/archive/)
    await expect(
      validateSnapshotArchives(
        state,
        await parts(empty, await archive([{ name: Array(33).fill('a').join('/') }])),
      ),
    ).rejects.toThrow(/archive/)
    const many = await archive(
      Array.from({ length: snapshotLimits.entries + 1 }, (_, i) => ({ name: `file-${i}` })),
    )
    await expect(validateSnapshotArchives(state, await parts(empty, many))).rejects.toThrow(
      /archive/,
    )
  })

  it('bounds expanded bytes even for an archive consisting only of compressible zero padding', async () => {
    const bomb = zstdCompressSync(Buffer.alloc(snapshotLimits.expandedBytes + 512))
    await expect(validateSnapshotArchives(state, await parts(bomb))).rejects.toThrow(/archive/)
  })
})
