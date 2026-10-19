import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  gitAuthEnvironment,
  issueGitAuth,
  runTrustedGit,
  trustedGitEnvironment,
  trustedGitOptions,
} from './trusted-git.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const grant = (ms: number, extra: Record<string, unknown> = {}) => ({
  username: 'bot',
  token: 'synthetic-grant',
  expiresAt: new Date(Date.now() + ms),
  ...extra,
})

describe('trusted git', () => {
  it('inherits nothing of the machine but PATH, and adds a CA only over https', () => {
    vi.stubEnv('GIT_SSL_NO_VERIFY', '1')
    vi.stubEnv('GIT_DIR', '/elsewhere')
    const https = trustedGitEnvironment({
      home: '/private/x',
      protocol: 'https',
      caFile: '/ca.pem',
    })
    expect(https).toMatchObject({
      GIT_SSL_CAINFO: '/ca.pem',
      HOME: '/private/x',
      XDG_CONFIG_HOME: '/private/x',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    })
    expect(Object.keys(https).filter((name) => /NO_VERIFY|GIT_DIR|PROXY/.test(name))).toEqual([])
    const file = trustedGitEnvironment({ home: '/private/x', protocol: 'file', caFile: '/ca.pem' })
    expect('GIT_SSL_CAINFO' in file).toBe(false)
  })

  it('allows one protocol and takes a grant from the environment while it is valid', () => {
    const plain = trustedGitOptions('https', {})
    expect(plain).toContain('protocol.allow=never')
    expect(plain).toContain('protocol.https.allow=always')
    expect(plain).toContain('core.hooksPath=/dev/null')
    // Whatever git was built for: the aliases of `.git` of HFS+ and NTFS are refused everywhere.
    expect(plain).toEqual(expect.arrayContaining(['core.protectHFS=true', 'core.protectNTFS=true']))
    expect(plain.some((option) => option.startsWith('--config-env'))).toBe(false)
    const auth = gitAuthEnvironment(grant(60_000))
    expect(trustedGitOptions('file', auth)).toContain(
      '--config-env=http.extraHeader=RADITI_GIT_AUTH',
    )
    expect(auth.RADITI_GIT_AUTH).toBe(
      `Authorization: Basic ${Buffer.from('bot:synthetic-grant').toString('base64')}`,
    )
    expect(() =>
      trustedGitOptions('https', { ...auth, RADITI_GIT_AUTH_EXPIRES: String(Date.now() - 1) }),
    ).toThrow('expired')
  })

  it.each([
    ['too short', grant(1_000)],
    ['too long', grant(10 * 60_000)],
    ['a colon in the name', grant(60_000, { username: 'b:ot' })],
    ['a control character in the token', grant(60_000, { token: 'a\nb' })],
    ['no token', grant(60_000, { token: '' })],
  ])('refuses a grant with %s', (_, credentials) => {
    expect(() => gitAuthEnvironment(credentials as never)).toThrow('short-lived grant')
  })

  it('maps a provider that fails to a failed operation, never its message', async () => {
    const provider = {
      issueCredentials: vi.fn(async () => Promise.reject(new Error('token=leak'))),
    }
    const ref = { provider: 'gitea' as const, owner: 'sites', name: 'site-x' }
    await expect(issueGitAuth(provider, ref, 'read')).rejects.toMatchObject({
      code: 'GIT_OPERATION_FAILED',
      message: 'Trusted repository operation failed',
    })
    expect(provider.issueCredentials).toHaveBeenCalledWith(ref, 'read', 120)
  })

  it('runs git in the private home without the grant in argv', async () => {
    const home = await mkdtemp(join(tmpdir(), 'raditi-trusted-git-test-'))
    roots.push(home)
    const result = await runTrustedGit(
      { home, protocol: 'file' },
      ['config', '--get', 'core.hooksPath'],
      {
        cwd: home,
        env: gitAuthEnvironment(grant(60_000)),
      },
    )
    expect(result.code).toBe(0)
    expect(result.stdout.toString().trim()).toBe('/dev/null')
  })
})
