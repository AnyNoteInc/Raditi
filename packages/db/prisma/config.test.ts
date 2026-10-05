import { existsSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', () => ({ existsSync: vi.fn(() => true) }))

const argv = process.argv

beforeEach(() => {
  // The config announces its target on stderr; keep the synthetic ones out of the test output.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  process.argv = argv
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

/** Loads the config as `prisma <command>` would and returns what it wrote to stderr. */
async function notice(command: string[], env: { exported?: string; file?: string }) {
  // A test may load the config more than once.
  vi.restoreAllMocks()
  vi.resetModules()
  process.argv = ['node', 'prisma', ...command]
  vi.stubEnv('DATABASE_URL', env.exported)
  vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
    // loadEnvFile never overrides a variable that is already set.
    if (env.exported === undefined && env.file !== undefined) vi.stubEnv('DATABASE_URL', env.file)
  })
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  await import('../prisma.config.ts')
  return stderr.mock.calls.map(([chunk]) => String(chunk)).join('')
}

describe('Prisma environment', () => {
  it('loads the repository .env even with an explicit database URL', async () => {
    const url = 'postgresql://raditi:synthetic@localhost/isolated_test'
    vi.stubEnv('DATABASE_URL', url)
    const load = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => undefined)
    const { default: config } = await import('../prisma.config.ts')

    expect(config.datasource?.url).toBe(url)
    expect(load).toHaveBeenCalledExactlyOnceWith(new URL('../../../.env', import.meta.url))
    expect(existsSync).toHaveBeenCalledExactlyOnceWith(new URL('../../../.env', import.meta.url))
  })

  it('preserves the repository .env fallback for a local CLI without a URL', async () => {
    vi.stubEnv('DATABASE_URL', undefined)
    const url = 'postgresql://raditi:synthetic@localhost/local_test'
    const load = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      vi.stubEnv('DATABASE_URL', url)
    })
    const { default: config } = await import('../prisma.config.ts')

    expect(config.datasource?.url).toBe(url)
    expect(load).toHaveBeenCalledExactlyOnceWith(new URL('../../../.env', import.meta.url))
  })

  it('lets generate run without a URL or a local .env', async () => {
    vi.stubEnv('DATABASE_URL', undefined)
    vi.mocked(existsSync).mockReturnValueOnce(false)
    const load = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => undefined)
    const { default: config } = await import('../prisma.config.ts')

    expect(config.datasource?.url).toBeUndefined()
    expect(load).not.toHaveBeenCalled()
  })

  describe('target notice', () => {
    const fromFile = 'postgresql://raditi:file-secret@localhost:5432/raditi?schema=public'
    const fromShell = 'postgresql://verify:shell-secret@127.0.0.1:54329/disposable'

    it.each(['migrate deploy', 'migrate dev', 'db seed', 'studio'])(
      'tells `prisma %s` that it works on the database of the repository .env',
      async (command) => {
        expect(await notice(command.split(' '), { file: fromFile })).toBe(
          '[db] target raditi@localhost:5432/raditi: DATABASE_URL from the repository .env\n',
        )
      },
    )

    it("names an exported URL as the environment's, whatever the .env holds", async () => {
      expect(await notice(['db', 'seed'], { exported: fromShell, file: fromFile })).toBe(
        '[db] target verify@127.0.0.1:54329/disposable: DATABASE_URL from the environment\n',
      )
    })

    it('never prints the password or the query of the URL', async () => {
      const printed = [
        await notice(['migrate', 'deploy'], { file: fromFile }),
        await notice(['migrate', 'deploy'], { exported: 'not a url with shell-secret' }),
      ].join('')
      expect(printed).not.toMatch(/secret|schema=/)
      expect(printed).toContain('[db] target an unparseable DATABASE_URL: ')
    })

    it.each(['generate', 'validate', 'format'])(
      'stays silent for `prisma %s`, which opens no connection',
      async (command) => {
        expect(await notice([command], { file: fromFile })).toBe('')
      },
    )

    it('has nothing to say without a URL: Prisma reports that itself', async () => {
      expect(await notice(['migrate', 'deploy'], {})).toBe('')
    })
  })
})
