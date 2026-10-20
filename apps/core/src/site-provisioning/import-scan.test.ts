import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { trustedGitEnvironment } from '../git-workspace/trusted-git.ts'
import { scanForSecrets } from './import-scan.ts'
import type { TakenFile } from './tree-walk.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** Reports every copy that holds `leak`; `bad-report` writes a report naming no copy of the batch. */
async function setup(contents: string[], script?: string) {
  const root = await mkdtemp(join(tmpdir(), 'raditi-import-scan-test-'))
  roots.push(root)
  const work = join(root, 'work')
  const scanner = join(root, 'scanner.mjs')
  const log = join(root, 'scanner.log')
  await writeFile(
    scanner,
    script ??
      `#!${process.execPath}
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const files = readdirSync('.')
appendFileSync(${JSON.stringify(log)}, JSON.stringify(files) + '\\n')
const report = args[args.indexOf('--report-path') + 1]
const found = files.filter((name) => readFileSync(name, 'latin1').includes('leak')).map((name) => ({ File: './' + name }))
if (files.some((name) => readFileSync(name, 'latin1').includes('bad-report'))) found.push({ File: '../outside' })
writeFileSync(report, JSON.stringify(found))
process.exit(found.length ? 99 : 0)
`,
    { mode: 0o700 },
  )
  const files: TakenFile[] = []
  for (const [index, content] of contents.entries()) {
    const blob = join(root, `blob-${index}`)
    await writeFile(blob, content)
    files.push({ path: `f${index}.php`, blob, bytes: Buffer.byteLength(content) })
  }
  await mkdir(work, { mode: 0o700 })
  return {
    files,
    log,
    work,
    scan: (limits = {}) =>
      scanForSecrets({
        files,
        root: work,
        gitleaksBinary: scanner,
        env: trustedGitEnvironment({ home: work, protocol: 'file' }),
        signal: new AbortController().signal,
        limits,
      }),
  }
}

// Each case runs scanner processes: slow on a loaded machine (the parallel gates), not stuck —
// the 30 s of CI's --testTimeout, also when the local gates run without it.
describe('scanForSecrets', { timeout: 30_000 }, () => {
  it('names the flagged files across batches and leaves no copy behind', async () => {
    const s = await setup(['clean', 'a leak', 'clean', 'clean', 'leak again'])
    const flagged = await s.scan({ scanBatchFiles: 2 })
    expect([...flagged].sort()).toEqual([1, 4])
    // Three batches of numbered copies, never a path of the client.
    const batches = (await readFile(s.log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(batches).toEqual([['0', '1'], ['0', '1'], ['0']])
    expect((await readdir(s.work)).sort()).toEqual(['gitleaks-empty', 'gitleaks.toml'])
  })

  it('fails source_has_secrets past flaggedFiles', async () => {
    const s = await setup(['leak', 'leak', 'leak'])
    await expect(s.scan({ flaggedFiles: 2 })).rejects.toMatchObject({ code: 'source_has_secrets' })
  })

  it('fails scan_failed on an error of the scanner and on a report of something else', async () => {
    const broken = await setup(['x'], `#!${process.execPath}\nprocess.exit(1)\n`)
    await expect(broken.scan()).rejects.toMatchObject({ code: 'scan_failed' })
    const odd = await setup(['bad-report'])
    await expect(odd.scan()).rejects.toMatchObject({ code: 'scan_failed' })
    const missing = await setup(['x'], `#!${process.execPath}\nprocess.exit(99)\n`)
    await expect(missing.scan()).rejects.toMatchObject({ code: 'scan_failed' })
  })
})
