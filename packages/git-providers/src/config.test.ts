import { describe, expect, it } from 'vitest'

import { coreGitAppsFromEnv, DEV_REPO_CONFIRM_SECRET, webGitAppsFromEnv } from './config.ts'

const secret = 'r'.repeat(64)
const pem =
  '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA\n-----END PRIVATE KEY-----\n'

describe('the variables of the git apps (docs/plan/84-projects.md, §4.5)', () => {
  it('leaves everything off when nothing is set, with a development secret outside production', () => {
    expect(webGitAppsFromEnv({ APP_ENV: 'development' })).toEqual({
      gitlabOauth: null,
      githubApp: null,
      repoConfirmSecret: DEV_REPO_CONFIRM_SECRET,
      endpoints: {},
    })
    expect(coreGitAppsFromEnv({ APP_ENV: 'production' })).toEqual({
      gitlabOauth: null,
      githubApp: null,
      repoConfirmSecret: null,
      endpoints: {},
    })
  })

  it('gives web and core the same gitlab.com app and secret, each its part of the GitHub App', () => {
    const env = {
      APP_ENV: 'production',
      GITLAB_OAUTH_CLIENT_ID: 'gl-id',
      GITLAB_OAUTH_CLIENT_SECRET: 'gl-secret',
      REPO_CONFIRM_SECRET: secret,
      GITHUB_APP_SLUG: 'raditi',
      GITHUB_APP_CLIENT_ID: 'Iv1.abc',
      GITHUB_APP_CLIENT_SECRET: 'gh-secret',
      GITHUB_APP_WEBHOOK_SECRET: 'gh-hook',
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY_FILE: '/run/raditi/github-app.pem',
    }
    const web = webGitAppsFromEnv(env)
    const core = coreGitAppsFromEnv(env)
    for (const config of [web, core]) {
      expect(config.gitlabOauth).toEqual({ clientId: 'gl-id', clientSecret: 'gl-secret' })
      expect(config.repoConfirmSecret).toBe(secret)
    }
    expect(web.githubApp).toEqual({
      slug: 'raditi',
      clientId: 'Iv1.abc',
      clientSecret: 'gh-secret',
      webhookSecret: 'gh-hook',
    })
    expect(core.githubApp).toEqual({
      appId: '12345',
      key: { kind: 'file', path: '/run/raditi/github-app.pem' },
    })
  })

  it('takes the key as a PEM in base64 on one line outside production only', () => {
    const inline = Buffer.from(pem).toString('base64')
    expect(
      coreGitAppsFromEnv({
        APP_ENV: 'development',
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY_FILE: inline,
      }).githubApp,
    ).toEqual({ appId: '1', key: { kind: 'pem', pem } })
    expect(() =>
      coreGitAppsFromEnv({
        APP_ENV: 'production',
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY_FILE: inline,
      }),
    ).toThrow(/GITHUB_APP_PRIVATE_KEY_FILE: must be an absolute path in production/)
    expect(() =>
      coreGitAppsFromEnv({
        APP_ENV: 'development',
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY_FILE: Buffer.from('not a key').toString('base64'),
      }),
    ).toThrow(/GITHUB_APP_PRIVATE_KEY_FILE: must be an absolute path or a PEM/)
  })

  it.each([
    [{ GITLAB_OAUTH_CLIENT_ID: 'gl-id' }, /GITLAB_OAUTH_CLIENT_SECRET: set .* together/],
    [{ GITHUB_APP_SLUG: 'raditi' }, /GITHUB_APP_CLIENT_ID: set .* together/],
    [{ GITHUB_APP_SLUG: 'Raditi App' }, /GITHUB_APP_SLUG: must be the slug/],
    [{ REPO_CONFIRM_SECRET: 'short' }, /REPO_CONFIRM_SECRET: must be at least 32/],
    [{ REPO_CONFIRM_SECRET: `${secret} x` }, /REPO_CONFIRM_SECRET: must be one word/],
    [
      { RADITI_FAKE_GITLAB_COM_URL: 'https://localhost:9443' },
      /RADITI_FAKE_GITLAB_COM_URL: only outside production/,
    ],
  ])('web refuses %o in production', (vars, problem) => {
    expect(() => webGitAppsFromEnv({ APP_ENV: 'production', ...vars })).toThrow(problem)
  })

  it.each([
    [{ GITHUB_APP_ID: '1' }, /GITHUB_APP_PRIVATE_KEY_FILE: set .* together/],
    [{ GITHUB_APP_ID: 'abc', GITHUB_APP_PRIVATE_KEY_FILE: '/k.pem' }, /GITHUB_APP_ID: must be/],
    [
      { RADITI_FAKE_GITHUB_API_URL: 'https://api.github.com' },
      /RADITI_FAKE_GITHUB_API_URL: must be https:\/\/localhost/,
    ],
    [
      { RADITI_FAKE_GITHUB_WEB_URL: 'http://localhost:9443' },
      /RADITI_FAKE_GITHUB_WEB_URL: must be https:\/\/localhost/,
    ],
  ])('core refuses %o', (vars, problem) => {
    expect(() => coreGitAppsFromEnv({ APP_ENV: 'development', ...vars })).toThrow(problem)
  })

  it('names no value in its error', () => {
    const error = (() => {
      try {
        coreGitAppsFromEnv({
          APP_ENV: 'production',
          GITLAB_OAUTH_CLIENT_SECRET: 'gl-very-secret',
          REPO_CONFIRM_SECRET: 'short-secret-value',
        })
      } catch (caught) {
        return String((caught as Error).message)
      }
      return ''
    })()
    expect(error).toMatch(/GITLAB_OAUTH_CLIENT_ID/)
    expect(error).not.toMatch(/gl-very-secret|short-secret-value/)
  })

  it('passes the fakes of a stand outside production', () => {
    expect(
      webGitAppsFromEnv({
        APP_ENV: 'test',
        RADITI_FAKE_GITHUB_API_URL: 'https://localhost:9441',
        RADITI_FAKE_GITHUB_WEB_URL: 'https://localhost:9442',
        RADITI_FAKE_GITLAB_COM_URL: 'https://localhost:9443',
      }).endpoints,
    ).toEqual({
      githubApiUrl: 'https://localhost:9441',
      githubWebUrl: 'https://localhost:9442',
      gitlabComUrl: 'https://localhost:9443',
    })
  })
})
