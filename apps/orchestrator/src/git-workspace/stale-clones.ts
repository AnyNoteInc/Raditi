import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Logger, type OnModuleInit } from '@nestjs/common'
import { isProduction, type AppEnv } from '@repo/domain'

/** Every clone of GitWorkspaceService is a `<tmpdir>/raditi-git-*` directory. */
export const CLONE_PREFIX = 'raditi-git-'

/** Removes the clone directories in `dir`, never following a link; returns how many. */
export async function sweepStaleClones(dir: string): Promise<number> {
  const stale = (await readdir(dir, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith(CLONE_PREFIX),
  )
  await Promise.all(
    stale.map((entry) => rm(join(dir, entry.name), { recursive: true, force: true })),
  )
  return stale.length
}

/**
 * In production core's tmpdir is a volume of its own (/work/tmp): a clone with the site's code
 * outlives a kill -9 there. Core removes such leftovers once at start, before anything can clone.
 * Elsewhere the tmpdir is shared with other processes, so nothing is swept.
 */
export class StaleClonesSweep implements OnModuleInit {
  readonly #appEnv: AppEnv
  readonly #dir: string
  readonly #logger: { log(message: string): void }

  constructor(
    appEnv: AppEnv,
    dir: string = tmpdir(),
    logger: { log(message: string): void } = new Logger('GitWorkspace'),
  ) {
    this.#appEnv = appEnv
    this.#dir = dir
    this.#logger = logger
  }

  async onModuleInit(): Promise<void> {
    if (!isProduction(this.#appEnv)) return
    const removed = await sweepStaleClones(this.#dir)
    if (removed > 0) this.#logger.log(`removed ${removed} stale publication clone(s)`)
  }
}
