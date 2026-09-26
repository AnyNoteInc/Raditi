import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { findEnvFile, loadRepoEnv } from './env-file.ts'

let root: string
let appDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'raditi-env-'))
  appDir = join(root, 'apps', 'orchestrator', 'src')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(root, '.env'), 'APP_ENV=development\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('loadRepoEnv', () => {
  it('finds the nearest .env walking up and loads it outside production', () => {
    const load = vi.fn()

    expect(loadRepoEnv({ startDir: appDir, nodeEnv: 'development', load })).toBe(join(root, '.env'))
    expect(load).toHaveBeenCalledWith(join(root, '.env'))
    expect(findEnvFile(appDir)).toBe(join(root, '.env'))
  })

  it('also loads it when NODE_ENV is not set', () => {
    const load = vi.fn()

    loadRepoEnv({ startDir: appDir, nodeEnv: undefined, load })

    expect(load).toHaveBeenCalledOnce()
  })

  it('never loads a .env in production', () => {
    const load = vi.fn()

    expect(loadRepoEnv({ startDir: appDir, nodeEnv: 'production', load })).toBeUndefined()
    expect(load).not.toHaveBeenCalled()
  })

  it('does nothing when there is no .env', () => {
    rmSync(join(root, '.env'))
    const load = vi.fn()

    expect(loadRepoEnv({ startDir: appDir, nodeEnv: 'development', load })).toBeUndefined()
    expect(load).not.toHaveBeenCalled()
  })
})
