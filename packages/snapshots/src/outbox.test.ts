import { Buffer } from 'node:buffer'
import { zstdCompressSync } from 'node:zlib'

import { outboxLimits, type ExecHandle, type ExecSpec, type Sandbox } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { readOutboxArchive } from './outbox.ts'
import { SandboxSnapshotTransport } from './sandbox-snapshot.ts'

type Entry = { name: string; body?: string | Buffer; type?: 'file' | 'directory'; mode?: number }

/** Plain ustar as GNU tar writes it: a UTF-8 name stays raw in its field, no PAX header. */
function ustar(entries: Entry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.type === 'directory' ? '' : (entry.body ?? ''))
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100, 'utf8')
    header.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100, 'ascii')
    header.write('0000000\0', 108, 'ascii')
    header.write('0000000\0', 116, 'ascii')
    header.write(`${body.byteLength.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
    header.write('00000000000\0', 136, 'ascii')
    header.write(entry.type === 'directory' ? '5' : '0', 156, 'ascii')
    header.write('ustar\0', 257, 'latin1')
    header.write('00', 263, 'ascii')
    header.fill(32, 148, 156)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    blocks.push(header, body, Buffer.alloc((512 - (body.byteLength % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

const archive = async (entries: Entry[]): Promise<Uint8Array> => zstdCompressSync(ustar(entries))

function handle(stdout: Uint8Array, code = 0): ExecHandle {
  return {
    id: 'exec-1',
    async *output() {
      if (stdout.byteLength) yield { stream: 'stdout', offset: 0, data: stdout }
    },
    wait: async () => ({ code, reason: 'exited' }),
    kill: vi.fn().mockResolvedValue(undefined),
  }
}

/** A sandbox whose SANDBOX_OUT lists `listing` and archives into `tarred`. */
function sandboxWith(listing: string | null, tarred: Uint8Array = new Uint8Array()) {
  const calls: Array<{ argv: string[]; stdin: string }> = []
  const exec = vi.fn(async (spec: ExecSpec) => {
    const chunks: Buffer[] = []
    if (spec.stdin) for await (const chunk of spec.stdin) chunks.push(Buffer.from(chunk))
    calls.push({ argv: spec.argv, stdin: Buffer.concat(chunks).toString() })
    if (spec.argv[0] === 'test')
      return handle(new Uint8Array(), spec.argv[1] === '-L' || listing === null ? 1 : 0)
    if (spec.argv[0] === 'find') return handle(Buffer.from(listing ?? ''))
    if (spec.argv[0] === 'tar') return handle(tarred)
    throw new Error(`unexpected ${spec.argv.join(' ')}`)
  })
  return { sandbox: { exec } as unknown as Sandbox, calls }
}

describe('readOutboxArchive', () => {
  it('returns the files in archive order and hands each over in full', async () => {
    const bytes = await archive([
      { name: 'Отчёт.docx', body: 'docx' },
      { name: 'data.xlsx', body: Buffer.alloc(3000, 7) },
    ])
    const seen: string[] = []
    const entries = await readOutboxArchive(bytes, {
      onFile: async (file) => {
        seen.push(`${file.name}:${file.bytes.byteLength}`)
      },
    })
    expect(entries).toEqual([
      { name: 'Отчёт.docx', sizeBytes: 4 },
      { name: 'data.xlsx', sizeBytes: 3000 },
    ])
    expect(seen).toEqual(['Отчёт.docx:4', 'data.xlsx:3000'])
  })

  it('refuses folders, nested names, setuid bits and two files of one name', async () => {
    for (const entries of [
      [{ name: 'dir', type: 'directory' as const }],
      [{ name: 'dir/a.txt', body: 'x' }],
      [{ name: 'a.sh', body: 'x', mode: 0o4755 }],
      [
        { name: 'a.txt', body: 'x' },
        { name: 'a.txt', body: 'y' },
      ],
    ])
      await expect(readOutboxArchive(await archive(entries))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
  })

  it('refuses more than ten files and an archive above its limit', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, body: 'x' }))
    await expect(readOutboxArchive(await archive(eleven))).rejects.toMatchObject({
      httpStatus: 413,
    })
    await expect(
      readOutboxArchive(new Uint8Array(outboxLimits.archiveBytes + 1)),
    ).rejects.toMatchObject({ httpStatus: 413 })
  })

  it('refuses a refused value in a body or a name, and gives no file of it', async () => {
    const key = 'synthetic-turn-key-0123456789'
    const onFile = vi.fn(async () => {})
    for (const entries of [[{ name: 'a.txt', body: `k=${key}` }], [{ name: `${key}.txt` }]])
      await expect(
        readOutboxArchive(await archive(entries), { refused: [key], onFile }),
      ).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_WRITTEN' })
    expect(onFile).not.toHaveBeenCalled()
  })

  it('passes an error of the caller through as it is', async () => {
    const failure = new Error('storage is down')
    await expect(
      readOutboxArchive(await archive([{ name: 'a.txt', body: 'x' }]), {
        onFile: async () => {
          throw failure
        },
      }),
    ).rejects.toBe(failure)
  })
})

describe('SandboxSnapshotTransport.captureOutbox', () => {
  const transport = new SandboxSnapshotTransport()

  it('takes nothing when the folder is missing or empty', async () => {
    expect(await transport.captureOutbox(sandboxWith(null).sandbox)).toEqual({
      files: 0,
      skipped: 0,
    })
    const empty = sandboxWith('')
    expect(await transport.captureOutbox(empty.sandbox)).toEqual({ files: 0, skipped: 0 })
    expect(empty.calls.some(({ argv }) => argv[0] === 'tar')).toBe(false)
  })

  it('archives only the regular files right in the folder, with plain modes', async () => {
    const tarred = await archive([
      { name: 'Смета.xlsx', body: 'x' },
      { name: 'a b.txt', body: 'y' },
    ])
    const fake = sandboxWith(
      ['f 1 Смета.xlsx', 'd 4096 nested', 'l 5 link', 'f 1 a b.txt', `f 1 ${'я'.repeat(60)}`]
        .map((record) => `${record}\0`)
        .join(''),
      tarred,
    )
    const captured = await transport.captureOutbox(fake.sandbox)
    expect(captured).toEqual({ archive: tarred, files: 2, skipped: 3 })
    const tar = fake.calls.find(({ argv }) => argv[0] === 'tar')!
    expect(tar.stdin).toBe('Смета.xlsx\0a b.txt\0')
    expect(tar.argv).toEqual(
      expect.arrayContaining([
        '--format=ustar',
        '--directory=/workspace/out',
        '--no-recursion',
        '--verbatim-files-from',
        '--mode=u=rw,go=r',
      ]),
    )
    const find = fake.calls.find(({ argv }) => argv[0] === 'find')!
    expect(find.argv).toEqual(expect.arrayContaining(['-mindepth', '1', '-maxdepth', '1']))
  })

  it('refuses more than ten files and a file above 20 MiB before archiving', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `f 1 f${i}.txt\0`).join('')
    await expect(transport.captureOutbox(sandboxWith(eleven).sandbox)).rejects.toMatchObject({
      httpStatus: 413,
    })
    const big = sandboxWith(`f ${outboxLimits.fileBytes + 1} big.bin\0`)
    await expect(transport.captureOutbox(big.sandbox)).rejects.toMatchObject({ httpStatus: 413 })
    expect(big.calls.some(({ argv }) => argv[0] === 'tar')).toBe(false)
  })

  it('refuses an archive that holds a turn credential or a value of a variable', async () => {
    const key = 'synthetic-turn-key-0123456789'
    const tarred = await archive([{ name: 'a.txt', body: `token ${key}` }])
    await expect(
      transport.captureOutbox(sandboxWith('f 1 a.txt\0', tarred).sandbox, [key]),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_WRITTEN' })
    const value = 'client-secret-value-42'
    const withValue = await archive([{ name: 'a.txt', body: `v=${value}` }])
    await expect(
      transport.captureOutbox(sandboxWith('f 1 a.txt\0', withValue).sandbox, [], [value]),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_WRITTEN' })
  })

  it('refuses a folder that is a link', async () => {
    const exec = vi.fn(async (spec: ExecSpec) =>
      handle(
        new Uint8Array(),
        spec.argv[0] === 'test' && spec.argv[2] === '/workspace/out' ? 0 : 1,
      ),
    )
    await expect(transport.captureOutbox({ exec } as unknown as Sandbox)).rejects.toMatchObject({
      code: 'SANDBOX_COMMAND_FAILED',
    })
  })
})
