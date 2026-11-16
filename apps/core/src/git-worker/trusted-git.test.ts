import { describe, expect, it, vi, afterEach } from 'vitest'

import { trustedGitEnvironment, trustedGitOptions } from './trusted-git.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('trusted git', () => {
  it('inherits nothing of the machine but PATH, and adds a CA only over https', () => {
    vi.stubEnv('GIT_SSL_NO_VERIFY', '1')
    vi.stubEnv('GIT_DIR', '/elsewhere')
    const https = trustedGitEnvironment({ home: '/v/ops/x', protocol: 'https', caFile: '/ca.pem' })
    expect(https).toMatchObject({
      GIT_SSL_CAINFO: '/ca.pem',
      HOME: '/v/ops/x',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    })
    expect(Object.keys(https).filter((name) => /NO_VERIFY|GIT_DIR|PROXY/.test(name))).toEqual([])
    expect(
      'GIT_SSL_CAINFO' in
        trustedGitEnvironment({ home: '/x', protocol: 'none', caFile: '/ca.pem' }),
    ).toBe(false)
  })

  it('runs no hook, filter or link of a repository and allows only its own protocol', () => {
    const none = trustedGitOptions({ home: '/x', protocol: 'none' }, {})
    expect(none).toEqual(
      expect.arrayContaining([
        'core.hooksPath=/dev/null',
        'core.symlinks=false',
        'core.attributesFile=/dev/null',
        'core.excludesFile=/dev/null',
        'core.protectHFS=true',
        'core.protectNTFS=true',
        'core.bigFileThreshold=16m',
        'pack.windowMemory=64m',
        'protocol.allow=never',
        'http.followRedirects=false',
        'transfer.fsckObjects=true',
      ]),
    )
    expect(none.some((option) => /^protocol\.\w+\.allow=always$/.test(option))).toBe(false)
    expect(trustedGitOptions({ home: '/x', protocol: 'https' }, {})).toContain(
      'protocol.https.allow=always',
    )
  })

  it('pins the host of an https remote to the checked address, IPv6 in brackets', () => {
    expect(
      trustedGitOptions(
        {
          home: '/x',
          protocol: 'https',
          pin: { host: 'gitlab.example.ru', address: '203.0.113.7' },
        },
        {},
      ),
    ).toContain('http.curloptResolve=gitlab.example.ru:443:203.0.113.7')
    expect(
      trustedGitOptions(
        {
          home: '/x',
          protocol: 'https',
          pin: { host: 'gitlab.example.ru', address: '2001:db8::7' },
        },
        {},
      ),
    ).toContain('http.curloptResolve=gitlab.example.ru:443:[2001:db8::7]')
  })

  it('takes a grant from the environment while it is valid', () => {
    const auth = {
      RADITI_GIT_AUTH: 'Authorization: Basic eDp5',
      RADITI_GIT_AUTH_EXPIRES: String(Date.now() + 60_000),
    }
    expect(trustedGitOptions({ home: '/x', protocol: 'https' }, auth)).toContain(
      '--config-env=http.extraHeader=RADITI_GIT_AUTH',
    )
    expect(() =>
      trustedGitOptions(
        { home: '/x', protocol: 'https' },
        { ...auth, RADITI_GIT_AUTH_EXPIRES: String(Date.now() - 1) },
      ),
    ).toThrow('expired')
  })
})
