import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as GeneratedClient from './generated/prisma/client.ts'

const constructed = vi.hoisted(() => [] as unknown[])

vi.mock('./generated/prisma/client.ts', async (importOriginal) => {
  const original = await importOriginal<typeof GeneratedClient>()
  return {
    ...original,
    PrismaClient: class {
      constructor(options: unknown) {
        constructed.push(options)
      }
    },
  }
})

const { createPrismaClient } = await import('./client.ts')

const databaseUrl = 'postgresql://raditi:raditi@127.0.0.1:9/raditi'
const logOf = (index: number) => (constructed[index] as { log: unknown }).log

describe('createPrismaClient', () => {
  beforeEach(() => {
    constructed.length = 0
  })

  it('logs warnings and errors by default', () => {
    createPrismaClient({ databaseUrl })
    expect(logOf(0)).toEqual(['warn', 'error'])
  })

  it('takes the log levels from the caller', () => {
    createPrismaClient({ databaseUrl, log: ['warn'] })
    createPrismaClient({ databaseUrl, log: [] })
    expect(logOf(0)).toEqual(['warn'])
    expect(logOf(1)).toEqual([])
  })
})
