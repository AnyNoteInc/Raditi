// Entry of the G1 spike (docs/plan/40-opencode-spike.md):
//   node spike.mjs <runc|runsc> <point>...      points: p1 p2 p3 p4 p6 p7 (p5 is strings.mjs, p8 was a live step)
//   node spike.mjs <runc|runsc> up | down       only bring the stand up, or remove everything the spike made
// Each point starts from a fresh stand and writes $SPIKE_OUT/<runtime>/<point>.json plus the raw files of
// every run under $SPIKE_OUT/<runtime>/<run>/. See lib.mjs for the environment.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Stand } from './lib.mjs'

const [runtime, ...points] = process.argv.slice(2)
const stand = new Stand(runtime)
if (points[0] === 'up') {
  await stand.up()
  process.exit(0)
}
if (points[0] === 'down') {
  await stand.down()
  process.exit(0)
}
/** Variants a point ran in parallel and lost: `pool` of lib.mjs turns a thrown error into `{ failed }`. */
function lostVariants(value, found = []) {
  if (Array.isArray(value)) for (const item of value) lostVariants(item, found)
  else if (value && typeof value === 'object') {
    if (typeof value.failed === 'string') found.push(value.failed)
    for (const item of Object.values(value)) lostVariants(item, found)
  }
  return found
}
let failed = false
for (const point of points) {
  const started = Date.now()
  await stand.up()
  try {
    const module = await import(`./${point}.mjs`)
    const result = await module[point](stand)
    writeFileSync(join(stand.out, `${point}.json`), `${JSON.stringify(result, null, 1)}\n`)
    console.log(`### ${point} under ${runtime}: ${Math.round((Date.now() - started) / 1000)} s`)
    console.log(JSON.stringify(result, null, 1))
    for (const lost of lostVariants(result)) {
      failed = true
      console.log(`### ${point} under ${runtime}: a variant FAILED: ${lost}`)
    }
  } catch (error) {
    failed = true
    console.log(`### ${point} under ${runtime} FAILED: ${error?.stack ?? error}`)
  } finally {
    // Everything the sink saw during the point, whichever container asked. A sink that holds a credential
    // of the stand is not written down and fails the point.
    const sink = await stand.sink().catch((error) => {
      if (!/holds a credential/.test(String(error?.message))) return 'unavailable'
      failed = true
      console.log(`### ${point} under ${runtime} FAILED: ${error.message}`)
      return 'refused: it holds a credential of the stand'
    })
    writeFileSync(join(stand.out, `${point}.sink.json`), `${JSON.stringify(sink, null, 1)}\n`)
    await stand.down()
  }
}
process.exit(failed ? 1 : 0)
