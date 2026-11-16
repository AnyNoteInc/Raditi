import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { Logger, type OnModuleInit } from '@nestjs/common'
import { isProduction, type AppEnv } from '@repo/domain'

import { operationsDir } from './mirror-store.ts'

/** Removes the directories of operations a killed core left on the volume; returns how many. */
export async function sweepOperations(root: string): Promise<number> {
  const dir = operationsDir(root)
  const stale = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((entry) =>
    entry.isDirectory(),
  )
  await Promise.all(
    stale.map((entry) => rm(join(dir, entry.name), { recursive: true, force: true })),
  )
  return stale.length
}

/**
 * In production the volume of the mirrors is core's own (with its git worker): an operation with
 * a client's code outlives a kill -9 there, so core removes such leftovers once at start, before
 * anything runs. Elsewhere the default volume (`<tmpdir>/raditi-mirrors`) may be shared by the
 * cores of several trees, so nothing is swept.
 */
export class StaleOperationsSweep implements OnModuleInit {
  constructor(
    private readonly appEnv: AppEnv,
    private readonly root: string,
    private readonly logger: { log(message: string): void } = new Logger('GitWorkspace'),
  ) {}

  async onModuleInit(): Promise<void> {
    if (!isProduction(this.appEnv)) return
    const removed = await sweepOperations(this.root)
    if (removed > 0) this.logger.log(`removed ${removed} stale repository operation(s)`)
  }
}
