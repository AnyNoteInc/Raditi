// The private build copy of the browser-task stand and the images of the tree: the working tree
// copied outside the repository (never its .env), dependencies installed, the apps built — core,
// llm, mcp, preview, browser, and web unless `--web-dev` — and the six images of a turn's sandbox
// and of a browser session built under the stand's own names, referenced by digest. `--no-build`
// reuses both and is refused when the tree has changed since (the same stamps as the billing and
// release stands).
import assert from 'node:assert/strict'
import { access, cp, lstat, mkdir, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  BUILD_STAMP,
  COPY_MARKER,
  buildEnvironment,
  buildStamp,
  copyablePath,
  keptFolder,
  manifestDuringCopy,
  outside,
  readBuildStamp,
  staleCopy,
  staleDirectories,
  staleFiles,
  treeDigest,
  treeEntry,
} from '../billing-verify/stand.mjs'
import { callerEnv } from './runtime.mjs'
import {
  APP_OUTPUTS,
  BUILD_STEPS,
  BUILT_IMAGES,
  WEB_BUILD_STEP,
  WEB_OUTPUT,
  localDigestReference,
} from './stand.mjs'

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  )

/**
 * What makes one stand's build its own: its name (the folder and the stamps of the copy), the
 * prefix of its variables, the folder of the stand itself (never part of what the copy builds) and
 * the images it builds. The projects stand (infra/dev/projects-verify) builds through the same
 * code with a descriptor of its own.
 */
export const BROWSER_TASK_BUILD = Object.freeze({
  name: 'browser-task-verify',
  envPrefix: 'BROWSER_TASK_VERIFY',
  own: 'infra/dev/browser-task-verify/',
  images: BUILT_IMAGES,
})

/** Where the stand builds: outside the repository, kept between runs. */
export function copyDirectory(root, stand = BROWSER_TASK_BUILD) {
  const variable = `${stand.envPrefix}_BUILD_DIR`
  const given = process.env[variable]
  const directory = resolve(given ? given : join(tmpdir(), `raditi-${stand.name}-build`))
  if (!outside(root, directory)) throw new Error(`${variable} must be outside the repository`)
  return directory
}

/**
 * BROWSER_TASK_VERIFY_STALE_COPY=allow lets `--no-build` run on a copy that is not the tree as it
 * is now: for work on the stand itself while the tree moves under it. Such a run proves nothing
 * about the tree, and says so. Any other value is refused, and so is the variable with a build.
 */
export function staleCopyAllowed(env, options, stand = BROWSER_TASK_BUILD) {
  const variable = `${stand.envPrefix}_STALE_COPY`
  const given = env[variable]
  if (given === undefined || given === '') return false
  if (given !== 'allow') throw new Error(`${variable} takes one value, \`allow\`, or is left unset`)
  if (options.build) throw new Error(`${variable}=allow goes with --no-build only`)
  return true
}

async function treeListing(rt, stand) {
  const listed = await rt.run('git', ['-C', rt.root, 'ls-files', '-co', '--exclude-standard', '-z'])
  const present = []
  const entries = []
  // The stand itself is no part of what the copy builds: editing it keeps the builds.
  const own = (path) => path.startsWith(stand.own)
  for (const path of listed.output.split('\0').filter((path) => copyablePath(path) && !own(path))) {
    const entry = await lstat(join(rt.root, path)).catch(() => null)
    if (entry === null || entry.isDirectory()) continue
    present.push(path)
    entries.push(treeEntry(path, entry))
  }
  assert.ok(present.includes('pnpm-lock.yaml'), 'The listing of the tree has no lockfile')
  assert.ok(!present.includes('.env'), 'The repository .env must never reach the copy')
  return { present, entries }
}

async function copyListing(copy, stamp) {
  const entries = []
  for (const built of stamp.entries) {
    const [path, size] = built.split('\0')
    const held = await lstat(join(copy, path)).catch(() => null)
    if (held === null || held.isDirectory()) continue
    entries.push(
      held.isSymbolicLink() && String(held.size) === size ? built : treeEntry(path, held),
    )
  }
  return entries
}

const stampOf = (copy, stand) => join(copy, COPY_MARKER, `${stand.name}-${BUILD_STAMP}`)
const imagesStampOf = (copy, stand) => join(copy, COPY_MARKER, `${stand.name}-images.json`)

/** The copy of the tree and its builds, or the check of an earlier one (`--no-build`). */
export async function buildCopy(rt, copy, options, stand = BROWSER_TASK_BUILD) {
  const outputs = [...APP_OUTPUTS, ...(options.webDev ? [] : [WEB_OUTPUT.server])]
  if (options.build) {
    rt.setStage('copying the tree')
    const marker = join(copy, COPY_MARKER)
    if ((await exists(copy)) && !(await exists(marker)))
      assert.equal(
        (await readdir(copy)).length,
        0,
        'The build directory holds files of someone else',
      )
    await mkdir(marker, { recursive: true })
    await rm(stampOf(copy, stand), { force: true })
    const { present, entries } = await treeListing(rt, stand)
    const manifest = join(marker, 'manifest')
    const previous = (await readFile(manifest, 'utf8').catch(() => '')).split('\0').filter(Boolean)
    await writeFile(manifest, manifestDuringCopy(previous, present).join('\0'))
    const stale = staleFiles(previous, present)
    for (const path of stale) await rm(join(copy, path), { force: true })
    for (const folder of staleDirectories(stale, present))
      await rmdir(join(copy, folder)).catch(keptFolder)
    await rt.run('rsync', ['-a', '--from0', '--files-from=-', `${rt.root}/`, `${copy}/`], {
      input: present.join('\0'),
      timeoutMs: 600_000,
    })
    await writeFile(manifest, present.join('\0'))
    console.log(
      `PASS private copy of the working tree: ${entries.length} files, no .env, outside the repository`,
    )
    const env = buildEnvironment({ path: callerEnv.PATH, home: callerEnv.HOME })
    for (const step of [...BUILD_STEPS, ...(options.webDev ? [] : [WEB_BUILD_STEP])]) {
      rt.setStage(`build: ${step.title}`)
      const started = Date.now()
      await rt.run('pnpm', step.args, {
        cwd: copy,
        env: { ...env, ...step.env },
        timeoutMs: 20 * 60_000,
      })
      console.log(`PASS build: ${step.title} (${Math.round((Date.now() - started) / 1000)} s)`)
    }
    if (!options.webDev) {
      await rm(join(copy, WEB_OUTPUT.staticServed), { recursive: true, force: true })
      await cp(join(copy, WEB_OUTPUT.static), join(copy, WEB_OUTPUT.staticServed), {
        recursive: true,
      })
    }
    await writeFile(
      stampOf(copy, stand),
      buildStamp({ builtAt: new Date().toISOString(), entries }),
    )
    return { entries, stale: false }
  }
  rt.setStage('checking the builds of the copy')
  for (const path of outputs)
    assert.ok(
      await exists(join(copy, path)),
      `The copy has no build ${path}: run without --no-build`,
    )
  const stamp = readBuildStamp(await readFile(stampOf(copy, stand), 'utf8').catch(() => ''))
  const { entries } = await treeListing(rt, stand)
  const stale = staleCopy(stamp, entries, stamp === null ? [] : await copyListing(copy, stamp))
  if (stale !== null) {
    if (!staleCopyAllowed(process.env, options, stand))
      throw new Error(`--no-build is refused: ${stale}`)
    console.log(
      `NOTE ${stand.envPrefix}_STALE_COPY=allow: the builds are not of the tree as it is now (${stale}); this run proves nothing about the tree`,
    )
    return { entries: stamp?.entries ?? entries, stale: true }
  }
  console.log(
    `PASS builds of the private copy reused (--no-build): built at ${stamp.builtAt} of the tree as it is now`,
  )
  return { entries, stale: false }
}

/** The images of this tree under the stand's own names, by the digests the configuration takes. */
export async function buildImages(
  rt,
  copy,
  options,
  { entries, stale },
  stand = BROWSER_TASK_BUILD,
) {
  const digest = treeDigest(entries)
  if (options.build) {
    for (const image of Object.values(stand.images)) {
      rt.setStage(`docker build ${image.tag}`)
      const started = Date.now()
      const context = join(rt.root, image.context ?? '.')
      await rt.docker(
        [
          'build',
          '-f',
          join(rt.root, image.file),
          '--target',
          image.target,
          '-t',
          image.tag,
          context,
        ],
        { timeoutMs: 40 * 60_000 },
      )
      console.log(
        `PASS image ${image.tag} built from the tree (${Math.round((Date.now() - started) / 1000)} s)`,
      )
    }
  }
  const images = {}
  for (const [name, image] of Object.entries(stand.images)) {
    const inspected = await rt.docker(
      ['image', 'inspect', '--format', '{{json .RepoDigests}}', image.tag],
      { allowFailure: true },
    )
    if (inspected.code !== 0)
      throw new Error(`The image ${image.tag} is missing: run without --no-build`)
    images[name] = localDigestReference(image.tag, inspected.output)
  }
  if (options.build) await writeFile(imagesStampOf(copy, stand), JSON.stringify({ digest, images }))
  else {
    const stamp = JSON.parse(await readFile(imagesStampOf(copy, stand), 'utf8').catch(() => '{}'))
    const same = stamp.digest === digest && JSON.stringify(stamp.images) === JSON.stringify(images)
    if (!same && !stale)
      throw new Error('--no-build is refused: the images were not built of the tree as it is now')
    if (same)
      console.log('PASS images of the tree reused (--no-build): built of the tree as it is now')
  }
  return images
}
