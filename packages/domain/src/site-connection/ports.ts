import type { z } from 'zod'

import type { AppEnv } from '../app-env.ts'
import type { SecretStore } from '../ports/secret-store.ts'
import type { SiteAccessKind, SiteStack } from '../ports/site-adapter.ts'
import type { CodeSourceTarget, DatabaseTarget, PreparedAccess } from './access.ts'
import type { HostLookup, PinnedAddress } from './address.ts'
import type { DatabaseStructure } from './database-schema.ts'
import type { CodeSourceInput, DatabaseInput } from './inputs.ts'
import type { DatabaseEngine, SiteSourceKind } from './kinds.ts'
import type { ConnectionCheckReason } from './reasons.ts'

// Ports of the site connection: where the files of a site come from (SiteSourceAdapter) and
// what reads the structure of its database (DatabaseInspector). All implementations live in
// @repo/site-connections; a transport and the worker index them by kind and never compare one.

export interface ConnectionContext {
  address: PinnedAddress
  /** One deadline for everything; aborting destroys every socket. */
  signal: AbortSignal
}

export interface SourceCheckContext extends ConnectionContext {
  /** Entries the root folder must have (SiteAdapter.rootMarkers of the chosen stack). */
  markers: readonly string[]
  /**
   * create and replaceAccess: an adapter that pins a host key refuses when none was sent. (The worker does
   * not come through `check`: `open` and `probe` take the secret, which always holds the key.)
   */
  pinRequired: boolean
}

export interface SourceCheckPassed {
  /** sftp: the key the server presented; else null. */
  hostKey: string | null
  /** git: the address after the one allowed redirect; else null. */
  canonicalUrl: string | null
  defaultBranch: string | null
  /** ftp, sftp: entries in the root folder; else null. */
  entries: number | null
}

export type SourceCheckOutcome =
  | ({ ok: true } & SourceCheckPassed)
  /** `suggestedRoot`: only with `not_site_root`, a folder one level down that has the markers. */
  | { ok: false; reason: ConnectionCheckReason; suggestedRoot?: string }

export type DatabaseCheckOutcome =
  { ok: true; tables: number } | { ok: false; reason: ConnectionCheckReason }

/** A failure inside an open session or a schema read: a reason, never the server's text. */
export class SiteConnectionError extends Error {
  readonly reason: ConnectionCheckReason

  constructor(reason: ConnectionCheckReason) {
    super(`Site connection: ${reason}`)
    this.name = 'SiteConnectionError'
    this.reason = reason
  }
}

/** Checks the name, not `instanceof`: works across duplicated module instances. */
export function isSiteConnectionError(error: unknown): error is SiteConnectionError {
  return error instanceof Error && error.name === 'SiteConnectionError'
}

/**
 * A guard of a file session tripped: not a connection failure, and the walker maps each differently —
 * `bytes` (a file longer than `maxBytes`) → `source_inconsistent`; `entries` and `listing` (a directory
 * past `maxEntries` or the listing byte cap) → `source_too_large`; `outside_root` (the directory the server
 * entered is not the listed one below the root: a link shown as a folder) → counted as `link`, not descended.
 */
export class FileSourceGuardError extends Error {
  readonly guard: 'bytes' | 'entries' | 'listing' | 'outside_root'

  constructor(guard: FileSourceGuardError['guard']) {
    super(`File source guard: ${guard}`)
    this.name = 'FileSourceGuardError'
    this.guard = guard
  }
}

/** By name, as the guards above. */
export function isFileSourceGuardError(error: unknown): error is FileSourceGuardError {
  return error instanceof Error && error.name === 'FileSourceGuardError'
}

export interface FileSourceEntry {
  /**
   * One path segment decoded for the repository; never trusted as a path. A name that could not be
   * decoded carries U+FFFD and is refused by `isImportSegment`.
   */
  name: string
  /** The same segment as the server understands it (FTP: the raw bytes as latin1). */
  ref: string
  type: 'file' | 'directory' | 'link' | 'other'
  /** As listed; advisory. */
  size: number
}

export interface FileSourceSession {
  /**
   * How many `read` calls the caller may run at once (ftp: `ftpSessions`, sftp: `sftpStreams`); `list` calls
   * are made one at a time. The walker never looks at the kind: it reads this number.
   */
  readonly concurrency: number
  /**
   * Entries of one directory below the root (`refs` of its segments). Before listing, the adapter makes the
   * server confirm where it is (FTP: `PWD` after `CWD` equals the parent's `PWD` plus the segment; SFTP:
   * `realpath(dir)` equals `realpath(root)` plus the segments) and rejects with
   * `FileSourceGuardError('outside_root')` otherwise. Past `maxEntries` → `FileSourceGuardError('entries')`,
   * past the listing byte cap → `FileSourceGuardError('listing')`. A broken or idle transfer →
   * `SiteConnectionError('transfer_failed')`.
   */
  list(directory: readonly string[], maxEntries: number): Promise<FileSourceEntry[]>
  /**
   * Streams one file into `sink` and resolves with the byte count. More than `maxBytes` →
   * `FileSourceGuardError('bytes')`; no byte for `idleMs`, or a broken transfer →
   * `SiteConnectionError('transfer_failed')`; no such file → `SiteConnectionError('not_found')`.
   */
  read(
    path: readonly string[],
    sink: (chunk: Uint8Array) => Promise<void>,
    maxBytes: number,
  ): Promise<number>
  close(): Promise<void>
}

interface SiteSourceAdapterBase<Access> {
  readonly kind: SiteSourceKind
  /** credential_refs.kind and the last segment of the Vault path. */
  readonly accessKind: SiteAccessKind
  readonly accessSchema: z.ZodType<Access>
  readonly defaultPort: number
  /** Host and port a check of this input connects to. */
  endpoint(input: CodeSourceInput): { host: string; port: number }
  check(input: CodeSourceInput, context: SourceCheckContext): Promise<SourceCheckOutcome>
  /** The Vault record and the row of a checked input (`hostKey` and `canonicalUrl` come from `passed`). */
  prepare(input: CodeSourceInput, passed: SourceCheckPassed): PreparedAccess<CodeSourceTarget>
  // worker side
  endpointOf(access: Access): { host: string; port: number }
  /**
   * The stored row and the stored secret agree on everything both hold: host, port, and — by kind — the TLS
   * mode, the host key, the folder, the repository address and the branch.
   */
  matchesTarget(access: Access, target: CodeSourceTarget): boolean
  /** Values that must not appear in an imported file. */
  scanValues(access: Access): string[]
}

export interface FileSourceAdapter<Access = unknown> extends SiteSourceAdapterBase<Access> {
  readonly transfer: 'files'
  /** Connects by the secret alone (its host key, TLS mode and folder); `target` is not consulted. */
  open(access: Access, context: ConnectionContext): Promise<FileSourceSession>
}

export interface GitSourceAdapter<Access = unknown> extends SiteSourceAdapterBase<Access> {
  readonly transfer: 'git'
  /**
   * The worker-side form of `check`: the same two `info/refs` requests, from the stored secret. The import
   * stage calls it before the fetch, because the trusted git discards stderr and a failed fetch has no
   * precise reason. Core holds an `Access`, never a `CodeSourceInput`.
   */
  probe(access: Access, context: ConnectionContext): Promise<SourceCheckOutcome>
  /** What the trusted git of core needs; the token never goes into argv or a URL. */
  remote(access: Access): { url: string; branch: string | null; username: string; token: string }
}

/** How the import stage obtains the tree is the adapter's declaration; core never compares a kind. */
export type SiteSourceAdapter<Access = unknown> =
  FileSourceAdapter<Access> | GitSourceAdapter<Access>

export interface DatabaseInspector<Access = unknown> {
  readonly engine: DatabaseEngine
  readonly accessKind: SiteAccessKind
  readonly accessSchema: z.ZodType<Access>
  readonly defaultPort: number
  endpoint(input: DatabaseInput): { host: string; port: number }
  /** Connect, `SELECT 1`, count the tables of this database through the catalog. No user table is read. */
  check(input: DatabaseInput, context: ConnectionContext): Promise<DatabaseCheckOutcome>
  prepare(input: DatabaseInput): PreparedAccess<DatabaseTarget>
  endpointOf(access: Access): { host: string; port: number }
  matchesTarget(access: Access, target: DatabaseTarget): boolean
  scanValues(access: Access): string[]
  /**
   * Catalog only, read-only transaction, bounded by databaseSchemaLimits; connects by the secret (its host,
   * port and TLS mode). `serverVersion` is what the server answered to its version query, cut to
   * `serverVersionChars` and stripped of control characters, or null. Rejects with SiteConnectionError.
   */
  readSchema(
    access: Access,
    context: ConnectionContext,
  ): Promise<{ structure: DatabaseStructure; serverVersion: string | null }>
}

/** What `apps/web` injects into the tRPC context. Registries are indexed by kind, never compared. */
export interface SiteConnectionServices {
  /** The procedures of `siteConnection` read the environment from here, never from `process.env`. */
  appEnv: AppEnv
  /** Write only, as the `sites-writer` policy: no read method is reachable from a procedure. */
  secrets: Pick<SecretStore, 'kvWrite' | 'kvMetadata'>
  lookup: HostLookup
  connectableStacks: readonly SiteStack[]
  rootMarkers(stack: SiteStack): readonly string[]
  sources(kind: SiteSourceKind): SiteSourceAdapter
  databases(engine: DatabaseEngine): DatabaseInspector
  /** What `options` returns as `sources` and `databases`. */
  sourceOptions: readonly { kind: SiteSourceKind; defaultPort: number }[]
  databaseOptions: readonly { engine: DatabaseEngine; defaultPort: number }[]
}
