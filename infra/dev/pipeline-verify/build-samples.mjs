// Writes the fixture module of the webhook tests from a directory recorded by
// `pnpm verify:pipeline --record=<absolute directory>`. The bodies are taken as they are: the
// stand has already sanitised them and refused a body it could not clean.
//
//   node infra/dev/pipeline-verify/build-samples.mjs <absolute --record directory> [YYYY-MM-DD]
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { samplesModule } from './stand.mjs'

const here = fileURLToPath(new URL('./', import.meta.url))
const target = resolve(
  here,
  '../../../packages/git-providers/src/testing/gitea-webhooks-recorded.ts',
)

const [directory, date = new Date().toISOString().slice(0, 10), ...rest] = process.argv.slice(2)
if (!directory || !isAbsolute(directory) || rest.length > 0) {
  console.error('Usage: build-samples.mjs <absolute --record directory> [YYYY-MM-DD]')
  process.exit(2)
}
const files = {}
for (const name of (await readdir(directory)).filter((entry) => entry.endsWith('.json')))
  files[name] = await readFile(join(directory, name), 'utf8')
await writeFile(target, samplesModule({ files, date }))
console.log(`written ${Object.keys(files).length} samples to ${target}`)
