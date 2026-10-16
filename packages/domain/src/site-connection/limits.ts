import { publicationLimits } from '../git/publication.ts'

/**
 * Limits of the site connection wizard. Domain constants on purpose: no environment variable
 * changes a limit, a timeout or a concurrency.
 */
export const siteConnectionLimits = Object.freeze({
  /** One «Далее» check: DNS + connect + handshake + login + operation. */
  checkMs: 15_000,
  /** Both re-checks of «Добавить сайт», in parallel. */
  createChecksMs: 25_000,
  /** Everything of create before its transaction. */
  createBudgetMs: 90_000,
  /** Longer than createBudgetMs plus the transaction timeout (10 s). */
  createClaimMs: 120_000,
  /** The whole lookup: the resolver makes 2 tries of dnsMs / 2 each. */
  dnsMs: 4_000,
  checkListingBytes: 1024 * 1024,
  /** Everything a database server may send during one check. */
  checkReceivedBytes: 256 * 1024,
  rootSuggestionDirectories: 12,
  gitAdvertisementBytes: 64 * 1024,
  /** As typed; the stored canonical form may be four characters longer (`.git`): VARCHAR(1024). */
  gitUrlChars: 1020,
  privateKeyChars: 16_384,
  /** JSON of the largest secret; stays under the request limit of the KV adapter (64 KiB). */
  secretBytes: 48 * 1024,
  /** Per user; a check costs 1, create and replaceAccess cost 2. */
  checkUnitsPerWindow: 30,
  checkWindowMs: 10 * 60_000,
  /** Per (user, host, port), in the same window. */
  refusedLoginsPerWindow: 5,
  /** Per site: retry and replaceAccess together. */
  retriesPerHour: 6,
  inFlightPerUser: 2,
  inFlightPerProcess: 16,
  gateWaitMs: 3_000,
  /** Sites of the user's own workspaces with a stage queued or running. */
  connectionsInProgressPerUser: 3,
})

/** What an import may bring into a site repository: never more than a turn accepts as its base. */
export const siteImportLimits = Object.freeze({
  files: publicationLimits.repositoryFiles,
  /** A larger file is left out and counted, it does not fail the import. */
  fileBytes: publicationLimits.fileBytes,
  treeBytes: publicationLimits.treeBytes,
  /** A turn bundles the base tree. */
  bundleBytes: publicationLimits.bundleBytes,
  depth: 32,
  /** Everything the walker may see, taken or not. */
  listedEntries: 300_000,
  directories: 20_000,
  listingBytes: 8 * 1024 * 1024,
  /** `ulimit -f` for the fetch of a client repository. */
  packBytes: 256 * 1024 * 1024,
  stageMs: 60 * 60_000,
  /** A transfer without a byte. */
  idleMs: 30_000,
  /**
   * A file walk that does less than stallBytes of work in a full window fails with
   * transfer_failed; work is the downloaded bytes plus 64 for every listed entry.
   */
  stallWindowMs: 5 * 60_000,
  stallBytes: 320 * 1024,
  /** More files with scanner findings than this fails the import. */
  flaggedFiles: 200,
  /** More files holding a typed secret than this: the secret is too common to be one. */
  exactValueFiles: 50,
  scanBatchBytes: 32 * 1024 * 1024,
  scanBatchFiles: 5_000,
  hashBatchFiles: 5_000,
  hashBatchBytes: 32 * 1024 * 1024,
  /** A configuration file offered to SiteAdapter.configSecrets. */
  configFileBytes: 256 * 1024,
  ftpSessions: 2,
  sftpStreams: 4,
})

export const databaseSchemaLimits = Object.freeze({
  tables: 1_000,
  columns: 20_000,
  indexRows: 20_000,
  foreignKeyRows: 10_000,
  identifierChars: 128,
  typeChars: 128,
  storedBytes: 2 * 1024 * 1024,
  queryMs: 10_000,
  stageMs: 60_000,
  /** Everything the server may send while its structure is read. */
  receivedBytes: 16 * 1024 * 1024,
  serverVersionChars: 64,
})

export const provisioningLimits = Object.freeze({
  importConcurrency: 2,
  schemaConcurrency: 2,
  importsPerWorkspace: 1,
  heartbeatMs: 15_000,
  /** A running stage without a heartbeat for this long goes back to the queue. */
  staleMs: 120_000,
  /** A stage that sat queued for this long gets a wake-up job; it is never failed by age. */
  queuedStaleMs: 300_000,
  sweepMs: 60_000,
  /** Returns from running to queued within one attempt before the stage fails as interrupted. */
  enqueuesPerAttempt: 5,
  /** A stage released at shutdown becomes available again after this delay. */
  releaseDelayMs: 45_000,
})
