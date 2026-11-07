import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  archivesOfStack,
  CMS_ARCHIVES,
  fetchCmsArchive,
  phpVersionsOfStack,
  readCmsArchives,
  TREE_SUM,
} from './fetch-cms.mjs'

// The closed vendor of plan 62, in parts: no file of this folder says its name.
const closed = new RegExp(['bit', 'rix'].join(''), 'i')
const script = fileURLToPath(new URL('./fetch-cms.mjs', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'raditi-fetch-cms-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

/** A tar.gz of two files, made by the tar of this machine, as a release of a CMS is. */
function sampleArchive(release = '1') {
  const source = join(scratch, `source-${Math.random().toString(16).slice(2)}`)
  mkdirSync(join(source, 'administrator'), { recursive: true })
  writeFileSync(join(source, 'index.php'), `<?php echo ${release};\n`)
  writeFileSync(join(source, 'administrator', 'index.php'), '<?php echo 2;\n')
  const file = `${source}.tar.gz`
  execFileSync('tar', ['-czf', file, '-C', source, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  return readFileSync(file)
}

const row = (bytes, overrides = {}) => ({
  stack: 'joomla',
  php: '7.4',
  url: 'https://example.invalid/sample.tar.gz',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  sha256Source: 'published',
  license: 'GPL-2.0-or-later',
  ...overrides,
})

/** A fetch that answers `bytes` and counts what it was asked, with the headers it got. */
function fakeFetch(bytes) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, headers: { ...init?.headers } })
    return new Response(bytes, { status: 200 })
  }
  return { fetch, calls }
}
const noNetwork = async () => {
  throw new Error('no network in this test')
}

test('a right sum unpacks the archive; a second run downloads nothing', async () => {
  const bytes = sampleArchive()
  const directory = join(scratch, 'right')
  const archives = { 'sample-1.0': row(bytes) }
  const { fetch, calls } = fakeFetch(bytes)
  const tree = await fetchCmsArchive('sample-1.0', { directory, fetch, archives })
  assert.equal(tree, join(directory, 'sample-1.0', 'tree'))
  assert.equal(readFileSync(join(tree, 'index.php'), 'utf8'), '<?php echo 1;\n')
  assert.equal(readFileSync(join(tree, 'administrator', 'index.php'), 'utf8'), '<?php echo 2;\n')
  assert.ok(existsSync(join(directory, 'sample-1.0', 'archive.tar.gz')))
  // The tree carries the sum of the archive it came from, beside it, not inside it.
  assert.equal(
    readFileSync(join(directory, 'sample-1.0', TREE_SUM), 'utf8'),
    `${archives['sample-1.0'].sha256}\n`,
  )
  // One request, with the agent of the stand and nothing else.
  assert.deepEqual(calls, [
    {
      url: 'https://example.invalid/sample.tar.gz',
      headers: { 'User-Agent': 'raditi-stack-verify' },
    },
  ])
  // Again, without a network: the archive is right, so nothing is downloaded.
  assert.equal(await fetchCmsArchive('sample-1.0', { directory, fetch: noNetwork, archives }), tree)
  // A tree removed is unpacked again from the archive that is there, still without a network.
  rmSync(tree, { recursive: true })
  await fetchCmsArchive('sample-1.0', { directory, fetch: noNetwork, archives })
  assert.ok(existsSync(join(tree, 'index.php')))
})

test('a wrong sum fails before anything is unpacked and leaves no file behind', async () => {
  // Bytes no tar reads: had they been unpacked before the sum was checked, the error would be tar's.
  const bytes = randomBytes(4096)
  const directory = join(scratch, 'wrong')
  const archives = { 'sample-1.0': row(sampleArchive()) }
  await assert.rejects(
    fetchCmsArchive('sample-1.0', { directory, fetch: fakeFetch(bytes).fetch, archives }),
    /sha256 [0-9a-f]{64} is not the/,
  )
  assert.equal(existsSync(join(directory, 'sample-1.0')), false)
  // An archive already there with a wrong sum is no archive: it is removed and fetched again.
  mkdirSync(join(directory, 'sample-1.0'), { recursive: true })
  writeFileSync(join(directory, 'sample-1.0', 'archive.tar.gz'), 'not the archive')
  await assert.rejects(
    fetchCmsArchive('sample-1.0', { directory, fetch: fakeFetch(bytes).fetch, archives }),
    /sha256 [0-9a-f]{64} is not the/,
  )
  assert.equal(existsSync(join(directory, 'sample-1.0', 'archive.tar.gz')), false)
})

test('a tree of another archive is never the tree of a row: it is unpacked again', async () => {
  const directory = join(scratch, 'repinned')
  const first = sampleArchive('"release A"')
  const second = sampleArchive('"release B"')
  const tree = await fetchCmsArchive('sample-1.0', {
    directory,
    fetch: fakeFetch(first).fetch,
    archives: { 'sample-1.0': row(first) },
  })
  assert.match(readFileSync(join(tree, 'index.php'), 'utf8'), /release A/)
  // The row is pinned to another archive: the old one fails its sum, the new one is downloaded,
  // and the tree of the old bytes does not stay.
  const archives = { 'sample-1.0': row(second) }
  await fetchCmsArchive('sample-1.0', { directory, fetch: fakeFetch(second).fetch, archives })
  assert.match(readFileSync(join(tree, 'index.php'), 'utf8'), /release B/)
  assert.equal(
    readFileSync(join(directory, 'sample-1.0', TREE_SUM), 'utf8'),
    `${archives['sample-1.0'].sha256}\n`,
  )
  // A tree without its sum (unpacked by hand, or before the sum was written) is unpacked again.
  rmSync(join(directory, 'sample-1.0', TREE_SUM))
  writeFileSync(join(tree, 'index.php'), 'changed by hand')
  await fetchCmsArchive('sample-1.0', { directory, fetch: noNetwork, archives })
  assert.match(readFileSync(join(tree, 'index.php'), 'utf8'), /release B/)
  // A failed download of a re-pinned row leaves neither the old tree nor its sum to a suite.
  await assert.rejects(
    fetchCmsArchive('sample-1.0', {
      directory,
      fetch: fakeFetch(second).fetch,
      archives: { 'sample-1.0': row(first) },
    }),
    /sha256/,
  )
  assert.equal(existsSync(join(directory, 'sample-1.0', 'tree')), false)
  assert.equal(existsSync(join(directory, 'sample-1.0', TREE_SUM)), false)
})

test('a row whose id or address names the closed vendor is refused, whatever its licence', async () => {
  const bytes = sampleArchive()
  const directory = join(scratch, 'closed')
  // Built from parts, as the file under test builds it.
  const vendor = ['bit', 'rix'].join('')
  const { fetch, calls } = fakeFetch(bytes)
  for (const archives of [
    { [`${vendor}-25.0`]: row(bytes) },
    { 'sample-1.0': row(bytes, { url: `https://example.invalid/${vendor}.tar.gz` }) },
  ]) {
    assert.throws(() => readCmsArchives(archives), /closed CMS/)
    const [id] = Object.keys(archives)
    await assert.rejects(fetchCmsArchive(id, { directory, fetch, archives }), /closed CMS/)
  }
  assert.equal(calls.length, 0)
  assert.equal(existsSync(directory), false)
})

test('the table refuses a licence outside the GPL and a row without the origin of its sum', async () => {
  const bytes = sampleArchive()
  const directory = join(scratch, 'refused')
  const { fetch, calls } = fakeFetch(bytes)
  for (const archives of [
    { 'sample-1.0': row(bytes, { license: 'Proprietary' }) },
    { 'sample-1.0': row(bytes, { sha256Source: undefined }) },
    { 'sample-1.0': row(bytes, { sha256Source: 'second_download' }) },
  ]) {
    assert.throws(() => readCmsArchives(archives))
    await assert.rejects(fetchCmsArchive('sample-1.0', { directory, fetch, archives }))
  }
  // Refused before a byte is downloaded.
  assert.equal(calls.length, 0)
  assert.equal(existsSync(join(directory, 'sample-1.0')), false)
  // Both origins are accepted.
  for (const sha256Source of ['published', 'first_download'])
    assert.doesNotThrow(() => readCmsArchives({ 'sample-1.0': row(bytes, { sha256Source }) }))
})

test('every row of cms-archives.json says where its sum comes from, none is of a closed CMS', () => {
  const text = readFileSync(new URL('./cms-archives.json', import.meta.url), 'utf8')
  const table = JSON.parse(text)
  assert.ok(Object.keys(table).length > 0)
  for (const [id, entry] of Object.entries(table)) {
    assert.ok(['published', 'first_download'].includes(entry.sha256Source), id)
    assert.match(entry.license, /^GPL-/, id)
    assert.doesNotMatch(id, closed)
    assert.doesNotMatch(entry.url, closed)
  }
  assert.deepEqual(Object.keys(CMS_ARCHIVES), Object.keys(table))
})

test('a stack names its rows by the field, not by the id', () => {
  const sample = sampleArchive()
  const archives = {
    'opencart-3.0.3.8': row(sample, { stack: 'opencart', php: '7.4' }),
    'ocstore-3.0.3.7': row(sample, { stack: 'opencart', php: '7.4' }),
    'opencart-4.1.0.4': row(sample, { stack: 'opencart', php: '8.3' }),
    'joomla-3.10.12': row(sample),
  }
  assert.deepEqual(archivesOfStack('opencart', archives), [
    'opencart-3.0.3.8',
    'ocstore-3.0.3.7',
    'opencart-4.1.0.4',
  ])
  assert.deepEqual(phpVersionsOfStack('opencart', archives), ['7.4', '8.3'])
  assert.throws(() => archivesOfStack('nope', archives), /no archive/)
  assert.deepEqual(archivesOfStack('joomla'), [
    'joomla-3.10.12',
    'joomla-4.4.14',
    'joomla-5.4.10',
    'joomla-6.2.0',
  ])
  // One version of PHP once, though two builds run on it.
  assert.deepEqual(phpVersionsOfStack('joomla'), ['7.4', '8.1', '8.3'])
})

test('the command: versions of PHP without a download, an unknown stack fails', () => {
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    })
  const versions = run('--php=joomla')
  assert.equal(versions.status, 0, versions.stderr)
  assert.equal(versions.stdout, '7.4,8.1,8.3\n')
  assert.equal(run('--stack=nope').status, 1)
  assert.equal(run('--php=nope').status, 1)
  // A download needs an absolute folder.
  assert.equal(run('joomla-3.10.12').status, 1)
  assert.equal(
    spawnSync(process.execPath, [script, 'joomla-3.10.12'], {
      env: { PATH: process.env.PATH ?? '', RADITI_CMS_DIR: 'relative/folder' },
    }).status,
    1,
  )
  assert.equal(run().status, 1)
})
