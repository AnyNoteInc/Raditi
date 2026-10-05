import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { describe, expect, it } from 'vitest'

import { signUpProfile } from './profile.ts'
import { profileLastNameSchema, profileNameSchema } from './profile-schema.ts'

function authWithProfile() {
  const store = {
    user: [] as Record<string, unknown>[],
    session: [],
    account: [],
    verification: [],
  }
  const auth = betterAuth({
    baseURL: 'http://localhost:3000',
    secret: 'x'.repeat(32),
    database: memoryAdapter(store),
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    emailVerification: { sendOnSignUp: true, sendVerificationEmail: async () => {} },
    telemetry: { enabled: false },
    logger: { disabled: true },
    plugins: [signUpProfile()],
  })
  return { auth, store }
}

const signUp = (auth: ReturnType<typeof authWithProfile>['auth'], extra: Record<string, unknown>) =>
  auth.api.signUpEmail({
    body: { email: 'owner@example.ru', password: 'correct-horse-battery', name: 'Анна', ...extra },
  })

describe('profile schemas', () => {
  it('trims a name and a surname; a blank surname removes it', () => {
    expect(profileNameSchema.parse('  Анна-Мария  ')).toBe('Анна-Мария')
    expect(profileLastNameSchema.parse('  Иванова  ')).toBe('Иванова')
    expect(profileLastNameSchema.parse(' \t ')).toBeNull()
  })

  it.each([
    '',
    '   ',
    'x'.repeat(256),
    'А\u0000',
    'А\nБ',
    'А\tБ',
    'А\u007fБ',
    'А\u0085Б',
    42,
    null,
  ])('rejects the name %j', (name) => {
    expect(profileNameSchema.safeParse(name).success).toBe(false)
  })

  it.each(['x'.repeat(256), 'Ив\u0000', 'Ив\nанова', 42, null])(
    'rejects the surname %j',
    (lastName) => {
      expect(profileLastNameSchema.safeParse(lastName).success).toBe(false)
    },
  )
})

describe('sign-up profile plugin', () => {
  it.each([
    ['a blank name', { name: '   ' }],
    ['a name over the column width', { name: 'x'.repeat(256) }],
    ['a name with U+0000', { name: 'А\u0000' }],
    ['a name with a line break', { name: 'А\nБ' }],
  ])('refuses %s in Russian and creates no user', async (_title, extra) => {
    const { auth, store } = authWithProfile()

    await expect(signUp(auth, extra)).rejects.toMatchObject({
      status: 'BAD_REQUEST',
      body: { code: 'INVALID_NAME', message: expect.stringMatching(/^Укажите имя/) },
    })
    expect(store.user).toEqual([])
  })

  it('refuses an address longer than RFC 5321 allows before it reaches users.email', async () => {
    const { auth, store } = authWithProfile()
    // 255 characters: a well-formed address better-auth accepts, one over the 254 limit.
    const long = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(59)}.ru`
    expect(long).toHaveLength(255)

    await expect(signUp(auth, { email: long })).rejects.toMatchObject({
      status: 'BAD_REQUEST',
      body: { code: 'INVALID_EMAIL' },
    })
    expect(store.user).toEqual([])

    const longest = long.slice(1)
    expect(longest).toHaveLength(254)
    await expect(signUp(auth, { email: longest })).resolves.toMatchObject({
      user: { email: longest },
    })
  })

  it('refuses a profile image: photos go through the avatar upload only', async () => {
    const { auth, store } = authWithProfile()

    await expect(
      signUp(auth, { image: 'https://tracker.example/pixel.gif' }),
    ).rejects.toMatchObject({
      status: 'BAD_REQUEST',
      body: { code: 'IMAGE_NOT_ALLOWED' },
    })
    await expect(signUp(auth, { image: '' })).rejects.toMatchObject({
      body: { code: 'IMAGE_NOT_ALLOWED' },
    })
    expect(store.user).toEqual([])
  })

  it('answers the same for a taken address: the check runs before the lookup', async () => {
    const { auth, store } = authWithProfile()
    await signUp(auth, {})

    await expect(signUp(auth, { name: ' ' })).rejects.toMatchObject({
      body: { code: 'INVALID_NAME' },
    })
    await expect(signUp(auth, { image: 'https://tracker.example/p.gif' })).rejects.toMatchObject({
      body: { code: 'IMAGE_NOT_ALLOWED' },
    })
    expect(store.user).toHaveLength(1)
  })

  it('stores the trimmed name and no image', async () => {
    const { auth, store } = authWithProfile()

    const { user } = await signUp(auth, { name: '  Анна  ' })

    expect(user.name).toBe('Анна')
    expect(store.user).toHaveLength(1)
    expect(store.user[0]).toMatchObject({ name: 'Анна', email: 'owner@example.ru' })
    expect(store.user[0]!.image ?? null).toBeNull()
  })
})
