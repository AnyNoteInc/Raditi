import { Logger, Module } from '@nestjs/common'
import { Counter, type Registry } from '@prometheus-io/client'
import type { PrismaClient } from '@repo/db'
import {
  SITE_REPOSITORY_OWNER,
  type DatabaseEngine,
  type DatabaseInspector,
  type GitProvider,
  type HostLookup,
  type JobQueue,
  type SecretStore,
  type SiteRepositoryProvisioner,
  type SiteSourceAdapter,
  type SiteSourceKind,
} from '@repo/domain'
import { createGiteaRepositoryProvisioner } from '@repo/git-providers'
import { getSiteAdapter } from '@repo/site-adapters'
import { createHostLookup, siteSource } from '@repo/site-connections'
import { databaseInspector } from '@repo/site-connections/databases'
import { BACKGROUND_JOBS, METRICS_REGISTRY, PRISMA, SECRET_STORE } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { gitWorkspaceOptions } from '../git-workspace/git-config.ts'
import { GitWorkspaceModule } from '../git-workspace/git-workspace.module.ts'
import {
  CORE_CONFIG,
  GIT_PROVIDER,
  HOST_LOOKUP,
  JOB_QUEUE,
  SITE_DATABASES,
  SITE_REPOSITORY_PROVISIONER,
  SITE_SOURCES,
} from '../infra/tokens.ts'
import { MetricsModule } from '../metrics/metrics.module.ts'
import { InitialVersionGit } from './initial-version.ts'
import { importSite, type SiteImportGit } from './site-import.ts'
import { SiteImportProcessor } from './site-import.processor.ts'
import { siteImportOutcomes, SiteImportRunner } from './site-import.runner.ts'
import { SiteImportSweeper } from './site-import.sweeper.ts'
import { PostgresSiteImportStore } from './stage-store.ts'

/** Core's gitleaks: the one of the orchestrator image (PATH), as the publication of a turn. */
const GITLEAKS_BINARY = 'gitleaks'

/**
 * The initial import of a connected site in the core role (docs/plan/39-site-connection-wizard.md,
 * W3): the worker of the `site-import` queue, the sweep that returns silent stages, and their
 * ports — the file sources, the database inspectors and DNS of @repo/site-connections, the
 * repository provisioner of our Gitea and the bot's git provider. Without git or without the
 * provisioner token core starts as before; an import then fails `repository_not_configured`.
 */
@Module({
  imports: [GitWorkspaceModule, MetricsModule],
  providers: [
    {
      provide: SITE_SOURCES,
      useValue: (kind: SiteSourceKind): SiteSourceAdapter => siteSource(kind),
    },
    {
      provide: SITE_DATABASES,
      useValue: (engine: DatabaseEngine): DatabaseInspector => databaseInspector(engine),
    },
    { provide: HOST_LOOKUP, useFactory: (): HostLookup => createHostLookup() },
    {
      provide: SITE_REPOSITORY_PROVISIONER,
      useFactory: (config: CoreConfig): SiteRepositoryProvisioner | null =>
        config.git && config.siteRepositoryProvisionerToken
          ? createGiteaRepositoryProvisioner({
              baseUrl: config.git.baseUrl,
              token: config.siteRepositoryProvisionerToken,
              organization: SITE_REPOSITORY_OWNER,
            })
          : null,
      inject: [CORE_CONFIG],
    },
    {
      provide: PostgresSiteImportStore,
      useFactory: (prisma: PrismaClient) => new PostgresSiteImportStore(prisma),
      inject: [PRISMA],
    },
    {
      provide: SiteImportRunner,
      useFactory: (
        config: CoreConfig,
        store: PostgresSiteImportStore,
        secrets: SecretStore,
        sources: (kind: SiteSourceKind) => SiteSourceAdapter,
        databases: (engine: DatabaseEngine) => DatabaseInspector,
        lookup: HostLookup,
        provisioner: SiteRepositoryProvisioner | null,
        provider: GitProvider | null,
        queue: JobQueue,
        registry: Registry,
      ) => {
        // Jobs by how they ended: no site, workspace or code in a label.
        const imports = new Counter({
          name: 'raditi_site_imports_total',
          help: 'Jobs of the site import queue by how they ended',
          labelNames: ['outcome'],
          registers: [registry],
        })
        for (const outcome of siteImportOutcomes) imports.inc({ outcome }, 0)
        const git: SiteImportGit | null =
          config.git && provider
            ? {
                versions: new InitialVersionGit({
                  provider,
                  transport: gitWorkspaceOptions(config.git).transport,
                }),
                webRoot: config.git.baseUrl,
              }
            : null
        const deps = {
          appEnv: config.appEnv,
          store,
          secrets,
          sources,
          databases,
          stacks: getSiteAdapter,
          lookup,
          provisioner,
          git,
          gitleaksBinary: GITLEAKS_BINARY,
        }
        return new SiteImportRunner({
          store,
          importer: (stage, signal) => importSite(stage, signal, deps),
          queue,
          logger: new Logger('SiteImport'),
          count: (outcome) => imports.inc({ outcome }),
        })
      },
      inject: [
        CORE_CONFIG,
        PostgresSiteImportStore,
        SECRET_STORE,
        SITE_SOURCES,
        SITE_DATABASES,
        HOST_LOOKUP,
        SITE_REPOSITORY_PROVISIONER,
        GIT_PROVIDER,
        JOB_QUEUE,
        METRICS_REGISTRY,
      ],
    },
    SiteImportProcessor,
    {
      provide: SiteImportSweeper,
      useFactory: (store: PostgresSiteImportStore, queue: JobQueue, background: boolean) =>
        new SiteImportSweeper({ store, queue, background }),
      inject: [PostgresSiteImportStore, JOB_QUEUE, BACKGROUND_JOBS],
    },
  ],
})
export class SiteProvisioningModule {}
