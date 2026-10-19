// A FileSourceSession over an in-memory tree, for the walker and the import tests: what an SFTP
// or FTP adapter of @repo/site-connections promises, without a server. Only for *.test.ts files.
import { Buffer } from 'node:buffer'

import {
  FileSourceGuardError,
  SiteConnectionError,
  type ConnectionCheckReason,
  type FileSourceEntry,
  type FileSourceSession,
} from '@repo/domain'

export type FakeNode =
  | {
      type: 'file'
      content: Buffer | string
      /** What the listing says; the content length by default. */
      listedSize?: number
      /** A read of this file fails with this reason. */
      fails?: ConnectionCheckReason
      /** A pause before every chunk of this file, as a server that goes quiet. */
      delayMs?: number
    }
  | ({ type: 'directory'; children: Record<string, FakeNode> } & DirectoryOptions)
  | { type: 'link' }
  | { type: 'other' }

export interface DirectoryOptions {
  outsideRoot?: boolean
  /** A listing of this folder fails with this reason. */
  fails?: ConnectionCheckReason
  /** How long the listing of this folder takes to come in. */
  listDelayMs?: number
}

export const file = (
  content: Buffer | string,
  extra: Partial<Extract<FakeNode, { type: 'file' }>> = {},
): FakeNode => ({
  type: 'file',
  content,
  ...extra,
})
export const directory = (
  children: Record<string, FakeNode>,
  options: boolean | DirectoryOptions = false,
): FakeNode => ({
  type: 'directory',
  children,
  ...(typeof options === 'boolean' ? { outsideRoot: options } : options),
})

export interface FakeSession extends FileSourceSession {
  lists: string[][]
  reads: string[][]
  /** The most `read` calls that ran at once, and whether a `list` ever ran beside a `read`. */
  peakReads: number
  listedDuringRead: boolean
  closed: boolean
}

/** Splits every file into chunks of this many bytes: a value can straddle two of them. */
const CHUNK = 7

export function fakeSession(
  root: Record<string, FakeNode>,
  options: { concurrency?: number; delayMs?: number; signal?: AbortSignal } = {},
): FakeSession {
  const tree: FakeNode = { type: 'directory', children: root }
  let reading = 0
  const find = (path: readonly string[]): FakeNode | undefined => {
    let node: FakeNode | undefined = tree
    for (const segment of path) {
      if (node?.type !== 'directory') return undefined
      node = Object.hasOwn(node.children, segment) ? node.children[segment] : undefined
    }
    return node
  }
  const wait = (ms: number | undefined) =>
    ms ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
  const pause = () => wait(options.delayMs)
  const session: FakeSession = {
    concurrency: options.concurrency ?? 2,
    lists: [],
    reads: [],
    peakReads: 0,
    listedDuringRead: false,
    closed: false,
    async list(path, maxEntries) {
      session.lists.push([...path])
      if (reading > 0) session.listedDuringRead = true
      options.signal?.throwIfAborted()
      const node = find(path)
      if (node?.type !== 'directory') throw new SiteConnectionError('not_found')
      if (node.outsideRoot) throw new FileSourceGuardError('outside_root')
      if (node.fails) throw new SiteConnectionError(node.fails)
      const entries: FileSourceEntry[] = Object.entries(node.children).map(([name, child]) => ({
        name,
        ref: name,
        type: child.type,
        size: child.type === 'file' ? (child.listedSize ?? Buffer.byteLength(child.content)) : 0,
      }))
      if (entries.length > maxEntries) throw new FileSourceGuardError('entries')
      await pause()
      await wait(node.listDelayMs)
      // An aborted session destroys its sockets: what was still coming in never arrives.
      options.signal?.throwIfAborted()
      return entries
    },
    async read(path, sink, maxBytes) {
      session.reads.push([...path])
      reading += 1
      session.peakReads = Math.max(session.peakReads, reading)
      try {
        options.signal?.throwIfAborted()
        const node = find(path)
        if (node?.type !== 'file') throw new SiteConnectionError('not_found')
        if (node.fails) throw new SiteConnectionError(node.fails)
        const content = Buffer.from(node.content)
        let sent = 0
        for (let at = 0; at < content.byteLength; at += CHUNK) {
          await pause()
          await wait(node.delayMs)
          options.signal?.throwIfAborted()
          const chunk = content.subarray(at, at + CHUNK)
          if (sent + chunk.byteLength > maxBytes) throw new FileSourceGuardError('bytes')
          sent += chunk.byteLength
          await sink(chunk)
        }
        return sent
      } finally {
        reading -= 1
      }
    },
    async close() {
      session.closed = true
    },
  }
  return session
}
