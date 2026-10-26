import { releaseSteps } from '@repo/domain'
import { z } from 'zod'

import {
  listSiteBackups,
  listSiteRuns,
  listSiteVersions,
  readSiteConnections,
  readSiteRun,
} from '../services/site-history.ts'
import { consentedProcedure, router } from '../trpc.ts'

// The history of a site for its sections «Изменения», «Запуски» and «База и бэкап», and where its
// files and database are for «Настройки» (services/site-history.ts). Read only; nothing of a secret.

const siteInput = z.strictObject({ siteId: z.uuid() })
const runId = z.union([z.literal('import'), z.uuid()])
const stepName = z.enum([...releaseSteps, 'import'])
const stepState = z.enum(['started', 'succeeded', 'failed', 'unknown'])

const runOutput = z.strictObject({
  id: z.string(),
  number: z.number().int().positive(),
  kind: z.enum(['import', 'release', 'undo']),
  title: z.string().nullable(),
  taskId: z.uuid().nullable(),
  state: z.enum(['running', 'installed', 'rolled_back', 'failed', 'refused', 'unknown']),
  step: z.enum(releaseSteps).nullable(),
  version: z.string().nullable(),
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
  approvedBy: z.string().nullable(),
})

const runDetailOutput = runOutput.extend({
  steps: z.array(
    z.strictObject({
      step: stepName,
      state: stepState,
      startedAt: z.date(),
      finishedAt: z.date().nullable(),
    }),
  ),
  lines: z.array(
    z.strictObject({
      at: z.date(),
      step: stepName,
      event: z.enum([...stepState.options, 'files']),
      files: z.number().int().nonnegative().optional(),
      bytes: z.number().int().nonnegative().optional(),
    }),
  ),
})

const versionOutput = z.strictObject({
  id: z.string(),
  kind: z.enum(['initial', 'release', 'undo']),
  version: z.string(),
  tag: z.string(),
  title: z.string().nullable(),
  taskId: z.uuid().nullable(),
  run: z.number().int().nonnegative(),
  approvedBy: z.string().nullable(),
  installedAt: z.date(),
  current: z.boolean(),
  backupAt: z.date().nullable(),
  undoes: z.string().nullable(),
  undone: z.boolean(),
})

const backupOutput = z.strictObject({
  id: z.string(),
  kind: z.enum(['release', 'initial']),
  at: z.date(),
  bytes: z.number().int().nonnegative().nullable(),
  version: z.string(),
  download: z.enum(['ready', 'pending', 'none']),
})

const tls = z.enum(['verified', 'unverified', 'plain'])
const connectionsOutput = z.strictObject({
  source: z.strictObject({ kind: z.enum(['sftp', 'ftp', 'git']), tls: tls.nullable() }).nullable(),
  database: z
    .strictObject({
      engine: z.enum(['postgres', 'mysql']),
      databaseName: z.string(),
      tls,
      updatedAt: z.date(),
    })
    .nullable(),
})

export const siteHistoryRouter = router({
  /** «Запуски»: the first import and every release, the newest first. */
  runs: consentedProcedure
    .input(siteInput)
    .output(z.array(runOutput))
    .query(({ ctx, input }) => listSiteRuns(ctx.prisma, { ...input, userId: ctx.user.id })),

  /** One run: its steps and the journal made of the platform's own reports. */
  run: consentedProcedure
    .input(siteInput.extend({ runId }))
    .output(runDetailOutput)
    .query(({ ctx, input }) => readSiteRun(ctx.prisma, { ...input, userId: ctx.user.id })),

  /** «Изменения»: the versions that were on the site, the newest first. */
  versions: consentedProcedure
    .input(siteInput)
    .output(z.array(versionOutput))
    .query(({ ctx, input }) => listSiteVersions(ctx.prisma, { ...input, userId: ctx.user.id })),

  /** «База и бэкап»: the copies the platform made. */
  backups: consentedProcedure
    .input(siteInput)
    .output(z.array(backupOutput))
    .query(({ ctx, input }) => listSiteBackups(ctx.prisma, { ...input, userId: ctx.user.id })),

  /** Where the files and the database of the site are: kinds and protection, never an address. */
  connections: consentedProcedure
    .input(siteInput)
    .output(connectionsOutput)
    .query(({ ctx, input }) => readSiteConnections(ctx.prisma, { ...input, userId: ctx.user.id })),
})
