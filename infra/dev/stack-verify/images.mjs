// The pinned images a run of `verify:stack` needs, one per line (docs/plan/62-slices/e3.md, Э3.13):
// what the job `stand` of site-stacks.yml pulls by digest and what colima-m7.sh checks in its VM,
// from the list the stand itself checks before it starts (`pinnedImagesOf`, stand.mjs). Nothing is
// pulled or run here.
//
//   node infra/dev/stack-verify/images.mjs --stack=<stack>         <image> per line
//   node infra/dev/stack-verify/images.mjs --stack=<stack> --tags  <image>\t<tag to pull by> per line
//   node infra/dev/stack-verify/images.mjs <build id>... [--tags]  the PHP of these builds only
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { CMS_ARCHIVES, archivesOfStack, readCmsArchives } from './fetch-cms.mjs'
import { pinnedImagesOf } from './stand.mjs'

const SITE_BASES = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../preview/site-bases.json', import.meta.url)), 'utf8'),
).versions

/** The lines this script prints for its arguments. */
export function imageLines(argv, { archives = CMS_ARCHIVES, siteBases = SITE_BASES } = {}) {
  const options = argv.filter((arg) => arg.startsWith('--'))
  const ids = argv.filter((arg) => !arg.startsWith('--'))
  const unknown = options.find((arg) => arg !== '--tags' && !arg.startsWith('--stack='))
  if (unknown) throw new Error(`unknown option ${unknown}`)
  const stack = options.find((arg) => arg.startsWith('--stack='))?.slice('--stack='.length)
  const table = readCmsArchives(archives)
  const wanted = stack !== undefined ? [...ids, ...archivesOfStack(stack, table)] : ids
  if (wanted.length === 0)
    throw new Error('usage: images.mjs --stack=<stack> | <build id>... [--tags]')
  const php = wanted.map((id) => {
    if (!table[id]) throw new Error(`cms-archives: no build ${id}`)
    return table[id].php
  })
  const tags = options.includes('--tags')
  return pinnedImagesOf(php, siteBases).map(({ image, tag }) => (tags ? `${image}\t${tag}` : image))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${imageLines(process.argv.slice(2)).join('\n')}\n`)
  } catch (error) {
    process.stderr.write(`images: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
