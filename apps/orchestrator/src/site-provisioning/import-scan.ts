import { Buffer } from 'node:buffer'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { siteImportLimits } from '@repo/domain'
import { z } from 'zod'

import { scanCopy } from '../git-workspace/git-workspace.service.ts'
import { runProcess } from '../git-workspace/process.ts'
import { refuse } from './import-failure.ts'
import type { TakenFile } from './tree-walk.ts'

/** The header the publication scan puts in front of every copy (scanCopy): read whatever follows. */
const SCAN_PREFIX = scanCopy(Buffer.alloc(0))
/** The configuration of the publication scan: the default rules, nothing of the client's. */
const GITLEAKS_CONFIG = '[extend]\nuseDefault = true\n'
/** Gitleaks exits 1 on its own errors too: `--exit-code` changes only the code of a finding. */
const GITLEAKS_FINDING_EXIT = 99
/** Many more findings than flaggedFiles files can make: the import has failed long before. */
const REPORT_BYTES = 32 * 1024 * 1024

/** Only `File` matters: the number of the copy. The rest is redacted and never read. */
const reportSchema = z.array(z.looseObject({ File: z.string() }))

export type ScanLimits = Record<'scanBatchBytes' | 'scanBatchFiles' | 'flaggedFiles', number>

export interface ScanInput {
  files: readonly TakenFile[]
  /** A private directory of the stage: configuration, copies and reports live here, briefly. */
  root: string
  gitleaksBinary: string
  /** The environment of the trusted git: nothing of core's own. */
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  limits?: Partial<ScanLimits>
}

/** Consecutive groups of files within the batch limits; a single larger file is a group of its own. */
function scanBatches(files: readonly TakenFile[], limits: ScanLimits): number[][] {
  const groups: number[][] = []
  let bytes = 0
  for (const [index, file] of files.entries()) {
    const last = groups.at(-1)
    if (
      !last ||
      last.length >= limits.scanBatchFiles ||
      bytes + file.bytes > limits.scanBatchBytes
    ) {
      groups.push([index])
      bytes = file.bytes
    } else {
      last.push(index)
      bytes += file.bytes
    }
  }
  return groups
}

/**
 * Gitleaks over every taken file, as the publication of a turn scans its changes: host-numbered
 * private copies behind the image header, the host's configuration, `gitleaks:allow` ignored, no
 * `.gitleaksignore` of the client, the findings redacted. Returns the indexes of the files with a
 * finding; more of them than `flaggedFiles` fail the import `source_has_secrets`, a scanner that
 * cannot finish fails it `scan_failed`.
 */
export async function scanForSecrets(input: ScanInput): Promise<Set<number>> {
  const { files, root, signal } = input
  const limits: ScanLimits = { ...siteImportLimits, ...input.limits }
  const flagged = new Set<number>()
  if (files.length === 0) return flagged
  const config = join(root, 'gitleaks.toml')
  const ignore = join(root, 'gitleaks-empty')
  await writeFile(config, GITLEAKS_CONFIG, { mode: 0o600, flag: 'wx' })
  await mkdir(ignore, { mode: 0o700 })
  await writeFile(join(ignore, '.gitleaksignore'), '', { mode: 0o600, flag: 'wx' })
  for (const [number, batch] of scanBatches(files, limits).entries()) {
    signal.throwIfAborted()
    const directory = join(root, `scan-${number}`)
    const report = join(root, `scan-${number}.json`)
    await mkdir(directory, { mode: 0o700 })
    try {
      for (const [copy, index] of batch.entries()) {
        const target = join(directory, String(copy))
        await writeFile(target, SCAN_PREFIX, { mode: 0o600, flag: 'wx' })
        await pipeline(
          createReadStream(files[index]!.blob),
          createWriteStream(target, { flags: 'a' }),
        )
      }
      let code: number
      try {
        ;({ code } = await runProcess(
          input.gitleaksBinary,
          [
            'dir',
            '.',
            '--config',
            config,
            '--gitleaks-ignore-path',
            ignore,
            '--ignore-gitleaks-allow',
            '--redact=100',
            '--no-banner',
            '--no-color',
            '--log-level=error',
            `--exit-code=${GITLEAKS_FINDING_EXIT}`,
            '--report-format',
            'json',
            '--report-path',
            report,
          ],
          { cwd: directory, env: input.env, maxBytes: 64 * 1024 },
        ))
      } catch {
        throw refuse('scan_failed')
      }
      if (code === 0) continue
      if (code !== GITLEAKS_FINDING_EXIT) throw refuse('scan_failed')
      for (const copy of await reportedCopies(report, batch.length)) {
        flagged.add(batch[copy]!)
        if (flagged.size > limits.flaggedFiles) throw refuse('source_has_secrets')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
      await rm(report, { force: true })
    }
  }
  return flagged
}

/** The copies a report names; a report that cannot be one fails the scan. */
async function reportedCopies(report: string, copies: number): Promise<Set<number>> {
  let size: number
  try {
    size = (await stat(report)).size
  } catch {
    throw refuse('scan_failed')
  }
  if (size > REPORT_BYTES) throw refuse('source_has_secrets')
  let parsed: z.infer<typeof reportSchema>
  try {
    parsed = reportSchema.parse(JSON.parse(await readFile(report, 'utf8')))
  } catch {
    throw refuse('scan_failed')
  }
  const named = new Set<number>()
  for (const finding of parsed) {
    const name = finding.File.replace(/^\.\//, '')
    const copy = /^(?:0|[1-9]\d{0,8})$/.test(name) ? Number(name) : -1
    if (copy < 0 || copy >= copies) throw refuse('scan_failed')
    named.add(copy)
  }
  // Exit code of a finding without one named: not a report of this scan.
  if (named.size === 0) throw refuse('scan_failed')
  return named
}
