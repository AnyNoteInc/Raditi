// Keeps in .turbo/cache only the entries of the tasks this job's turbo runs used: their hashes
// are in the run summaries turbo writes to .turbo/runs/*.json when TURBO_RUN_SUMMARY is set.
// Without a summary nothing is known to be used, and the cache is emptied rather than saved stale.
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const cache = '.turbo/cache'
const runs = '.turbo/runs'
const list = (dir) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

const used = new Set()
for (const name of list(runs).filter((file) => file.endsWith('.json')))
  for (const task of JSON.parse(readFileSync(join(runs, name), 'utf8')).tasks ?? [])
    if (task.hash) used.add(task.hash)

let kept = 0
let dropped = 0
for (const name of list(cache)) {
  // <hash>.tar.zst and <hash>-meta.json
  const hash = name.split(/[.-]/, 1)[0]
  if (used.has(hash)) kept++
  else {
    rmSync(join(cache, name), { recursive: true, force: true })
    dropped++
  }
}
console.log(`turbo cache: ${used.size} hashes used, ${kept} entries kept, ${dropped} dropped`)
