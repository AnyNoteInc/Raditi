import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CLONE_PREFIX, StaleClonesSweep, sweepStaleClones } from './stale-clones.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A tmpdir as a killed core leaves it: two clones next to files that are not ours. */
async function leftovers() {
  const dir = await mkdtemp(join(tmpdir(), 'raditi-sweep-test-'))
  const outside = await mkdtemp(join(tmpdir(), 'raditi-sweep-outside-'))
  dirs.push(dir, outside)
  for (const clone of [`${CLONE_PREFIX}a1B2c3`, `${CLONE_PREFIX}Zz9yY8`]) {
    await mkdir(join(dir, clone, 'repo', '.git'), { recursive: true })
    await writeFile(join(dir, clone, 'repo', 'wp-config.php'), 'site code')
  }
  await writeFile(join(outside, 'keep'), 'not ours')
  await mkdir(join(dir, 'raditi-gitleaks-verify.X'))
  await writeFile(join(dir, `${CLONE_PREFIX}file`), 'a file, not a clone')
  await symlink(outside, join(dir, `${CLONE_PREFIX}link`))
  return { dir, outside }
}

describe('sweepStaleClones', () => {
  it('removes only clone directories, never following a link', async () => {
    const { dir, outside } = await leftovers()
    expect(await sweepStaleClones(dir)).toBe(2)
    expect((await readdir(dir)).sort()).toEqual([
      `${CLONE_PREFIX}file`,
      `${CLONE_PREFIX}link`,
      'raditi-gitleaks-verify.X',
    ])
    expect(await readdir(outside)).toEqual(['keep'])
    expect(await sweepStaleClones(dir)).toBe(0)
  })
})

describe('StaleClonesSweep', () => {
  it('sweeps at start in production only: elsewhere the tmpdir is shared', async () => {
    const { dir } = await leftovers()
    const log = vi.fn()
    for (const appEnv of ['development', 'test'] as const) {
      await new StaleClonesSweep(appEnv, dir, { log }).onModuleInit()
      expect(await readdir(dir)).toHaveLength(5)
    }
    await new StaleClonesSweep('production', dir, { log }).onModuleInit()
    expect(await readdir(dir)).toHaveLength(3)
    expect(log).toHaveBeenCalledExactlyOnceWith('removed 2 stale publication clone(s)')
  })
})
