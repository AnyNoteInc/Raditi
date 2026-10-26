import { describe, expect, it } from 'vitest'

import { publicationLimits } from '../git/publication.ts'
import { queueNames } from '../ports/job-queue.ts'
import {
  connectionTlsModes,
  databaseEngines,
  INITIAL_SITE_TAG,
  provisioningStages,
  provisioningSteps,
  provisioningStageStatuses,
  SITE_REPOSITORY_OWNER,
  siteRepositoryName,
  siteSourceKinds,
} from './kinds.ts'
import {
  databaseSchemaLimits,
  provisioningLimits,
  siteConnectionLimits,
  siteImportLimits,
} from './limits.ts'
import {
  SITE_IMPORT_QUEUE,
  SITE_PROVISION_JOB,
  SITE_PROVISIONING_QUEUE,
  siteProvisionDedupeKey,
  siteProvisionJobSchema,
  siteProvisionQueue,
  siteProvisionWakeJobId,
  siteSetupState,
} from './provisioning.ts'
import {
  connectionCheckReasons,
  importSkipReasons,
  provisioningErrorCodes,
  provisioningStageSummarySchema,
} from './reasons.ts'

const siteId = '0196abcd-0000-8000-8000-00000000000f'

describe('provisioning queues', () => {
  it('gives the long stage a queue of its own, so a short one never waits behind it', () => {
    expect(siteProvisionQueue('code_import')).toBe('site-import')
    expect(siteProvisionQueue('database_schema')).toBe('site-provisioning')
    expect(SITE_IMPORT_QUEUE).toBe('site-import')
    expect(SITE_PROVISIONING_QUEUE).toBe('site-provisioning')
  })

  it('maps every stage to a queue of the platform', () => {
    for (const stage of provisioningStages) expect(queueNames).toContain(siteProvisionQueue(stage))
    // Only the two names of this feature: the list is shared, and a queue added elsewhere is not its business.
    expect(queueNames).toContain('site-provisioning')
    expect(queueNames).toContain('site-import')
    expect(SITE_PROVISION_JOB).toBe('site.provision')
  })
})

describe('siteProvisionJobSchema', () => {
  it('carries ids only', () => {
    for (const stage of provisioningStages)
      expect(siteProvisionJobSchema.parse({ siteId, stage })).toEqual({ siteId, stage })
    for (const extra of [
      { attempt: 1 },
      { host: 'ftp.example.ru' },
      { password: 'secret' },
      { vaultPath: `kv/sites/${siteId}/ftp` },
    ])
      expect(
        siteProvisionJobSchema.safeParse({ siteId, stage: 'code_import', ...extra }).success,
      ).toBe(false)
  })

  it('refuses anything but a site id and a known stage', () => {
    for (const job of [
      {},
      { siteId },
      { stage: 'code_import' },
      { siteId: 'site', stage: 'code_import' },
      { siteId: `${siteId}/../x`, stage: 'code_import' },
      { siteId, stage: 'repository' },
      { siteId, stage: '' },
      null,
      'site.provision',
    ])
      expect(siteProvisionJobSchema.safeParse(job).success).toBe(false)
  })
})

describe('job ids of a stage', () => {
  it('builds the outbox key from the site, the stage and both counters', () => {
    expect(siteProvisionDedupeKey(siteId, 'code_import', 1, 1)).toBe(
      `site-provisioning:${siteId}:code_import:1:1`,
    )
    expect(siteProvisionDedupeKey(siteId, 'database_schema', 3, 2)).toBe(
      `site-provisioning:${siteId}:database_schema:3:2`,
    )
    // A repeated key is skipped silently for days, so each of the four parts must change it.
    const events: Parameters<typeof siteProvisionDedupeKey>[] = [
      [siteId, 'code_import', 1, 1],
      ['0196abcd-0000-8000-8000-000000000010', 'code_import', 1, 1],
      [siteId, 'database_schema', 1, 1],
      [siteId, 'code_import', 2, 1],
      [siteId, 'code_import', 1, 2],
      [siteId, 'code_import', 11, 1],
      [siteId, 'code_import', 1, 11],
    ]
    expect(new Set(events.map((event) => siteProvisionDedupeKey(...event))).size).toBe(
      events.length,
    )
    // The longest key the columns allow (attempt and enqueues are INTEGER) fits outbox_events.dedupe_key.
    const longest = siteProvisionDedupeKey(siteId, 'database_schema', 2_147_483_647, 2_147_483_647)
    expect(longest.length).toBeLessThanOrEqual(255)
  })

  it('builds the id of a wake-up from the site, the stage, the attempt and a tag', () => {
    expect(siteProvisionWakeJobId(siteId, 'code_import', 2, '5870000')).toBe(
      `site-provisioning:${siteId}:code_import:2:wake:5870000`,
    )
    expect(siteProvisionWakeJobId(siteId, 'code_import', 2, `next-${siteId}-7`)).toBe(
      `site-provisioning:${siteId}:code_import:2:wake:next-${siteId}-7`,
    )
    expect(siteProvisionWakeJobId(siteId, 'code_import', 2, '5870000')).not.toBe(
      siteProvisionWakeJobId(siteId, 'code_import', 2, '5870001'),
    )
  })

  it('never lets a wake-up take the id of an outbox event', () => {
    // An id that is already in Redis makes the enqueue a no-op: a wake-up must not swallow an event.
    for (const stage of provisioningStages)
      for (const tag of ['1', '5870000', `next-${siteId}-1`])
        for (const enqueues of [1, 2, 5])
          expect(siteProvisionWakeJobId(siteId, stage, 1, tag)).not.toBe(
            siteProvisionDedupeKey(siteId, stage, 1, enqueues),
          )
  })
})

describe('kinds', () => {
  it('lists the values of the PostgreSQL enums, in their order', () => {
    expect(siteSourceKinds).toEqual(['ftp', 'sftp', 'git'])
    expect(databaseEngines).toEqual(['mysql', 'postgres'])
    expect(connectionTlsModes).toEqual(['verified', 'unverified', 'plain'])
    expect(provisioningStages).toEqual(['code_import', 'database_schema'])
    expect(provisioningStageStatuses).toEqual(['queued', 'running', 'succeeded', 'failed'])
  })

  it('names the repository of a site inside the organization of site repositories', () => {
    expect(SITE_REPOSITORY_OWNER).toBe('sites')
    expect(siteRepositoryName(siteId)).toBe(`site-${siteId}`)
    // What publication accepts as a repository name.
    expect(siteRepositoryName(siteId)).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/)
  })
})

describe('reasons and error codes', () => {
  it('lets a stage fail with every reason of a connection check', () => {
    for (const reason of connectionCheckReasons) expect(provisioningErrorCodes).toContain(reason)
    expect(connectionCheckReasons).toHaveLength(17)
    expect(provisioningErrorCodes).toHaveLength(34)
    expect(importSkipReasons).toEqual([
      'excluded',
      'ci',
      'vcs',
      'link',
      'unsupported_path',
      'too_large',
      'secret',
      'nested_site',
      'unreadable',
    ])
  })

  it('names each code once and as site_provisioning_stages.error_code accepts it', () => {
    for (const codes of [connectionCheckReasons, provisioningErrorCodes, importSkipReasons]) {
      expect(new Set(codes).size).toBe(codes.length)
      for (const code of codes) expect(code).toMatch(/^[a-z][a-z_]{1,63}$/)
    }
  })
})

describe('provisioningStageSummarySchema', () => {
  it('reads the counts of an import, of a structure and the flag of a recheck', () => {
    for (const summary of [
      {},
      { files: 1_200 },
      { files: 1_200, bytes: 48_000_000, skipped: { excluded: 3_400, link: 2, secret: 1 } },
      { files: 0, bytes: 0, skipped: {} },
      { tables: 12, columns: 140, truncated: false },
      { files: 1_200, bytes: 48_000_000, skipped: { secret: 2 }, recheck: true },
    ])
      expect(provisioningStageSummarySchema.parse(summary)).toEqual(summary)
  })

  // Counts and flags only: never a path, a host or a message.
  it.each([
    { path: 'wp-content/themes/shop/test.php' },
    { host: 'ftp.example.ru' },
    { message: "Access denied for user 'u123'" },
    { errorCode: 'auth_failed' },
    { skipped: { other: 1 } },
    { skipped: { excluded: 1, 'wp-config.php': 1 } },
    { skipped: { excluded: -1 } },
    { skipped: { excluded: 1.5 } },
    { skipped: { excluded: '1' } },
    { skipped: ['excluded'] },
    { files: -1 },
    { files: 1.5 },
    { files: '12' },
    { bytes: Number.POSITIVE_INFINITY },
    { tables: null },
    { truncated: 'yes' },
    { recheck: 1 },
  ])('refuses %j', (summary) => {
    expect(provisioningStageSummarySchema.safeParse(summary).success).toBe(false)
  })

  it('fits the column check of site_provisioning_stages.summary at its largest', () => {
    const count = Number.MAX_SAFE_INTEGER
    const largest = {
      files: count,
      bytes: count,
      skipped: Object.fromEntries(importSkipReasons.map((reason) => [reason, count])),
      tables: count,
      columns: count,
      truncated: false,
      recheck: false,
    }
    expect(provisioningStageSummarySchema.parse(largest)).toEqual(largest)
    expect(new TextEncoder().encode(JSON.stringify(largest)).byteLength).toBeLessThan(2048)
  })
})

describe('limits', () => {
  it('imports the files a turn accepts, and the bytes of a whole site with its media', () => {
    expect(siteImportLimits.files).toBe(publicationLimits.repositoryFiles)
    expect(siteImportLimits.fileBytes).toBe(publicationLimits.fileBytes)
    // The repository holds the site; a turn gets its working set with limits of its own.
    expect(siteImportLimits.treeBytes).toBeGreaterThan(publicationLimits.treeBytes)
    expect(siteImportLimits.bundleBytes).toBeGreaterThan(publicationLimits.bundleBytes)
    expect(siteImportLimits).toMatchObject({
      files: 100_000,
      fileBytes: 32 * 1024 * 1024,
      treeBytes: 1024 * 1024 * 1024,
      bundleBytes: 1024 * 1024 * 1024,
      depth: 32,
    })
    // A hash or scan batch never holds more than the tree, and one file always fits a batch.
    expect(siteImportLimits.hashBatchBytes).toBeGreaterThanOrEqual(siteImportLimits.fileBytes)
    expect(siteImportLimits.scanBatchBytes).toBeGreaterThanOrEqual(siteImportLimits.fileBytes)
    expect(siteImportLimits.listedEntries).toBeGreaterThan(siteImportLimits.files)
    expect(siteImportLimits.configFileBytes).toBeLessThan(siteImportLimits.fileBytes)
  })

  it('keeps the deadlines of a check and of creation inside one another', () => {
    const limits = siteConnectionLimits
    expect(limits.dnsMs).toBeLessThan(limits.checkMs)
    expect(limits.checkMs).toBeLessThan(limits.createChecksMs)
    expect(limits.createChecksMs).toBeLessThan(limits.createBudgetMs)
    // The claim outlives the budget and the transaction (10 s), so it cannot expire under a live call.
    expect(limits.createClaimMs).toBeGreaterThan(limits.createBudgetMs + 10_000)
    expect(limits.gateWaitMs).toBeLessThan(limits.checkMs)
    expect(limits.inFlightPerUser).toBeLessThan(limits.inFlightPerProcess)
    // A check costs 1, create and replaceAccess cost 2: the window must admit one whole wizard.
    expect(limits.checkUnitsPerWindow).toBeGreaterThanOrEqual(2 + 2)
  })

  it('keeps the typed limits inside what the storage accepts', () => {
    // site_code_sources.repository_url is VARCHAR(1024); the canonical form adds `.git`.
    expect(siteConnectionLimits.gitUrlChars + '.git'.length).toBeLessThanOrEqual(1024)
    // The request limit of the KV adapter (packages/vault/src/limits.ts).
    expect(siteConnectionLimits.secretBytes).toBeLessThan(64 * 1024)
    expect(siteConnectionLimits.privateKeyChars * 2).toBeLessThan(siteConnectionLimits.secretBytes)
    // site_database_schemas: schema is at most 2 MiB, server_version is VARCHAR(64).
    expect(databaseSchemaLimits.storedBytes).toBe(2 * 1024 * 1024)
    expect(databaseSchemaLimits.serverVersionChars).toBe(64)
    expect(databaseSchemaLimits.queryMs).toBeLessThan(databaseSchemaLimits.stageMs)
    expect(siteConnectionLimits.checkReceivedBytes).toBeLessThan(databaseSchemaLimits.receivedBytes)
  })

  it('tells a silent worker from a slow one', () => {
    const limits = provisioningLimits
    // Several missed heartbeats, not one, before a stage is taken from its worker.
    expect(limits.staleMs).toBeGreaterThanOrEqual(4 * limits.heartbeatMs)
    expect(limits.sweepMs).toBeLessThanOrEqual(limits.staleMs)
    expect(limits.queuedStaleMs).toBeGreaterThan(limits.staleMs)
    // A released stage must not be claimed back by the process that is stopping (hard exit after 30 s).
    expect(limits.releaseDelayMs).toBeGreaterThan(30_000)
    expect(limits).toMatchObject({ importsPerWorkspace: 1, enqueuesPerAttempt: 5 })
  })

  it('cannot be changed at run time', () => {
    for (const limits of [
      siteConnectionLimits,
      siteImportLimits,
      databaseSchemaLimits,
      provisioningLimits,
    ])
      expect(Object.isFrozen(limits)).toBe(true)
  })
})

describe('steps of a running stage and the setup state of a site', () => {
  it('names the steps as site_provisioning_stages.step accepts them', () => {
    expect(provisioningSteps).toEqual(['fetch', 'publish'])
    for (const step of provisioningSteps) expect(step).toMatch(/^[a-z][a-z_]{1,31}$/)
  })

  it('tags the first version v0.0.0, as the CHECK of site_initial_versions.tag reads a version', () => {
    expect(INITIAL_SITE_TAG).toBe('v0.0.0')
    expect(INITIAL_SITE_TAG).toMatch(/^v[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$/)
  })

  it('shows the setup screen until code_import succeeds, and nothing for a site without the stage', () => {
    expect(siteSetupState(null)).toBeNull()
    expect(siteSetupState(undefined)).toBeNull()
    expect(siteSetupState({ status: 'queued' })).toBe('pending')
    expect(siteSetupState({ status: 'running' })).toBe('pending')
    expect(siteSetupState({ status: 'failed' })).toBe('failed')
    expect(siteSetupState({ status: 'succeeded' })).toBe('done')
  })
})
