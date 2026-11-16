import { DEV_REPO_CONFIRM_SECRET } from '@repo/git-providers/connect'
import { describe, expect, it } from 'vitest'

import { webGitEnvFromEnv } from './git-env'

describe('webGitEnvFromEnv (docs/plan/84-projects.md, 84.16)', () => {
  it('leaves the apps off without their variables, with a development secret outside production', () => {
    expect(webGitEnvFromEnv({ APP_ENV: 'development' })).toEqual({
      gitlabOauth: null,
      githubApp: null,
      repoConfirmSecret: DEV_REPO_CONFIRM_SECRET,
      endpoints: {},
      allowLoopback: false,
    })
    // Production without the secret offers no card, never one signed with a known key.
    expect(webGitEnvFromEnv({ APP_ENV: 'production' }).repoConfirmSecret).toBeNull()
  })

  it('reads the gitlab.com app, the GitHub App and the secret of the cards', () => {
    expect(
      webGitEnvFromEnv({
        APP_ENV: 'production',
        GITLAB_OAUTH_CLIENT_ID: 'gl-id',
        GITLAB_OAUTH_CLIENT_SECRET: 'gl-secret',
        REPO_CONFIRM_SECRET: 'c'.repeat(64),
        GITHUB_APP_SLUG: 'raditi',
        GITHUB_APP_CLIENT_ID: 'Iv1.abc',
        GITHUB_APP_CLIENT_SECRET: 'gh-secret',
        GITHUB_APP_WEBHOOK_SECRET: 'gh-hook',
        // core's part: web never reads it
        GITHUB_APP_ID: '12345',
      }),
    ).toEqual({
      gitlabOauth: { clientId: 'gl-id', clientSecret: 'gl-secret' },
      githubApp: {
        slug: 'raditi',
        clientId: 'Iv1.abc',
        clientSecret: 'gh-secret',
        webhookSecret: 'gh-hook',
      },
      repoConfirmSecret: 'c'.repeat(64),
      endpoints: {},
      allowLoopback: false,
    })
  })

  it('lets the fakes of a stand through outside production only', () => {
    expect(
      webGitEnvFromEnv({
        APP_ENV: 'test',
        GIT_ALLOW_LOOPBACK: '1',
        RADITI_FAKE_GITLAB_COM_URL: 'https://localhost:9443',
      }),
    ).toMatchObject({ allowLoopback: true, endpoints: { gitlabComUrl: 'https://localhost:9443' } })
    expect(() => webGitEnvFromEnv({ APP_ENV: 'production', GIT_ALLOW_LOOPBACK: '1' })).toThrow(
      /GIT_ALLOW_LOOPBACK: only outside production/,
    )
    expect(() =>
      webGitEnvFromEnv({
        APP_ENV: 'production',
        RADITI_FAKE_GITHUB_API_URL: 'https://localhost:9441',
      }),
    ).toThrow(/RADITI_FAKE_GITHUB_API_URL: only outside production/)
    expect(() => webGitEnvFromEnv({ APP_ENV: 'production', GITHUB_APP_SLUG: 'raditi' })).toThrow(
      /GITHUB_APP_WEBHOOK_SECRET: set/,
    )
  })
})
