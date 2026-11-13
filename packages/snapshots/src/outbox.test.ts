import { Buffer } from 'node:buffer'
import { zstdCompressSync } from 'node:zlib'

import { outboxLimits, type ExecHandle, type ExecSpec, type Sandbox } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { packOutbox, readOutboxArchive } from './outbox.ts'
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
const manifestOf = (names: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, names, skipped: 0, refused: false, ...extra })
/** The files as the sandbox numbers them: the manifest first, then `0`, `1`, … */
const numbered = async (
  files: { name: string; body?: string | Buffer; mode?: number }[],
  extra: Record<string, unknown> = {},
): Promise<Uint8Array> =>
  archive([
    {
      name: 'manifest.json',
      body: manifestOf(
        files.map((file) => file.name),
        extra,
      ),
    },
    ...files.map(({ body, mode }, index) => ({ name: String(index), body, mode })),
  ])

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

const STAGE = '/workspace/.outbox.Ab3dE5gH'

/**
 * A sandbox whose SANDBOX_OUT lists `listing` and archives into `tarred`, as the sandbox's own
 * tools would: `mktemp` names a folder of links, `dd` writes the manifest, `tar` takes them.
 */
function sandboxWith(
  listing: string | null,
  tarred: Uint8Array = new Uint8Array(),
  options: { tarCode?: number } = {},
) {
  const calls: Array<{ argv: string[]; stdin: string }> = []
  const exec = vi.fn(async (spec: ExecSpec) => {
    const chunks: Buffer[] = []
    if (spec.stdin) for await (const chunk of spec.stdin) chunks.push(Buffer.from(chunk))
    calls.push({ argv: spec.argv, stdin: Buffer.concat(chunks).toString() })
    if (spec.argv[0] === 'test')
      return handle(new Uint8Array(), spec.argv[1] === '-L' || listing === null ? 1 : 0)
    if (spec.argv[0] === 'find') return handle(Buffer.from(listing ?? ''))
    if (spec.argv[0] === 'mktemp') return handle(Buffer.from(`${STAGE}\n`))
    if (spec.argv[0] === 'ln' || spec.argv[0] === 'dd' || spec.argv[0] === 'rm')
      return handle(new Uint8Array())
    if (spec.argv[0] === 'tar') return handle(tarred, options.tarCode ?? 0)
    throw new Error(`unexpected ${spec.argv.join(' ')}`)
  })
  return { sandbox: { exec } as unknown as Sandbox, calls }
}

describe('readOutboxArchive', () => {
  it('returns the files in archive order under the names of the manifest and hands each over in full', async () => {
    const bytes = await numbered([
      { name: 'Отчёт.docx', body: 'docx' },
      { name: 'data.xlsx', body: Buffer.alloc(3000, 7) },
    ])
    const seen: string[] = []
    const contents = await readOutboxArchive(bytes, {
      onFile: async (file) => {
        seen.push(`${file.name}:${file.bytes.byteLength}`)
      },
    })
    expect(contents).toEqual({
      entries: [
        { name: 'Отчёт.docx', sizeBytes: 4 },
        { name: 'data.xlsx', sizeBytes: 3000 },
      ],
      skipped: 0,
      refused: false,
    })
    expect(seen).toEqual(['Отчёт.docx:4', 'data.xlsx:3000'])
  })

  it('keeps a name longer than a ustar header holds (the chat of 11.11.2026)', async () => {
    const name = 'Руководящий_состав_правительства_Смоленской_области.docx'
    expect(Buffer.byteLength(name)).toBe(103)
    const contents = await readOutboxArchive(await packOutbox([{ name, bytes: 'docx' }]))
    expect(contents.entries).toEqual([{ name, sizeBytes: 4 }])
    const longest = 'я'.repeat(200)
    expect(
      (await readOutboxArchive(await packOutbox([{ name: longest, bytes: 'x' }]))).entries[0]!.name,
    ).toBe(longest)
  })

  it('says what the manifest says was left out', async () => {
    expect(await readOutboxArchive(await packOutbox([], { skipped: 3 }))).toEqual({
      entries: [],
      skipped: 3,
      refused: false,
    })
    expect(await readOutboxArchive(await packOutbox([], { refused: true }))).toEqual({
      entries: [],
      skipped: 0,
      refused: true,
    })
    expect(
      await readOutboxArchive(await packOutbox([{ name: 'a.txt', bytes: 'x' }], { skipped: 1 })),
    ).toEqual({ entries: [{ name: 'a.txt', sizeBytes: 1 }], skipped: 1, refused: false })
  })

  it('refuses an archive that is not a manifest and the files it numbers', async () => {
    const manifest = { name: 'manifest.json', body: manifestOf(['a.txt', 'b.txt']) }
    for (const entries of [
      // Files under their names, as before the manifest.
      [{ name: 'a.txt', body: 'x' }],
      [],
      // The manifest is not first.
      [{ name: '0', body: 'x' }, manifest],
      // Not numbered in order, or with a gap.
      [manifest, { name: '1', body: 'x' }, { name: '0', body: 'y' }],
      [manifest, { name: '0', body: 'x' }],
      // More files than names.
      [manifest, { name: '0', body: 'x' }, { name: '1', body: 'y' }, { name: '2', body: 'z' }],
      // A second manifest.
      [manifest, { name: '0', body: 'x' }, { name: 'manifest.json', body: manifest.body }],
      // Folders, nested names, setuid bits.
      [manifest, { name: '0', type: 'directory' as const }],
      [manifest, { name: 'dir/0', body: 'x' }],
      [manifest, { name: '0', body: 'x', mode: 0o4755 }, { name: '1', body: 'y' }],
    ])
      await expect(readOutboxArchive(await archive(entries))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
  })

  it('refuses a manifest that does not hold: broken, unsafe names, two of one name, too many', async () => {
    const files = [{ name: '0', body: 'x' }]
    for (const manifest of [
      '{',
      '',
      manifestOf(['../a.txt']),
      manifestOf(['a/b.txt']),
      manifestOf(['a.txt', 'a.txt']),
      manifestOf(['я'.repeat(201)]),
      manifestOf(['a.txt'], { refused: true }),
      manifestOf(['a.txt'], { skipped: -1 }),
      manifestOf(['a.txt'], { extra: 1 }),
      manifestOf(Array.from({ length: outboxLimits.files + 1 }, (_, i) => `f${i}.txt`)),
    ])
      await expect(
        readOutboxArchive(await archive([{ name: 'manifest.json', body: manifest }, ...files])),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('refuses a file above its limit and an archive above its limit', async () => {
    await expect(
      readOutboxArchive(new Uint8Array(outboxLimits.archiveBytes + 1)),
    ).rejects.toMatchObject({ httpStatus: 413 })
    const huge = zstdCompressSync(
      ustar([
        { name: 'manifest.json', body: manifestOf(['big.bin']) },
        { name: '0', body: Buffer.alloc(outboxLimits.fileBytes + 1) },
      ]),
    )
    await expect(readOutboxArchive(huge)).rejects.toMatchObject({ httpStatus: 413 })
  })

  it('refuses a refused value in a body or a name, and gives no file of it', async () => {
    const key = 'synthetic-turn-key-0123456789'
    const onFile = vi.fn(async () => {})
    for (const files of [
      [{ name: 'a.txt', body: `k=${key}` }],
      [{ name: `${key}.txt`, body: 'x' }],
      // A name that JSON spells with an escape is read raw too.
      [{ name: 'q"u.txt', body: 'x' }],
    ])
      await expect(
        readOutboxArchive(await numbered(files), {
          refused: [key, 'q"u'],
          onFile,
        }),
      ).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_WRITTEN' })
    expect(onFile).not.toHaveBeenCalled()
  })

  it('passes an error of the caller through as it is', async () => {
    const failure = new Error('storage is down')
    await expect(
      readOutboxArchive(await numbered([{ name: 'a.txt', body: 'x' }]), {
        onFile: async () => {
          throw failure
        },
      }),
    ).rejects.toBe(failure)
  })
})

describe('SandboxSnapshotTransport.captureOutbox', () => {
  const transport = new SandboxSnapshotTransport()
  const records = (...list: string[]) => list.map((record) => `${record}\0`).join('')

  it('takes nothing when the folder is missing or empty', async () => {
    expect(await transport.captureOutbox(sandboxWith(null).sandbox)).toEqual({
      files: 0,
      skipped: 0,
    })
    const empty = sandboxWith('')
    expect(await transport.captureOutbox(empty.sandbox)).toEqual({ files: 0, skipped: 0 })
    expect(empty.calls.some(({ argv }) => ['tar', 'mktemp'].includes(argv[0]!))).toBe(false)
  })

  it('archives the regular files right in the folder under their numbers, with the names in a manifest', async () => {
    const tarred = await packOutbox(
      [
        { name: 'Смета.xlsx', bytes: 'x' },
        { name: 'a b.txt', bytes: 'y' },
      ],
      { skipped: 3 },
    )
    const fake = sandboxWith(
      records(
        'f 1 Смета.xlsx',
        'd 4096 nested',
        'l 5 link',
        'f 1 a b.txt',
        `f 1 ${'я'.repeat(201)}`,
      ),
      tarred,
    )
    const captured = await transport.captureOutbox(fake.sandbox)
    expect(captured).toEqual({ archive: tarred, files: 2, skipped: 3 })
    const argvs = fake.calls.map(({ argv }) => argv)
    expect(argvs).toContainEqual([
      'mktemp',
      '--directory',
      '--tmpdir=/workspace',
      '.outbox.XXXXXXXX',
    ])
    expect(argvs).toContainEqual([
      'ln',
      '--no-target-directory',
      '--',
      '/workspace/out/Смета.xlsx',
      `${STAGE}/0`,
    ])
    expect(argvs).toContainEqual([
      'ln',
      '--no-target-directory',
      '--',
      '/workspace/out/a b.txt',
      `${STAGE}/1`,
    ])
    const dd = fake.calls.find(({ argv }) => argv[0] === 'dd')!
    expect(dd.argv).toEqual(['dd', `of=${STAGE}/manifest.json`, 'status=none'])
    expect(JSON.parse(dd.stdin)).toEqual({
      v: 1,
      names: ['Смета.xlsx', 'a b.txt'],
      skipped: 3,
      refused: false,
    })
    const tar = fake.calls.find(({ argv }) => argv[0] === 'tar')!
    expect(tar.stdin).toBe('manifest.json\0' + '0\0' + '1\0')
    expect(tar.argv).toEqual(
      expect.arrayContaining([
        '--format=ustar',
        '--hard-dereference',
        `--directory=${STAGE}`,
        '--no-recursion',
        '--verbatim-files-from',
        '--mode=u=rw,go=r',
      ]),
    )
    expect(argvs.at(-1)).toEqual(['rm', '--recursive', '--force', '--', STAGE])
    const find = fake.calls.find(({ argv }) => argv[0] === 'find')!
    expect(find.argv).toEqual(expect.arrayContaining(['-mindepth', '1', '-maxdepth', '1']))
  })

  it('takes a name of more than a hundred bytes, the one that was left in the chat of 11.11.2026', async () => {
    const name = 'Руководящий_состав_правительства_Смоленской_области.docx'
    const fake = sandboxWith(records(`f 9 ${name}`), await packOutbox([{ name, bytes: 'docx' }]))
    expect(await transport.captureOutbox(fake.sandbox)).toMatchObject({ files: 1, skipped: 0 })
  })

  it('makes an archive of the notice alone when every entry was left', async () => {
    const fake = sandboxWith(records('d 4096 nested', 'l 5 link'))
    const captured = await transport.captureOutbox(fake.sandbox)
    expect(captured).toMatchObject({ files: 0, skipped: 2 })
    expect(await readOutboxArchive(captured.archive!)).toEqual({
      entries: [],
      skipped: 2,
      refused: false,
    })
    expect(fake.calls.some(({ argv }) => ['tar', 'mktemp'].includes(argv[0]!))).toBe(false)
  })

  it('refuses more files than the limit and a file above 20 MiB before archiving', async () => {
    const tooMany = records(
      ...Array.from({ length: outboxLimits.files + 1 }, (_, i) => `f 1 f${i}.txt`),
    )
    const many = sandboxWith(tooMany)
    await expect(transport.captureOutbox(many.sandbox)).rejects.toMatchObject({ httpStatus: 413 })
    const big = sandboxWith(records(`f ${outboxLimits.fileBytes + 1} big.bin`))
    await expect(transport.captureOutbox(big.sandbox)).rejects.toMatchObject({ httpStatus: 413 })
    for (const fake of [many, big])
      expect(fake.calls.some(({ argv }) => ['tar', 'mktemp'].includes(argv[0]!))).toBe(false)
  })

  it('refuses an archive that holds a turn credential or a value of a variable', async () => {
    const key = 'synthetic-turn-key-0123456789'
    const tarred = await packOutbox([{ name: 'a.txt', bytes: `token ${key}` }])
    await expect(
      transport.captureOutbox(sandboxWith(records('f 1 a.txt'), tarred).sandbox, [key]),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_WRITTEN' })
    const value = 'client-secret-value-42'
    const withValue = await packOutbox([{ name: 'a.txt', bytes: `v=${value}` }])
    await expect(
      transport.captureOutbox(sandboxWith(records('f 1 a.txt'), withValue).sandbox, [], [value]),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_WRITTEN' })
  })

  it('removes the folder of links when the archive fails', async () => {
    const fake = sandboxWith(records('f 1 a.txt'), new Uint8Array(), { tarCode: 2 })
    await expect(transport.captureOutbox(fake.sandbox)).rejects.toMatchObject({
      code: 'SANDBOX_COMMAND_FAILED',
    })
    expect(fake.calls.at(-1)!.argv).toEqual(['rm', '--recursive', '--force', '--', STAGE])
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
