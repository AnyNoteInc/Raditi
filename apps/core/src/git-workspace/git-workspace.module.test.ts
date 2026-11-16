import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Test } from '@nestjs/testing'
import { afterEach, describe, expect, it } from 'vitest'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../config/config.tokens.ts'
import { Global, Module } from '@nestjs/common'
import { GitWorkspaceModule } from './git-workspace.module.ts'
import { GitWorkspaceService } from './git-workspace.service.ts'
import { GIT_WORKSPACE } from './git-workspace.tokens.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('GitWorkspaceModule', () => {
  it('gives the service of the volume of GIT_MIRROR_DIR', async () => {
    const mirrorDir = join(await mkdtemp(join(tmpdir(), 'raditi-gitws-module-')), 'git')
    roots.push(mirrorDir)
    const config = {
      appEnv: 'test',
      git: { mirrorDir, allowLoopback: false },
    } as unknown as CoreConfig
    @Global()
    @Module({ providers: [{ provide: CORE_CONFIG, useValue: config }], exports: [CORE_CONFIG] })
    class ConfigModule {}
    const module = await Test.createTestingModule({
      imports: [ConfigModule, GitWorkspaceModule],
    }).compile()
    await module.init()
    expect(module.get(GIT_WORKSPACE)).toBeInstanceOf(GitWorkspaceService)
    await module.close()
  })
})
