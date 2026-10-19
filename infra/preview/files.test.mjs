import assert from 'node:assert/strict'
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'

import { ustar } from '../dev/preview-verify/probes.mjs'
import {
  FilesRefused,
  filesLimits,
  Input,
  parseHeader,
  parsePax,
  pathNames,
  PLATFORM_FILE_MODE,
  PLATFORM_FOLDER_MODE,
  prepareRoot,
  readFrame,
  readPlatformFiles,
  releasePlatformFiles,
  writePlatformFiles,
  writeTree,
} from './files.mjs'

const refused = (reason) => (error) => error instanceof FilesRefused && error.reason === reason
const frame = (value) => {
  const body = Buffer.from(JSON.stringify(value))
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length)
  return Buffer.concat([head, body])
}
const chunks = (...parts) =>
  (async function* () {
    for (const part of parts) yield part
  })()

test('paths of the tree: plain names only, the root of a tar of . allowed for directories', () => {
  assert.deepEqual(pathNames('wp-content/themes/a/style.css'), [
    'wp-content',
    'themes',
    'a',
    'style.css',
  ])
  assert.deepEqual(pathNames('./index.php'), ['index.php'])
  assert.deepEqual(pathNames('wp-content/', { directory: true }), ['wp-content'])
  assert.deepEqual(pathNames('./', { directory: true }), [])
  assert.deepEqual(pathNames('тема/файл.php'), ['тема', 'файл.php'])
  for (const path of [
    '',
    '/etc/passwd',
    '../outside',
    'a/../b',
    'a//b',
    'a/./b',
    'dir/',
    'a\\b',
    'a\nb',
    `${'x/'.repeat(filesLimits.depth)}x`,
    'x'.repeat(256),
    undefined,
  ])
    assert.equal(pathNames(path), null, String(path))
})

test('headers: checksum, ustar or GNU magic, files and directories, nothing else', () => {
  const [file] = splitBlocks(ustar([{ path: 'a.txt', content: 'hello', mode: 0o755 }]))
  assert.deepEqual(parseHeader(file), { type: 'file', name: 'a.txt', mode: 0o755, size: 5 })
  const tampered = Buffer.from(file)
  tampered[0] ^= 1
  assert.throws(() => parseHeader(tampered), refused('checksum'))
  for (const type of ['1', '2', '3', '4', '6', '7', 'K', 'S'])
    assert.throws(
      () => parseHeader(splitBlocks(ustar([{ path: 'x', content: '', type }]))[0]),
      refused('entry_type'),
      type,
    )
  const [directory] = splitBlocks(ustar([{ path: 'd/', content: '', type: '5' }]))
  assert.equal(parseHeader(directory).type, 'directory')
  const latin = Buffer.from(file)
  latin.write('\xff\xfe', 0, 'latin1')
  assert.throws(() => parseHeader(withChecksum(latin)), refused('name_encoding'))
})

test('pax: a long path is taken, a size is refused, a broken record too', () => {
  const record = (key, value) => {
    const body = ` ${key}=${value}\n`
    let length = body.length + 1
    while (`${length}${body}`.length !== length) length++
    return `${length}${body}`
  }
  const long = `${'d/'.repeat(80)}file.php`
  assert.deepEqual(parsePax(Buffer.from(record('path', long) + record('mtime', '1.5'))), {
    path: long,
  })
  assert.throws(
    () => parsePax(Buffer.from(record('size', '99999999999'))),
    refused('file_too_large'),
  )
  assert.throws(() => parsePax(Buffer.from('8 path=x\n')), refused('pax'))
  assert.throws(() => parsePax(Buffer.from('9 pathx\n')), refused('pax'))
  assert.throws(() => parsePax(Buffer.from('99999999999 path=x\n')), refused('pax'))
})

test('input: exact reads across chunks, a short stream is truncated, only zeros after the end', async () => {
  const input = new Input(chunks(Buffer.from('ab'), Buffer.from('cdef'), Buffer.from('g')))
  assert.equal((await input.read(3)).toString(), 'abc')
  const taken = []
  for await (const part of input.take(3)) taken.push(part.toString())
  assert.equal(taken.join(''), 'def')
  await assert.rejects(input.read(2), refused('truncated'))
  assert.equal(await new Input(chunks()).read(1), null)
  await new Input(chunks(Buffer.alloc(10))).drainZeros(10)
  await assert.rejects(new Input(chunks(Buffer.from([0, 1]))).drainZeros(10), refused('trailer'))
  await assert.rejects(new Input(chunks(Buffer.alloc(11))).drainZeros(10), refused('trailer'))
})

test('frame: replace and deletes, nothing more, every delete a path of the tree', async () => {
  assert.deepEqual(
    await readFrame(new Input(chunks(frame({ replace: false, deletes: ['a/b'] })))),
    {
      replace: false,
      deletes: [['a', 'b']],
    },
  )
  for (const value of [
    { replace: 'yes', deletes: [] },
    { replace: true },
    { replace: true, deletes: [], extra: 1 },
    { replace: true, deletes: ['../x'] },
  ])
    await assert.rejects(
      readFrame(new Input(chunks(frame(value)))),
      (error) => error instanceof FilesRefused,
    )
  const big = Buffer.alloc(4)
  big.writeUInt32BE(filesLimits.frameBytes + 1)
  await assert.rejects(readFrame(new Input(chunks(big))), refused('frame'))
})

// The writes resolve every name under an open descriptor (/proc/self/fd): Linux only.
const linux = { skip: process.platform !== 'linux' && 'needs /proc/self/fd (Linux)' }

test(
  'write: files and directories land, links are never followed, deletes go first',
  linux,
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'raditi-files-'))
    try {
      await mkdir(join(root, 'old'))
      await writeFile(join(root, 'old/stale.txt'), 'x')
      await symlink('/etc', join(root, 'escape'))
      const archive = ustar([
        { path: 'wp-content/', content: '', type: '5' },
        { path: 'wp-content/themes/a/style.css', content: 'body{}' },
        { path: 'run.sh', content: '#!/bin/sh', mode: 0o4755 },
      ])
      const summary = await writeTree(
        root,
        chunks(frame({ replace: false, deletes: ['old', 'missing/file'] }), archive),
      )
      assert.deepEqual(summary, { files: 2, directories: 1, bytes: 15, deleted: 2 })
      assert.equal(await readFile(join(root, 'wp-content/themes/a/style.css'), 'utf8'), 'body{}')
      assert.equal((await stat(join(root, 'run.sh'))).mode & 0o7777, 0o755)
      await assert.rejects(lstat(join(root, 'old')))
      // Through an existing link: refused, and the link's target untouched.
      for (const path of ['escape/passwd', 'escape/x/y'])
        await assert.rejects(
          writeTree(
            root,
            chunks(frame({ replace: false, deletes: [] }), ustar([{ path, content: 'owned' }])),
          ),
          refused('path_conflict'),
        )
      await assert.rejects(
        writeTree(
          root,
          chunks(frame({ replace: false, deletes: [] }), ustar([{ path: 'escape', content: 'x' }])),
        ),
        refused('path_conflict'),
      )
      assert.equal(await readlink(join(root, 'escape')), '/etc')
      // A file of the old tree that is a folder of the new one: deleted before the write.
      await writeFile(join(root, 'theme.php'), '<?php')
      await writeTree(
        root,
        chunks(
          frame({ replace: false, deletes: ['theme.php'] }),
          ustar([{ path: 'theme.php/index.php', content: '<?php // new' }]),
        ),
      )
      assert.equal(await readFile(join(root, 'theme.php/index.php'), 'utf8'), '<?php // new')
      // Replace empties the root first, links included, without following them.
      await writeTree(
        root,
        chunks(
          frame({ replace: true, deletes: [] }),
          ustar([{ path: 'index.php', content: '<?php' }]),
        ),
      )
      await assert.rejects(lstat(join(root, 'escape')))
      await assert.rejects(lstat(join(root, 'wp-content')))
      assert.equal(await readFile(join(root, 'index.php'), 'utf8'), '<?php')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

// Every build asks the helper again; a docroot of the PHP user must pass untouched.
test(
  'prepare: a docroot of the PHP user is left as it is, even one closed to everyone',
  { skip: process.getuid?.() === 0 && 'the owner here is root' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'raditi-files-'))
    try {
      const before = await stat(root)
      await chmod(root, 0o000)
      assert.deepEqual(await prepareRoot(root, `${before.uid}:${before.gid}`), { ready: true })
      assert.equal((await stat(root)).mode & 0o7777, 0o000)
      await assert.rejects(prepareRoot(root, 'root:0'), refused('usage'))
    } finally {
      await chmod(root, 0o700)
      await rm(root, { recursive: true, force: true })
    }
  },
)

test('write: a docroot its owner closed to itself is opened again', linux, async () => {
  const root = await mkdtemp(join(tmpdir(), 'raditi-files-'))
  try {
    await chmod(root, 0o000)
    await writeTree(
      root,
      chunks(
        frame({ replace: false, deletes: [] }),
        ustar([{ path: 'index.php', content: '<?php' }]),
      ),
    )
    assert.equal(await readFile(join(root, 'index.php'), 'utf8'), '<?php')
    assert.equal((await stat(root)).mode & 0o700, 0o700)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('write: a truncated archive, a hard link or trailing data fail closed', linux, async () => {
  const root = await mkdtemp(join(tmpdir(), 'raditi-files-'))
  try {
    const head = frame({ replace: false, deletes: [] })
    const archive = ustar([{ path: 'a.txt', content: 'x'.repeat(600) }])
    await assert.rejects(
      writeTree(root, chunks(head, archive.subarray(0, 700))),
      refused('truncated'),
    )
    await assert.rejects(
      writeTree(root, chunks(head, ustar([{ path: 'link', content: '', type: '1' }]))),
      refused('entry_type'),
    )
    await assert.rejects(
      writeTree(root, chunks(head, archive, Buffer.from('junk'))),
      refused('trailer'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function splitBlocks(archive) {
  const blocks = []
  for (let offset = 0; offset < archive.length; offset += 512)
    blocks.push(archive.subarray(offset, offset + 512))
  return blocks
}

function withChecksum(block) {
  block.write('        ', 148, 'latin1')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
  return block
}

// The platform's own files (R5b, R5c): written as root with CAP_CHOWN alone, the tree of the
// PHP user around them. Linux and root only: the helper runs so.
const linuxRoot = {
  skip:
    (process.platform !== 'linux' && 'needs /proc/self/fd (Linux)') ||
    (process.getuid?.() !== 0 && 'needs root, as the helper runs it'),
}
const PHP = 33

/** Takes a tree back to root before it is removed: root here has no DAC_OVERRIDE either. */
async function reclaim(path) {
  const info = await lstat(path)
  await chown(path, 0, 0).catch(() => {})
  if (!info.isDirectory()) return
  await chmod(path, 0o755)
  for (const name of await readdir(path)) await reclaim(join(path, name))
}

test('platform: the frame names each file once, within the limits, with nothing after', async () => {
  const files = [{ path: 'wp-config.php', content: '<?php' }]
  assert.deepEqual(await readPlatformFiles(new Input(chunks(frame({ files })))), [
    { names: ['wp-config.php'], content: '<?php' },
  ])
  for (const value of [
    { files: [...files, ...files] },
    { files: [{ path: '../x', content: '' }] },
    { files: [{ path: 'a', content: 'x', mode: 0o777 }] },
    { files, other: 1 },
    {
      files: Array.from({ length: filesLimits.platformFiles + 1 }, (_, i) => ({
        path: `f${i}`,
        content: '',
      })),
    },
  ])
    await assert.rejects(
      readPlatformFiles(new Input(chunks(frame(value)))),
      (error) => error instanceof FilesRefused,
    )
  await assert.rejects(
    readPlatformFiles(new Input(chunks(frame({ files }), Buffer.from('x')))),
    refused('frame'),
  )
})

test(
  'platform: root 0444 files in root:<PHP gid> 1775 folders, given back before a new tree',
  linuxRoot,
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'raditi-files-'))
    try {
      await mkdir(join(root, 'wp-content/themes'), { recursive: true })
      await writeFile(join(root, 'wp-content/themes/style.css'), 'body{}')
      await writeFile(join(root, 'wp-config.php'), 'the site own')
      // As the helper's `init` and `write` leave it: the PHP user's, 0755 folders.
      await chmod(root, 0o755)
      for (const path of [
        '',
        'wp-content',
        'wp-content/themes',
        'wp-content/themes/style.css',
        'wp-config.php',
      ])
        await chown(join(root, path), PHP, PHP)
      const files = [
        { path: 'wp-config.php', content: '<?php // platform' },
        { path: 'wp-content/mu-plugins/raditi-preview.php', content: '<?php // preview' },
      ]
      assert.deepEqual(await writePlatformFiles(root, `${PHP}:${PHP}`, chunks(frame({ files }))), {
        files: 2,
      })
      for (const path of ['', 'wp-content', 'wp-content/mu-plugins']) {
        const folder = await lstat(join(root, path))
        assert.equal(folder.uid, 0, path)
        assert.equal(folder.gid, PHP, path)
        assert.equal(folder.mode & 0o7777, PLATFORM_FOLDER_MODE, path)
      }
      for (const file of files) {
        const info = await lstat(join(root, file.path))
        assert.equal(info.uid, 0)
        assert.equal(info.mode & 0o7777, PLATFORM_FILE_MODE)
        assert.equal(await readFile(join(root, file.path), 'utf8'), file.content)
      }
      // The site's own files stay the PHP user's.
      assert.equal((await lstat(join(root, 'wp-content/themes'))).uid, PHP)
      // Again over itself: nothing changes.
      await writePlatformFiles(root, `${PHP}:${PHP}`, chunks(frame({ files })))

      assert.deepEqual(await releasePlatformFiles(root, `${PHP}:${PHP}`), { folders: 3 })
      for (const path of ['', 'wp-content', 'wp-content/mu-plugins']) {
        const folder = await lstat(join(root, path))
        assert.equal(folder.uid, PHP, path)
        assert.equal(folder.mode & 0o7777, 0o755, path)
      }
      await assert.rejects(lstat(join(root, 'wp-config.php')))
      assert.equal(await readFile(join(root, 'wp-content/themes/style.css'), 'utf8'), 'body{}')
    } finally {
      await reclaim(root)
      await rm(root, { recursive: true, force: true })
    }
  },
)

test(
  'platform: a folder swapped for a link is refused, its target untouched',
  linuxRoot,
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'raditi-files-'))
    const outside = await mkdtemp(join(tmpdir(), 'raditi-outside-'))
    try {
      await chmod(outside, 0o700)
      await symlink(outside, join(root, 'wp-content'))
      await chmod(root, 0o755)
      await chown(root, PHP, PHP)
      await assert.rejects(
        writePlatformFiles(
          root,
          `${PHP}:${PHP}`,
          chunks(frame({ files: [{ path: 'wp-content/mu-plugins/x.php', content: '<?php' }] })),
        ),
        refused('path_conflict'),
      )
      const target = await stat(outside)
      assert.equal(target.mode & 0o7777, 0o700)
      assert.equal(target.uid, 0)
    } finally {
      await reclaim(root)
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  },
)
