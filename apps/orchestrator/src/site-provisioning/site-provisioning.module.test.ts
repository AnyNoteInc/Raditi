import type { DynamicModule, INestApplication, Type } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { Registry } from '@prometheus-io/client'
import type { DatabaseEngine, DatabaseInspector, SiteRepositoryProvisioner } from '@repo/domain'
import { afterEach, describe, expect, it } from 'vitest'

import { loadConfig, type CoreConfig } from '../config/config.ts'
import { CoreModule } from '../core/core.module.ts'
import {
  METRICS_REGISTRY,
  SITE_DATABASES,
  SITE_REPOSITORY_PROVISIONER,
  SITE_SOURCES,
} from '../infra/tokens.ts'
import { LlmAppModule } from '../llm-gateway/llm-app.module.ts'
import { McpAppModule } from '../mcp/mcp-app.module.ts'
import { RunnerModule } from '../runner/runner.module.ts'
import {
  fakeInfra,
  overrideCoreInfra,
  testCoreConfig,
  testMcpConfig,
  testRunnerConfig,
} from '../testing/fakes.ts'
import { SiteImportProcessor } from './site-import.processor.ts'
import { siteImportOutcomes, SiteImportRunner } from './site-import.runner.ts'
import { SiteImportSweeper } from './site-import.sweeper.ts'
import { SiteProvisioningModule } from './site-provisioning.module.ts'

const apps: INestApplication[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

/** The whole core role as tests compile it: fakes for every connection, no background work. */
async function core(config: CoreConfig = testCoreConfig()) {
  const infra = fakeInfra()
  const moduleRef = await overrideCoreInfra(
    Test.createTestingModule({ imports: [CoreModule.forRoot({ config, background: false })] }),
    infra,
  ).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  apps.push(app)
  await app.init()
  return { app, infra }
}

/** Whether `target` is among the modules a role module imports, however deep. */
function imports(root: DynamicModule | Type, target: Type, seen = new Set<unknown>()): boolean {
  const module = 'module' in root ? root.module : root
  if (module === target) return true
  if (seen.has(module)) return false
  seen.add(module)
  const declared = (Reflect.getMetadata('imports', module) ?? []) as (DynamicModule | Type)[]
  const dynamic = ('module' in root ? (root.imports ?? []) : []) as (DynamicModule | Type)[]
  return [...declared, ...dynamic].some(
    (imported) => typeof imported !== 'string' && imports(imported, target, seen),
  )
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

  it('exposes a counter of jobs by outcome only, at zero from the start', async () => {
    const { app } = await core()
    const metrics = await app.get<Registry>(METRICS_REGISTRY).metrics()

    for (const outcome of siteImportOutcomes)
      expect(metrics).toContain(
        `raditi_site_imports_total{outcome="${outcome}",app="orchestrator"} 0`,
      )
    const labels = [...metrics.matchAll(/^raditi_site_imports_total\{([^}]*)\}/gm)].map(
      ([, inner = '']) => inner.replace(/="[^"]*"/g, ''),
    )
    expect(new Set(labels)).toEqual(new Set(['outcome,app']))
  })

  it('belongs to core alone: the gateways and the runner import nothing', () => {
    const coreModule = CoreModule.forRoot({ config: testCoreConfig(), background: false })
    expect(imports(coreModule, SiteProvisioningModule)).toBe(true)

    const { llm } = loadConfig({
      APP_ENV: 'test',
      ORCHESTRATOR_ROLES: 'llm',
      DATABASE_URL: 'postgresql://raditi:raditi@localhost:5432/raditi_test',
      VAULT_ADDR: 'http://localhost:8200',
      VAULT_DEV_ROOT_TOKEN: 'raditi-dev-root',
    })
    if (llm === null) throw new Error('The test environment has no llm role')
    for (const module of [
      McpAppModule.forRoot(testMcpConfig()),
      LlmAppModule.forRoot(llm),
      RunnerModule.forRoot(testRunnerConfig()),
    ])
      expect(imports(module, SiteProvisioningModule)).toBe(false)
  })
})
