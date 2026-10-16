import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import { legalDocuments } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createCaller } from '../router.ts'
import type { Context } from '../trpc.ts'

const now = new Date('2026-09-30T12:00:00Z')
const user: User = {
  id: randomUUID(),
  name: 'Анна',
  lastName: null,
  email: 'profile-test@example.ru',
  emailVerified: true,
  image: '/api/profile/avatar/example',
  createdAt: now,
  updatedAt: now,
}
const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)

function context(prisma: PrismaClient, currentUser: User | null = user): Context {
  return {
    prisma,
    headers: new Headers(),
    user: currentUser,
    session: currentUser
      ? {
          id: randomUUID(),
          userId: currentUser.id,
          token: 'profile-test-session',
          expiresAt: new Date('2030-01-01'),
          createdAt: now,
          updatedAt: now,
        }
      : null,
    billing: null,
  }
}

function fakeDb() {
  const update = vi.fn(async ({ data }: { data: { name: string; lastName: string | null } }) => ({
    id: user.id,
    ...data,
    image: user.image,
    email: user.email,
  }))
  const findMany = vi.fn().mockResolvedValue(requiredConsents)
  const prisma = { user: { update }, userConsent: { findMany } } as unknown as PrismaClient
  return { update, findMany, prisma }
}

describe('user profile', () => {
  it('returns the name, optional surname and avatar with no session secrets', async () => {
    const { prisma } = fakeDb()
    expect(await createCaller(context(prisma, { ...user, lastName: 'Иванова' })).user.me()).toEqual(
      {
        id: user.id,
        name: user.name,
        lastName: 'Иванова',
        image: user.image,
        email: user.email,
        emailVerified: true,
      },
    )
  })

  it('requires authentication before writing', async () => {
    const { prisma, update } = fakeDb()
    await expect(
      createCaller(context(prisma, null)).user.updateProfile({ name: 'Анна', lastName: 'Иванова' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(update).not.toHaveBeenCalled()
  })

  it('requires the current mandatory consents before writing', async () => {
    const { prisma, update, findMany } = fakeDb()
    findMany.mockResolvedValue([])
    const caller = createCaller(context(prisma))
    await expect(
      caller.user.updateProfile({ name: 'Анна', lastName: 'Иванова' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_REQUIRED', cause: { code: 'CONSENT_REQUIRED' } })
    expect(update).not.toHaveBeenCalled()
    // Reading the own profile stays open: the consent page itself needs it.
    await expect(caller.user.me()).resolves.toMatchObject({ id: user.id })
  })

  it('updates only the current account and returns a public profile', async () => {
    const { prisma, update } = fakeDb()
    const result = await createCaller(context(prisma)).user.updateProfile({
      name: '  Мария  ',
      lastName: '  Петрова  ',
    })
    expect(update).toHaveBeenCalledExactlyOnceWith({
      where: { id: user.id },
      data: { name: 'Мария', lastName: 'Петрова' },
      select: { id: true, name: true, lastName: true, image: true, email: true },
    })
    expect(result).toEqual({
      id: user.id,
      name: 'Мария',
      lastName: 'Петрова',
      image: user.image,
      email: user.email,
    })
  })

  it.each(['', ' \t '])('allows removing a surname with %j', async (lastName) => {
    const { prisma, update } = fakeDb()
    const result = await createCaller(context(prisma)).user.updateProfile({
      name: 'Анна',
      lastName,
    })
    expect(result.lastName).toBeNull()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: 'Анна', lastName: null } }),
    )
  })

  it.each([
    { name: '   ', lastName: 'Иванова' },
    { name: 'x'.repeat(256), lastName: '' },
    { name: 'Анна', lastName: 'x'.repeat(256) },
    { name: 'А\u0000', lastName: '' },
    { name: 'Анна\nМария', lastName: '' },
    { name: 'Анна', lastName: 'Ива\u0000нова' },
    { name: 'Анна', lastName: 'Ива\u001bнова' },
    { name: 'Анна', lastName: '', userId: randomUUID() },
    { name: 'Анна', lastName: '', email: 'other@example.ru' },
    { name: 'Анна', lastName: '', image: 'https://example.ru/avatar.png' },
  ])('rejects invalid or unrelated fields before writing', async (input) => {
    const { prisma, update } = fakeDb()
    await expect(createCaller(context(prisma)).user.updateProfile(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(update).not.toHaveBeenCalled()
  })
})

const databaseUrl = process.env.DATABASE_URL
class Rollback extends Error {}

describe.skipIf(!databaseUrl)('PostgreSQL profile persistence', () => {
  let db: PrismaClient
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  it('persists a surname and its removal without changing another account or the avatar', async () => {
    try {
      await db.$transaction(async (tx) => {
        const owner = await tx.user.create({
          data: {
            name: 'Profile test',
            email: `${randomUUID()}@profile.example.ru`,
            image: user.image,
          },
        })
        const other = await tx.user.create({
          data: {
            name: 'Other profile',
            lastName: 'Unchanged',
            email: `${randomUUID()}@profile.example.ru`,
          },
        })
        await tx.userConsent.createMany({
          data: requiredConsents.map((consent) => ({
            ...consent,
            userId: owner.id,
            source: 'sign_up' as const,
          })),
        })
        const caller = createCaller(context(tx as unknown as PrismaClient, owner))

        await caller.user.updateProfile({ name: 'Анна', lastName: 'Иванова' })
        expect(await tx.user.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({
          name: 'Анна',
          lastName: 'Иванова',
          image: user.image,
          email: owner.email,
        })
        await caller.user.updateProfile({ name: 'Анна', lastName: ' ' })
        expect(await tx.user.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({
          name: 'Анна',
          lastName: null,
          image: user.image,
        })
        expect(await tx.user.findUniqueOrThrow({ where: { id: other.id } })).toEqual(other)
        throw new Rollback()
      })
    } catch (error) {
      if (!(error instanceof Rollback)) throw error
    }
  })
})
