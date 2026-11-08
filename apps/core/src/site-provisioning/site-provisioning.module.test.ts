import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { Registry } from '@prometheus-io/client'
import {
  closedStackRoots,
  type DatabaseEngine,
  type DatabaseInspector,
  type SiteRepositoryProvisioner,
} from '@repo/domain'
import { siteAdapters } from '@repo/site-adapters'
import { afterEach, describe, expect, it } from 'vitest'

import { AppModule } from '../app.module.ts'
import type { CoreConfig } from '../config/config.ts'
import { METRICS_REGISTRY } from '../metrics/metrics.tokens.ts'
import { fakeInfra, overrideCoreInfra, testCoreConfig } from '../testing/fakes.ts'
import { SiteImportProcessor } from './site-import.processor.ts'
import { siteImportOutcomes, SiteImportRunner } from './site-import.runner.ts'
import { SiteImportSweeper } from './site-import.sweeper.ts'
import {
  CLOSED_STACK_ROOTS,
  SITE_DATABASES,
  SITE_REPOSITORY_PROVISIONER,
  SITE_SOURCES,
} from './site-provisioning.tokens.ts'

const apps: INestApplication[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

/** The whole core role as tests compile it: fakes for every connection, no background work. */
async function core(config: CoreConfig = testCoreConfig()) {
  const infra = fakeInfra()
  const moduleRef = await overrideCoreInfra(
    Test.createTestingModule({ imports: [AppModule.forRoot({ config, background: false })] }),
    infra,
  ).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  apps.push(app)
  await app.init()
  return { app, infra }
}

const git = {
  kind: 'gitea' as const,
  baseUrl: 'https://gitea.raditi.test',
  token: 'synthetic-bot-token',
  caFile: null,
}

describe('SiteProvisioningModule in the core role', () => {
  it('wires the worker, the runner and the sweep, and starts neither without background work', async () => {
    const { app, infra } = await core()

    expect(app.get(SiteImportRunner)).toBeInstanceOf(SiteImportRunner)
    expect(app.get(SiteImportSweeper)).toBeInstanceOf(SiteImportSweeper)
    // The worker of a processor exists only once BullMQ registered it.
    expect(() => app.get(SiteImportProcessor).worker).toThrow()
    expect(typeof app.get(SITE_SOURCES)).toBe('function')
    // The import reads the database access of a site through the inspectors, by engine.
    const databases = app.get<(engine: DatabaseEngine) => DatabaseInspector>(SITE_DATABASES)
    expect(databases('mysql')).toMatchObject({ engine: 'mysql', accessKind: 'db' })
    expect(databases('postgres')).toMatchObject({ engine: 'postgres', accessKind: 'db' })
    // Nothing was read: no claim, no sweep.
    expect(infra.prisma.$queryRaw).not.toHaveBeenCalled()
  })

  it('has a repository provisioner only with git and its own token', async () => {
    const without = await core()
    expect(without.app.get(SITE_REPOSITORY_PROVISIONER)).toBeNull()

    const botOnly = await core({ ...testCoreConfig(), git, siteRepositoryProvisionerToken: null })
    // The bot's token never stands in for the provisioner's.
    expect(botOnly.app.get(SITE_REPOSITORY_PROVISIONER)).toBeNull()

    const both = await core({
      ...testCoreConfig(),
      git,
      siteRepositoryProvisionerToken: 'synthetic-provisioner-token',
    })
    const provisioner = both.app.get<SiteRepositoryProvisioner>(SITE_REPOSITORY_PROVISIONER)
    expect(typeof provisioner.ensureRepository).toBe('function')
  })

  it('gives the import the folders of every stack closed for files (fact 14)', async () => {
    const { app } = await core()
    const closedRoots = app.get<readonly (readonly string[])[]>(CLOSED_STACK_ROOTS)

    // An empty list would let the walk copy the core of such a stack into the repository.
    expect(closedRoots.length).toBeGreaterThan(0)
    expect(closedRoots).toEqual(closedStackRoots(siteAdapters()))
    for (const adapter of siteAdapters().filter((one) => one.support.files === 'off'))
      expect(closedRoots).toContainEqual(adapter.rootMarkers())
  })

  it('exposes a counter of jobs by outcome only, at zero from the start', async () => {
    const { app } = await core()
    const metrics = await app.get<Registry>(METRICS_REGISTRY).metrics()

    for (const outcome of siteImportOutcomes)
      expect(metrics).toContain(`raditi_site_imports_total{outcome="${outcome}",app="core"} 0`)
    const labels = [...metrics.matchAll(/^raditi_site_imports_total\{([^}]*)\}/gm)].map(
      ([, inner = '']) => inner.replace(/="[^"]*"/g, ''),
    )
    expect(new Set(labels)).toEqual(new Set(['outcome,app']))
  })
})
