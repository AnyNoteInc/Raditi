import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { siteImportLimits, type SiteAdapter } from '@repo/domain'

import type { TakenFile } from './tree-walk.ts'

// The files the secret scan of an import flagged that are public code (owner's decision of
// 26.10.2026): the adapter of the stack names where the published original of each lives, and a
// file whose original is the same bytes is taken after all. The platform compares; it knows no
// stack and no host of their publishers.

/** Downloads at most `maxBytes` of a published original; null — none was had. */
export type FetchOriginal = (
  url: string,
  maxBytes: number,
  signal: AbortSignal,
) => Promise<Uint8Array | null>

/** One original: an https URL without credentials, at most 15 s, no redirect, `maxBytes`. */
export const fetchOriginal: FetchOriginal = async (url, maxBytes, signal) => {
  const parsed = URL.parse(url)
  if (parsed === null || parsed.protocol !== 'https:' || parsed.username || parsed.password)
    return null
  const response = await fetch(parsed, {
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  })
  if (!response.ok || response.body === null) return null
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) return null
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.byteLength
    if (total > maxBytes) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * The indexes among `flagged` of the files that are their published originals byte for byte.
 * Whatever fails — the adapter, a download, a comparison — leaves the file out, as before.
 */
export async function publicOriginalsOf(input: {
  rules: Pick<SiteAdapter, 'publicOriginals'>
  files: readonly TakenFile[]
  flagged: ReadonlySet<number>
  signal: AbortSignal
  fetch: FetchOriginal
}): Promise<Set<number>> {
  const { rules, files, flagged, signal } = input
  const vouched = new Set<number>()
  if (flagged.size === 0 || !rules.publicOriginals) return vouched
  const byPath = new Map(files.map((file, index) => [file.path, index]))
  const read = async (path: string): Promise<Uint8Array | null> => {
    const index = byPath.get(path)
    const file = index === undefined ? undefined : files[index]
    if (!file || file.bytes > siteImportLimits.configFileBytes) return null
    return readFile(file.blob)
  }
  let originals: ReadonlyMap<string, string>
  try {
    originals = await rules.publicOriginals(
      [...flagged].map((index) => files[index]!.path),
      read,
    )
  } catch {
    return vouched
  }
  for (const index of flagged) {
    signal.throwIfAborted()
    const file = files[index]!
    const url = originals.get(file.path)
    if (url === undefined) continue
    const original = await input.fetch(url, file.bytes, signal).catch(() => null)
    if (original === null || original.byteLength !== file.bytes) continue
    if (sha256(original) === sha256(await readFile(file.blob))) vouched.add(index)
  }
  return vouched
}
