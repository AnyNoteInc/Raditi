// Prints only yes/no per directory or file of PROBE_OUT: does it hold a piece of the key or a non-dummy bearer value.
// Usage: PROBE_KEY_FILE=… PROBE_OUT=… node leak-check.mjs
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { leakCheck, OUT } from './zai.mjs'

for (const name of [
  'samples',
  'runs',
  'upstream-count.txt',
  'other-destinations.log',
  'oc-proxy.log',
]) {
  const path = join(OUT, name)
  if (!existsSync(path)) {
    console.log(`leak in ${name}: (absent)`)
    continue
  }
  // leakCheck walks a directory; a single file is checked through its parent with the others skipped.
  console.log(
    `leak in ${name}: ${statSync(path).isDirectory() ? leakCheck(path) : leakCheck(OUT, name)}`,
  )
}
