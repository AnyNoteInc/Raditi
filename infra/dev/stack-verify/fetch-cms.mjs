// The releases of the CMS a stand of the site stacks runs (docs/plan/62-site-stacks.md, §5.5;
// docs/plan/62-slices/e3.md, Э3.8): a row of cms-archives.json per build, its sum pinned. An archive
// is downloaded into $RADITI_CMS_DIR/<id>/archive.tar.gz, its sha256 checked before anything else
// touches it, and unpacked into <id>/tree (a row whose archive holds the site in one folder names it:
// `tree`, Э3.15). On the host it is only unpacked: what it holds runs in a
// container of the stand. Archives live on the machine of the run only — never in git, an image,
// an artifact or a cache of Actions.
//
//   node infra/dev/stack-verify/fetch-cms.mjs <id>...          the named rows
//   node infra/dev/stack-verify/fetch-cms.mjs --stack=<stack>  every row of the stack; none — exit 1
//   node infra/dev/stack-verify/fetch-cms.mjs --php=<stack>    the PHP versions of its rows, no download
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import process from 'node:process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

/** Where the sum of a row comes from: the vendor published it, or the first download gave it. */
export const SHA256_SOURCES = ['published', 'first_download']
const ARCHIVE = 'archive.tar.gz'
const TREE = 'tree'
/** Beside the tree, the sum of the archive it was unpacked from: a tree is used only under its row. */
export const TREE_SUM = 'tree.sha256'
const ID = /^[a-z0-9][a-z0-9.-]{0,63}$/
const STACK = /^[a-z0-9]{1,32}$/
const PHP = /^\d\.\d$/
const SHA256 = /^[0-9a-f]{64}$/
/** A folder inside the archive: plain names joined by `/`, none of them `.` or `..`, at most 128 signs. */
const FOLDER = /^(?=.{1,128}$)[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/
/** The vendor whose core may not be here (plan 62, §5), named in parts: no file of the stand says it. */
const CLOSED = new RegExp(['bit', 'rix'].join(''), 'i')
const GPL = /^(?:L?GPL|AGPL)-\d(?:\.\d)?(?:-only|-or-later)?$/

/** The table, each row checked; a row that does not pass stops everything before a download. */
export function readCmsArchives(table) {
  if (typeof table !== 'object' || table === null || Array.isArray(table))
    throw new Error('cms-archives: the table is an object of rows')
  const rows = {}
  for (const [id, entry] of Object.entries(table)) {
    const fail = (what) => {
      throw new Error(`cms-archives: ${id}: ${what}`)
    }
    if (!ID.test(id)) fail('the id is not a plain name')
    if (typeof entry !== 'object' || entry === null) fail('the row is not an object')
    const known = ['stack', 'php', 'url', 'sha256', 'sha256Source', 'license', 'tree']
    for (const key of Object.keys(entry)) if (!known.includes(key)) fail(`unknown field ${key}`)
    if (!STACK.test(entry.stack ?? '')) fail('no stack')
    if (!PHP.test(entry.php ?? '')) fail('no PHP version')
    let url
    try {
      url = new URL(entry.url)
    } catch {
      fail('no address')
    }
    if (url.protocol !== 'https:') fail('the address is not https')
    if (!SHA256.test(entry.sha256 ?? '')) fail('no sha256')
    if (!SHA256_SOURCES.includes(entry.sha256Source))
      fail(`sha256Source is one of ${SHA256_SOURCES.join(', ')}`)
    if (!GPL.test(entry.license ?? '')) fail(`the licence ${entry.license} is not one of the GPL`)
    if (CLOSED.test(id) || CLOSED.test(entry.url)) fail('a closed CMS is never fetched')
    // The folder of the archive that holds the site (`wordpress/` of a release of WordPress,
    // `ocStore-3.0.3.7/upload` of ocStore); without it the archive unpacks into the site itself.
    if (
      Object.hasOwn(entry, 'tree') &&
      !(typeof entry.tree === 'string' && FOLDER.test(entry.tree))
    )
      fail('tree is a folder of the archive: plain names joined by /')
    rows[id] = { ...entry }
  }
  return rows
}

export const CMS_ARCHIVES = readCmsArchives(
  JSON.parse(readFileSync(new URL('./cms-archives.json', import.meta.url), 'utf8')),
)

/** The ids of every row of a stack, in the order of the table; none is an error. */
export function archivesOfStack(stack, archives = CMS_ARCHIVES) {
  const ids = Object.entries(readCmsArchives(archives))
    .filter(([, entry]) => entry.stack === stack)
    .map(([id]) => id)
  if (ids.length === 0) throw new Error(`cms-archives: no archive of the stack ${stack}`)
  return ids
}

/** The PHP versions the rows of a stack run on, each once, in the order of the table. */
export function phpVersionsOfStack(stack, archives = CMS_ARCHIVES) {
  const table = readCmsArchives(archives)
  return [...new Set(archivesOfStack(stack, table).map((id) => table[id].php))]
}

async function sha256Of(file) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/**
 * Whether `<id>/tree` was unpacked from the archive of the sum `sha256`: `<id>/tree.sha256` says so.
 * A tree of another archive — the row re-pinned, the archive replaced — is not this build's tree.
 */
export function treeMatches(folder, sha256) {
  const marker = join(folder, TREE_SUM)
  return (
    existsSync(join(folder, TREE)) &&
    existsSync(marker) &&
    readFileSync(marker, 'utf8').trim() === sha256
  )
}

/**
 * Downloads into $RADITI_CMS_DIR/<id>/archive.tar.gz, checks its sha256 before unpacking, unpacks
 * into <id>/tree and writes the sum beside it (<id>/tree.sha256). A second run with the right
 * archive and its tree downloads nothing. A wrong sum throws and the file is removed; a tree not
 * unpacked from the archive of the row is removed and unpacked again. A licence outside the GPL in
 * the table is refused: the core of a closed CMS can never be here. Answers the folder of the tree,
 * or the folder `tree` of the row names inside it, which must be there.
 */
export async function fetchCmsArchive(
  id,
  { directory, fetch = globalThis.fetch, archives = CMS_ARCHIVES },
) {
  if (typeof directory !== 'string' || !isAbsolute(directory))
    throw new Error('RADITI_CMS_DIR is an absolute path')
  const table = readCmsArchives(archives)
  const entry = table[id]
  if (!entry) throw new Error(`cms-archives: no row ${id}`)
  const folder = join(directory, id)
  const archive = join(folder, ARCHIVE)
  const tree = join(folder, TREE)
  const marker = join(folder, TREE_SUM)
  mkdirSync(folder, { recursive: true })

  // A tree is the tree of its row only: any other — of an old archive, half unpacked, without its
  // sum — goes before anything else, so a failure below never leaves it to a suite.
  if (!treeMatches(folder, entry.sha256)) {
    await rm(marker, { force: true })
    await rm(tree, { recursive: true, force: true })
  }
  if (existsSync(archive) && (await sha256Of(archive)) !== entry.sha256) await rm(archive)
  if (!existsSync(archive)) {
    const partial = `${archive}.part`
    await rm(partial, { force: true })
    try {
      const response = await fetch(entry.url, { headers: { 'User-Agent': 'raditi-stack-verify' } })
      if (!response.ok || !response.body)
        throw new Error(`${id}: the download answered ${response.status}`)
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
      const sum = await sha256Of(partial)
      if (sum !== entry.sha256)
        throw new Error(`${id}: sha256 ${sum} is not the ${entry.sha256} of the table`)
      await rename(partial, archive)
    } catch (error) {
      await rm(partial, { force: true })
      // Nothing of a failed download stays but a tree of this row: the next run starts clean.
      if (!treeMatches(folder, entry.sha256)) await rm(folder, { recursive: true, force: true })
      throw error
    }
  }

  if (!treeMatches(folder, entry.sha256)) {
    const unpacking = `${tree}.part`
    await rm(unpacking, { recursive: true, force: true })
    mkdirSync(unpacking)
    try {
      // Unpacked only; the tar of the system refuses absolute paths and `..` by default.
      execFileSync('tar', ['-xzf', archive, '-C', unpacking], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      await rename(unpacking, tree)
      await writeFile(marker, `${entry.sha256}\n`)
    } catch (error) {
      await rm(unpacking, { recursive: true, force: true })
      throw error
    }
  }
  if (entry.tree === undefined) return tree
  return siteFolderOf(tree, entry.tree, id)
}

/**
 * The folder `folder` of an unpacked `tree`, which must be a directory of the tree itself: an
 * archive is untrusted, and a symbolic link it unpacks under that name (`upload -> /Users/…`) would
 * hand a folder of the host to `tar -C`, which follows it. Its real path lies inside the real path
 * of the tree, or it is refused.
 */
export function siteFolderOf(tree, folder, id = 'the archive') {
  const site = join(tree, folder)
  if (!statSync(site, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`${id}: the archive holds no folder ${folder}`)
  if (!realpathSync(site).startsWith(realpathSync(tree) + sep))
    throw new Error(`${id}: the folder ${folder} of the archive leads out of its tree`)
  return site
}

async function main(argv, env) {
  const options = argv.filter((arg) => arg.startsWith('--'))
  const ids = argv.filter((arg) => !arg.startsWith('--'))
  const php = options.find((arg) => arg.startsWith('--php='))?.slice('--php='.length)
  const stack = options.find((arg) => arg.startsWith('--stack='))?.slice('--stack='.length)
  if (options.some((arg) => !/^--(?:php|stack)=/.test(arg)))
    throw new Error(`unknown option ${options.find((arg) => !/^--(?:php|stack)=/.test(arg))}`)
  if (php !== undefined) {
    if (ids.length || stack !== undefined) throw new Error('--php takes nothing else')
    process.stdout.write(`${phpVersionsOfStack(php).join(',')}\n`)
    return
  }
  const wanted = stack !== undefined ? [...ids, ...archivesOfStack(stack)] : ids
  if (wanted.length === 0)
    throw new Error('usage: fetch-cms.mjs <id>... | --stack=<stack> | --php=<stack>')
  const directory = env.RADITI_CMS_DIR
  if (!directory || !isAbsolute(directory)) throw new Error('RADITI_CMS_DIR is an absolute path')
  for (const id of wanted) {
    const tree = await fetchCmsArchive(id, { directory })
    process.stdout.write(`${id} ${tree}\n`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).catch((error) => {
    process.stderr.write(`fetch-cms: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
