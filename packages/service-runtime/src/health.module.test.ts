import { HttpException, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { describe, expect, it } from 'vitest'

import { HealthController } from './health.controller.ts'
import { HealthModule } from './health.module.ts'

const TOKEN = 'operator-token-0123456789'
const CHECKED = Symbol('CHECKED')

/** A module of the app whose export the factories inject. */
@Module({ providers: [{ provide: CHECKED, useValue: { up: true } }], exports: [CHECKED] })
class DependencyModule {}

async function health(options: Parameters<typeof HealthModule.forRootAsync>[0]) {
  const app = await Test.createTestingModule({
    imports: [HealthModule.forRootAsync(options)],
  }).compile()
  return app.get(HealthController)
}

const checks = {
  imports: [DependencyModule],
  inject: [CHECKED],
  useFactory: (dependency: { up: boolean }) => ({ dependency: async () => dependency.up }),
}

describe('HealthModule', () => {
  it('serves the checks the app makes, and their details only with its token', async () => {
    const controller = await health({ ...checks, details: { useFactory: () => TOKEN } })

    expect(await controller.health()).toEqual({ status: 'ok' })
    expect(await controller.health('Bearer wrong-token')).toEqual({ status: 'ok' })
    expect(await controller.health(`Bearer ${TOKEN}`)).toEqual({
      status: 'ok',
      checks: { dependency: 'ok' },
    })
  })

  it('answers status only without a token, and 503 while a check fails', async () => {
    const controller = await health({
      useFactory: () => ({ database: async () => false }),
    })

    const error: unknown = await controller.health(`Bearer ${TOKEN}`).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HttpException)
    expect((error as HttpException).getStatus()).toBe(503)
    expect((error as HttpException).getResponse()).toEqual({ status: 'degraded' })
  })
})
