// The manifests of the migrate image (apps/core/Dockerfile, stages migrate-*; docs/plan/92-docker-layers.md).
// The image runs the Prisma CLI of @repo/db: `migrate deploy` and `db seed` (infra/app/docker-compose.yml).
// It is built from `turbo prune @repo/db --docker`, whose workspace still holds the dev tools of the
// repository. In that pruned workspace this script leaves only what the image runs:
// - the Prisma CLI and @repo/typescript-config (prisma.config.ts loads packages/db/tsconfig.json,
//   which extends its JSON) become dependencies of @repo/db;
// - no package keeps devDependencies;
// - the workspace packages @repo/db no longer reaches (@repo/eslint-config) leave the workspace.
// `pnpm install --prod` then installs the versions of the lockfile: the lockfile only shrinks, and
// `--check` fails the build if the install took a version or an integrity the lockfile of the
// repository lacks.
//
//   node migrate-image.mjs           (in the root of the pruned workspace)
//   cp pnpm-lock.yaml pnpm-lock.locked.yaml && pnpm install … && node migrate-image.mjs --check
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** The dev dependencies of @repo/db the migrate image runs. */
export const RUN_FROM_DEV = ['prisma', '@repo/typescript-config']

const ROOT_PACKAGE = '@repo/db'

/** The copy of the lockfile of the pruned workspace before the install, for `--check`. */
export const LOCKED = 'pnpm-lock.locked.yaml'

/** The directory of each workspace package by its name. */
function directoriesByName(manifests) {
  const byName = new Map()
  for (const [dir, manifest] of manifests) if (dir) byName.set(manifest.name, dir)
  return byName
}

/** A manifest without devDependencies; @repo/db keeps those of RUN_FROM_DEV as dependencies. */
function withoutDevTools(manifest, isDb) {
  const next = structuredClone(manifest)
  for (const name of isDb ? RUN_FROM_DEV : []) {
    const spec = next.devDependencies?.[name]
    if (spec === undefined) throw new Error(`${ROOT_PACKAGE} has no dev dependency ${name}`)
    next.dependencies = { ...next.dependencies, [name]: spec }
  }
  delete next.devDependencies
  return next
}

/** The workspace directories `from` reaches through the `workspace:` dependencies of `manifests`. */
function reachedFrom(from, manifests, byName) {
  const reached = new Set([from])
  const queue = [from]
  while (queue.length > 0) {
    const dependencies = manifests.get(queue.shift()).dependencies ?? {}
    const linked = Object.keys(dependencies).filter((name) =>
      String(dependencies[name]).startsWith('workspace:'),
    )
    for (const name of linked) {
      const dir = byName.get(name)
      if (dir === undefined) throw new Error(`${name} is not in the pruned workspace`)
      if (!reached.has(dir)) queue.push(dir)
      reached.add(dir)
    }
  }
  return reached
}

/**
 * The manifests of the image from those of the pruned workspace: `manifests` maps a directory
 * ('' for the root) to its package.json. Returns the new manifests of the directories that stay
 * and the directories that leave.
 */
export function migrateManifests(manifests) {
  const byName = directoriesByName(manifests)
  const dbDir = byName.get(ROOT_PACKAGE)
  if (dbDir === undefined) throw new Error(`${ROOT_PACKAGE} is not in the pruned workspace`)
  const result = new Map()
  for (const [dir, manifest] of manifests) result.set(dir, withoutDevTools(manifest, dir === dbDir))
  const reached = reachedFrom(dbDir, result, byName)
  const removed = [...result.keys()].filter((dir) => dir !== '' && !reached.has(dir))
  for (const dir of removed) result.delete(dir)
  return { manifests: result, removed }
}

/** `name@version` of a package or snapshot key of a lockfile (two spaces in), without peers. */
function packageKey(line) {
  if (!line.startsWith('  ') || line[2] === ' ' || !line.endsWith(':')) return null
  const key = line.slice(2, -1).replaceAll("'", '').split('(')[0]
  return key.lastIndexOf('@') > 0 ? key : null
}

/** The integrity of a resolution line: inline (pnpm) or in its own line below (turbo prune). */
function integrityOf(line) {
  const inline = line.startsWith('    resolution: {')
  const block = line.startsWith('      integrity: ')
  if (!inline && !block) return null
  const at = line.indexOf('integrity: ')
  if (at === -1) return null
  return line.slice(at + 'integrity: '.length).split(/[,}\s]/)[0] || null
}

/**
 * The versions a pnpm lockfile holds, `name@version`, without the peers of a snapshot, each with the
 * integrity of its tarball (null for a version without one, such as a link). pnpm writes the
 * resolution inline (`resolution: {integrity: …}`), turbo prune as a block (`integrity: …` below).
 */
export function versionsOf(lockfile) {
  const versions = new Map()
  let current = null
  for (const line of lockfile.split('\n')) {
    const key = packageKey(line)
    if (key !== null) {
      current = key
      if (!versions.has(key)) versions.set(key, null)
      continue
    }
    const integrity = current === null ? null : integrityOf(line)
    if (integrity !== null) versions.set(current, integrity)
  }
  return versions
}

/**
 * The versions of `installed` that `original` does not hold, or holds with another integrity:
 * none, when the lockfile only shrank.
 */
export function newVersions(original, installed) {
  const known = versionsOf(original)
  return [...versionsOf(installed)]
    .filter(
      ([version, integrity]) =>
        !known.has(version) || (integrity !== null && known.get(version) !== integrity),
    )
    .map(([version]) => version)
}

/** The package.json of the root and of every workspace package (apps/*, packages/*) under `root`. */
function readWorkspace(root) {
  const manifests = new Map([['', JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))]])
  for (const group of ['apps', 'packages']) {
    if (!existsSync(join(root, group))) continue
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      const file = join(root, group, entry.name, 'package.json')
      if (entry.isDirectory() && existsSync(file))
        manifests.set(`${group}/${entry.name}`, JSON.parse(readFileSync(file, 'utf8')))
    }
  }
  return manifests
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--check') {
  // After the install: every version comes from the lockfile of the repository, kept before it
  // as LOCKED next to pnpm-lock.yaml; the copy leaves with the check.
  const locked = join(process.cwd(), LOCKED)
  const added = newVersions(
    readFileSync(locked, 'utf8'),
    readFileSync(join(process.cwd(), 'pnpm-lock.yaml'), 'utf8'),
  )
  rmSync(locked)
  if (added.length > 0) {
    process.stderr.write(`[migrate-image] versions outside the lockfile: ${added.join(' ')}\n`)
    process.exit(1)
  }
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd()
  const { manifests, removed } = migrateManifests(readWorkspace(root))
  for (const [dir, manifest] of manifests)
    writeFileSync(join(root, dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const dir of removed) rmSync(join(root, dir), { recursive: true, force: true })
  process.stdout.write(
    `[migrate-image] kept ${manifests.size - 1} packages, removed: ${removed.join(' ') || '-'}\n`,
  )
}
