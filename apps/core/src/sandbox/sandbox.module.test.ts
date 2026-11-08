import { Test } from '@nestjs/testing'
import type { SandboxProvider, SiteLeaseStore, TurnAssignmentStore } from '@repo/domain'
import type * as sandboxProviders from '@repo/sandbox-providers'
import { createDockerSandboxProvider } from '@repo/sandbox-providers'
import { describe, expect, it, vi } from 'vitest'

import { CoreConfigModule } from '../config/config.module.ts'
import { testCoreConfig } from '../testing/fakes.ts'
import { TurnReconciler } from '../turns/turn-reconciler.ts'
import { SandboxModule } from './sandbox.module.ts'
import { SANDBOX_PROVIDER } from './sandbox.tokens.ts'

const RUNNER = 'io.raditi.runner'

/**
 * One Docker daemon with a turn container of two deployments. Like Docker, it lists only the
 * containers whose labels match every `key=value` of the filter.
 */
const daemon = vi.hoisted(() => {
  const rows = [
    { Id: 'a'.repeat(64), Labels: { 'io.raditi.runner': 'a' } },
    { Id: 'b'.repeat(64), Labels: { 'io.raditi.runner': 'b' } },
  ]
  const inspected: string[] = []
  return {
    inspected,
    listContainers: vi.fn(async (options: { filters: { label: string[] } }) =>
      rows.filter((row) =>
        options.filters.label
          .filter((label) => label.startsWith('io.raditi.runner='))
          .every((label) => `io.raditi.runner=${row.Labels['io.raditi.runner']}` === label),
      ),
    ),
    getContainer: vi.fn((id: string) => ({
      // Not a turn container this provider made: list skips it, and nothing is removed.
      inspect: vi.fn(async () => {
        inspected.push(id)
        return { Id: id, Config: { Labels: {} }, HostConfig: {} }
      }),
    })),
  }
})

vi.mock('@repo/sandbox-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof sandboxProviders>()
  return {
    ...actual,
    createDockerSandboxProvider: vi.fn(
      (
        config: Parameters<typeof actual.createDockerSandboxProvider>[0],
        options: Parameters<typeof actual.createDockerSandboxProvider>[1] = {},
      ) => actual.createDockerSandboxProvider(config, { ...options, client: daemon as never }),
    ),
  }
})

describe('SandboxModule', () => {
  it('gives the reconciler only the turn containers of its own deployment', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CoreConfigModule.forRoot({
          config: testCoreConfig({ SANDBOX_DEPLOYMENT: 'a' }),
          background: false,
        }),
        SandboxModule,
      ],
    }).compile()
    const sandboxes = moduleRef.get<SandboxProvider>(SANDBOX_PROVIDER)
    expect(createDockerSandboxProvider).toHaveBeenCalledWith(
      expect.objectContaining({ runnerId: 'a' }),
    )

    // A lease store that answers nothing: every container it is asked about would be an orphan.
    const leases = { inspect: vi.fn(async () => null) } as unknown as SiteLeaseStore
    const assignments = { unfinished: vi.fn(async () => []) } as Pick<
      TurnAssignmentStore,
      'unfinished'
    >
    await new TurnReconciler(sandboxes, leases, assignments).reconcile()

    expect(daemon.listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: expect.arrayContaining([`${RUNNER}=a`]) },
    })
    // The container of the other deployment is never even looked at.
    expect(daemon.inspected).toEqual(['a'.repeat(64)])
    expect(leases.inspect).not.toHaveBeenCalled()

    await moduleRef.close()
  })
})
