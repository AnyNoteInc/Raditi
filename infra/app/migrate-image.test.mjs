import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { migrateManifests, newVersions, RUN_FROM_DEV, versionsOf } from './migrate-image.mjs'

const root = new URL('../../', import.meta.url)
const read = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'))

/** The workspace `turbo prune @repo/db` leaves: the root, db, domain and the two configs. */
const pruned = () =>
  new Map([
    ['', read('package.json')],
    ['packages/db', read('packages/db/package.json')],
    ['packages/domain', read('packages/domain/package.json')],
    ['packages/eslint-config', read('packages/eslint-config/package.json')],
    ['packages/typescript-config', read('packages/typescript-config/package.json')],
  ])

test('the Prisma CLI and the TypeScript config of @repo/db become its dependencies', () => {
  const before = pruned().get('packages/db')
  const db = migrateManifests(pruned()).manifests.get('packages/db')
  for (const name of RUN_FROM_DEV) assert.equal(db.dependencies[name], before.devDependencies[name])
  for (const [name, spec] of Object.entries(before.dependencies))
    assert.equal(db.dependencies[name], spec)
})

test('no package keeps dev dependencies', () => {
  for (const [dir, manifest] of migrateManifests(pruned()).manifests)
    assert.equal(manifest.devDependencies, undefined, dir || 'root')
})

test('the workspace packages @repo/db does not reach leave the image', () => {
  const { manifests, removed } = migrateManifests(pruned())
  assert.deepEqual(removed, ['packages/eslint-config'])
  assert.deepEqual([...manifests.keys()].sort(), [
    '',
    'packages/db',
    'packages/domain',
    'packages/typescript-config',
  ])
})

test('the manifests of the pruned workspace stay as they were', () => {
  const workspace = pruned()
  const copy = structuredClone(workspace)
  migrateManifests(workspace)
  assert.deepEqual(workspace, copy)
})

test('a workspace without @repo/db or with a dependency outside it is refused', () => {
  const noDb = pruned()
  noDb.delete('packages/db')
  assert.throws(() => migrateManifests(noDb), /@repo\/db is not in the pruned workspace/)
  const noDomain = pruned()
  noDomain.delete('packages/domain')
  assert.throws(() => migrateManifests(noDomain), /@repo\/domain is not in the pruned workspace/)
  const noCli = pruned()
  delete noCli.get('packages/db').devDependencies.prisma
  assert.throws(() => migrateManifests(noCli), /has no dev dependency prisma/)
})

const LOCK = `lockfileVersion: '9.0'

packages:

  '@prisma/client@7.10.0':
    resolution: {integrity: sha512-a}

  typescript@6.0.3:
    resolution: {integrity: sha512-b}

  typescript@7.0.2:
    resolution: {integrity: sha512-c}

snapshots:

  '@prisma/client@7.10.0(typescript@6.0.3)':
    dependencies:
      typescript: 6.0.3
`

test('the versions of a lockfile leave out the peers of its snapshots', () => {
  assert.equal(versionsOf(LOCK).get('typescript@7.0.2'), 'sha512-c')
  assert.deepEqual([...versionsOf(LOCK).keys()].sort(), [
    '@prisma/client@7.10.0',
    'typescript@6.0.3',
    'typescript@7.0.2',
  ])
  assert.ok(versionsOf(readFileSync(new URL('pnpm-lock.yaml', root), 'utf8')).size > 100)
})

test('another peer of a locked version is no new version; another version is', () => {
  const peers = LOCK.replace('(typescript@6.0.3)', '(typescript@7.0.2)')
  assert.deepEqual(newVersions(LOCK, peers), [])
  const bumped = LOCK.replace("'@prisma/client@7.10.0':", "'@prisma/client@7.11.0':")
  assert.deepEqual(newVersions(LOCK, bumped), ['@prisma/client@7.11.0'])
})

test('a locked version with another integrity is a new version', () => {
  const swapped = LOCK.replace('sha512-c', 'sha512-other')
  assert.deepEqual(newVersions(LOCK, swapped), ['typescript@7.0.2'])
})

test('the block resolution of a pruned lockfile reads like the inline one of pnpm', () => {
  const block = LOCK.replace(
    /resolution: \{integrity: (\S+)\}/g,
    'resolution:\n      integrity: $1',
  )
  assert.equal(versionsOf(block).get('typescript@7.0.2'), 'sha512-c')
  assert.deepEqual(newVersions(block, LOCK), [])
  assert.deepEqual(newVersions(block, LOCK.replace('sha512-a', 'sha512-other')), [
    '@prisma/client@7.10.0',
  ])
})
