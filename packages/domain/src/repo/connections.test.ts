import { describe, expect, it } from 'vitest'

import { repoPressRefusalText } from './actions.ts'
import {
  gitConnectionLimits,
  gitConnectionReasons,
  gitConnectionReasonText,
  gitConnectionSecretPath,
  gitConnectionSecretSchema,
  gitlabComOffered,
  gitServerHostOf,
  gitTokenInputSchema,
  isGitConnectionReason,
  repoReauthText,
} from './connections.ts'
import { repoLeftTexts } from './feed.ts'
import { gitConnectionKinds } from './statuses.ts'

// The git connections of a user (docs/plan/84-projects.md, ПР10, ПР29; slice 84.17).
describe('git connections', () => {
  it('takes the host of an own GitLab server as a name or its https address only', () => {
    expect(gitServerHostOf('git.kolos-bakery.ru')).toBe('git.kolos-bakery.ru')
    expect(gitServerHostOf(' https://Git.Kolos-Bakery.ru/ ')).toBe('git.kolos-bakery.ru')
    expect(gitServerHostOf('https://git.kolos-bakery.ru:443')).toBe('git.kolos-bakery.ru')
    for (const refused of [
      'http://git.kolos-bakery.ru',
      'https://git.kolos-bakery.ru:8443',
      'https://user:pass@git.kolos-bakery.ru',
      'https://git.kolos-bakery.ru/group',
      'https://10.0.0.1',
      'localhost',
      '',
    ])
      expect(gitServerHostOf(refused)).toBeNull()
  })

  it('offers GitLab.com in production only once the texts of 84.16а are published', () => {
    expect(gitlabComOffered('development', true)).toBe(true)
    expect(gitlabComOffered('development', false)).toBe(false)
    expect(gitlabComOffered('production', true)).toBe(false)
  })

  it('keeps the tokens as strings at the path of the workspace', () => {
    expect(gitConnectionSecretPath('w', 'c')).toBe('kv/workspaces/w/git/c')
    expect(
      gitConnectionSecretSchema.safeParse({ accessToken: 'a', expiresAt: '2030-01-01T00:00:00Z' })
        .success,
    ).toBe(true)
    expect(gitConnectionSecretSchema.safeParse({ token: 't' }).success).toBe(true)
    expect(gitConnectionSecretSchema.safeParse({ token: 't', extra: 'x' }).success).toBe(false)
    expect(gitTokenInputSchema.safeParse('glpat with space').success).toBe(false)
    expect(
      gitTokenInputSchema.safeParse('x'.repeat(gitConnectionLimits.tokenChars + 1)).success,
    ).toBe(false)
  })

  // docs/plan/84-projects.md, §10, «Остаток списка — закрыто»: no GitLab for a repository on GitHub.
  it('names the provider of a sign-in to renew, or says it in neutral words', () => {
    expect(repoReauthText('gitlab')).toBe('Нужно войти в GitLab заново')
    expect(repoReauthText('github')).toBe('Нужно войти в GitHub заново')
    expect(repoReauthText(null)).toBe('Нужно заново войти туда, где лежит репозиторий')
    expect(repoLeftTexts.reauth).toBe(repoReauthText(null))
    expect(repoPressRefusalText('GIT_CONNECTION_REAUTH', 'github')).toBe(
      'Нужно войти в GitHub заново',
    )
    expect(repoPressRefusalText('GIT_CONNECTION_REAUTH', null)).toBe(repoReauthText(null))
    expect(repoPressRefusalText('REPO_CHANGED', 'github')).toBe(
      'Изменения обновились — посмотрите ещё раз',
    )
    expect(repoPressRefusalText('SOMETHING_ELSE', 'gitlab')).toBeNull()
    expect(repoPressRefusalText(null, 'gitlab')).toBeNull()
    expect(repoPressRefusalText('toString', 'gitlab')).toBeNull()
  })

  it('says why a connection stopped in the words of its own kind', () => {
    expect(gitConnectionReasonText('reauth', 'gitlab_oauth')).toBe('Нужно войти в GitLab заново')
    expect(gitConnectionReasonText('reauth', 'gitlab_token')).toBe('Нужно войти в GitLab заново')
    expect(gitConnectionReasonText('reauth', 'github_app')).toBe('Нужно войти в GitHub заново')
    expect(gitConnectionReasonText('access_denied', 'gitlab_token')).toBe(
      'GitLab не принял токен — проверьте его права и срок',
    )
    expect(gitConnectionReasonText('access_denied', 'gitlab_oauth')).toBe(
      'GitLab не дал доступ — подключите GitLab заново',
    )
    expect(gitConnectionReasonText('access_denied', 'github_app')).toBe(
      'GitHub не дал доступ — подключите GitHub заново',
    )
    expect(gitConnectionReasonText('access_denied', null)).toBe(
      'Доступ к репозиторию не подтвердился — подключите его заново',
    )
    expect(gitConnectionReasonText('installation_gone', 'github_app')).toBe(
      'Приложение Радити на GitHub удалено или приостановлено — подключите GitHub заново',
    )
    // GitHub is never told of GitLab, and the other way round, but by the GitHub App's own reason.
    for (const reason of gitConnectionReasons) {
      for (const kind of gitConnectionKinds) {
        const text = gitConnectionReasonText(reason, kind)
        expect(text).toMatch(/^[А-ЯЁA-Z]/u)
        if (kind === 'github_app') expect(text).not.toMatch(/GitLab/)
        else if (reason !== 'installation_gone') expect(text).not.toMatch(/GitHub/)
      }
      expect(gitConnectionReasonText(reason, null)).not.toMatch(/GitLab/)
    }
    expect(isGitConnectionReason('reauth')).toBe(true)
    expect(isGitConnectionReason('expired')).toBe(false)
  })
})
