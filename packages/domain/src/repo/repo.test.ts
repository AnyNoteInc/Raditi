import { describe, expect, it } from 'vitest'

import { DomainError } from '../errors.ts'
import {
  checksOf,
  feedRepoActionPayloadSchema,
  feedRepoChangesPayloadSchema,
  feedRepoCiVarsPayloadSchema,
  isRepoPath,
  mergeRequestLabel,
  neutraliseMergeRequestDescription,
  neutraliseMergeRequestTitle,
  parseRepositoryLink,
  repoActionText,
  repoCloneUrl,
  repoRefSchema,
  repoRefusalTexts,
  sameHostUrl,
} from './index.ts'

const refusal = (fn: () => unknown): string => {
  try {
    fn()
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  throw new Error('no refusal')
}

describe('parseRepositoryLink', () => {
  it.each([
    ['https://github.com/acme/site', 'github', 'github.com', 'acme/site'],
    ['https://www.github.com/acme/site.git', 'github', 'github.com', 'acme/site'],
    ['https://github.com/acme/site/tree/main/src', 'github', 'github.com', 'acme/site'],
    ['https://gitlab.com/group/sub/project', 'gitlab', 'gitlab.com', 'group/sub/project'],
    [
      'https://gitlab.example.ru/group/sub/project.git',
      'gitlab',
      'gitlab.example.ru',
      'group/sub/project',
    ],
    [
      'https://gitlab.example.ru/group/sub/project/-/tree/main?ref_type=heads',
      'gitlab',
      'gitlab.example.ru',
      'group/sub/project',
    ],
    [
      'https://GitLab.Example.RU:443/group/project/',
      'gitlab',
      'gitlab.example.ru',
      'group/project',
    ],
  ])('%s', (link, provider, host, path) => {
    expect(parseRepositoryLink(link)).toEqual({ provider, host, path })
  })

  it.each([
    'http://github.com/acme/site',
    'https://user:pass@gitlab.example.ru/g/p',
    'https://gitlab.example.ru:8443/g/p',
    'https://10.0.0.1/g/p',
    'https://[::1]/g/p',
    'https://localhost/g/p',
    'https://github.com/acme',
    'https://gitlab.example.ru/project',
    'https://gitlab.example.ru/g/../p',
    'https://gitlab.example.ru/g/-p',
    'ssh://git@gitlab.com/g/p.git',
    'git@github.com:acme/site.git',
    'не ссылка',
  ])('refuses %s', (link) => {
    expect(refusal(() => parseRepositoryLink(link))).toBe('REPO_LINK_INVALID')
  })
})

describe('isRepoPath', () => {
  it('GitHub is exactly two segments', () => {
    expect(isRepoPath('github', 'acme/site')).toBe(true)
    expect(isRepoPath('github', 'acme/sub/site')).toBe(false)
    expect(isRepoPath('github', 'acme/..')).toBe(false)
    expect(isRepoPath('github', '-acme/site')).toBe(false)
  })
  it('GitLab allows subgroups and refuses .git and .atom segments', () => {
    expect(isRepoPath('gitlab', 'group/sub/project')).toBe(true)
    expect(isRepoPath('gitlab', 'group/project.git')).toBe(false)
    expect(isRepoPath('gitlab', 'group/x.atom')).toBe(false)
    expect(isRepoPath('gitlab', `g/${'a'.repeat(300)}`)).toBe(false)
  })
})

describe('repoRefSchema', () => {
  it('ties GitHub to github.com', () => {
    expect(
      repoRefSchema.safeParse({ provider: 'github', host: 'gitlab.com', path: 'a/b' }).success,
    ).toBe(false)
    expect(
      repoRefSchema.safeParse({ provider: 'gitlab', host: 'github.com', path: 'a/b' }).success,
    ).toBe(false)
    expect(
      repoRefSchema.safeParse({
        provider: 'gitlab',
        host: 'gitlab.example.ru',
        path: 'group/sub/project',
        providerRepoId: '42',
      }).success,
    ).toBe(true)
  })
  it('refuses a provider id that is not a number', () => {
    expect(
      repoRefSchema.safeParse({
        provider: 'gitlab',
        host: 'gitlab.example.ru',
        path: 'g/p',
        providerRepoId: '../42',
      }).success,
    ).toBe(false)
  })
})

describe('addresses', () => {
  it('builds the git address from the host and the path', () => {
    expect(repoCloneUrl({ host: 'gitlab.example.ru', path: 'group/sub/project' })).toBe(
      'https://gitlab.example.ru/group/sub/project.git',
    )
  })
  it('keeps an address of the same host only', () => {
    const fallback = 'https://gitlab.example.ru/g/p'
    expect(
      sameHostUrl(
        'gitlab.example.ru',
        'https://gitlab.example.ru/g/p/-/merge_requests/3',
        fallback,
      ),
    ).toBe('https://gitlab.example.ru/g/p/-/merge_requests/3')
    for (const given of [
      'https://evil.example/g/p',
      'http://gitlab.example.ru/g/p',
      'https://gitlab.example.ru:8443/g/p',
      'https://u:p@gitlab.example.ru/g/p',
      'javascript:alert(1)',
      42,
      null,
    ])
      expect(sameHostUrl('gitlab.example.ru', given, fallback)).toBe(fallback)
  })
})

describe('neutralising the text of a merge request (ПР14)', () => {
  it('breaks quick actions, mentions and closing words', () => {
    const out = neutraliseMergeRequestDescription(
      'Меню обновлено.\n/merge\n  /approve\n/target_branch main\nCloses #12, fixes group/p#3\n@all @boss посмотрите',
    )
    for (const line of out.split('\n')) expect(line).not.toMatch(/^\s*\//)
    expect(out).not.toMatch(/@[\w]/)
    expect(out).not.toMatch(/\b(closes|fixes)\b/i)
    expect(out).toContain('#12')
    expect(out).toContain('group/p#3')
    expect(out.replaceAll('​', '')).toContain('/merge')
  })
  it('keeps ordinary words', () => {
    expect(neutraliseMergeRequestDescription('fix the menu, close the gap')).toBe(
      'fix the menu, close the gap',
    )
  })
  it('a title is one line, without a draft prefix of its own, never empty', () => {
    expect(neutraliseMergeRequestTitle('Draft: WIP: новое меню\nвторая')).toBe('новое меню вторая')
    expect(neutraliseMergeRequestTitle('/merge')).toBe('​/merge')
    expect(neutraliseMergeRequestTitle('  ')).toBe('Изменения агента')
    expect(Array.from(neutraliseMergeRequestTitle('я'.repeat(400)))).toHaveLength(255)
  })
})

describe('words', () => {
  it('a label is what the adapter writes', () => {
    expect(mergeRequestLabel({ requestRef: (n) => `!${n}` }, 37)).toBe('!37')
    expect(() => mergeRequestLabel({ requestRef: (n) => `#${n}` }, 0)).toThrow(RangeError)
  })
  it('checks from the newest pipeline', () => {
    expect(checksOf(null)).toBe('none')
    expect(checksOf('running')).toBe('pending')
    expect(checksOf('canceled')).toBe('failure')
    expect(checksOf('success')).toBe('success')
  })
  it('every refusal has a Russian text', () => {
    for (const text of Object.values(repoRefusalTexts)) expect(text).toMatch(/[а-яё]/i)
  })
  it('the line of an opened merge request names its number', () => {
    expect(repoActionText({ kind: 'open_mr', state: 'done' }, '!37')).toBe(
      'Запрос на слияние !37 открыт',
    )
    expect(repoActionText({ kind: 'merge', state: 'waiting' }, null)).toBe(
      'Примем в основную ветку, когда сборка пройдёт',
    )
  })
})

describe('feed rows', () => {
  const sha = 'a'.repeat(40)
  it('repo_changes', () => {
    expect(
      feedRepoChangesPayloadSchema.safeParse({
        v: 1,
        branch: 'raditi/novoe-menyu-1a2b3c4d',
        baseSha: sha,
        headSha: sha,
        diffSha256: 'b'.repeat(64),
        files: 1,
        additions: 3,
        deletions: 0,
        list: [{ path: 'index.html', additions: 3, deletions: 0 }],
        ciTouched: false,
        pushed: false,
        mergeRequest: null,
      }).success,
    ).toBe(true)
  })
  it('an action url is https', () => {
    const row = {
      v: 1,
      actionId: '0193a5b0-0000-7000-8000-000000000001',
      kind: 'open_mr',
      state: 'done',
    }
    expect(
      feedRepoActionPayloadSchema.safeParse({
        ...row,
        url: 'https://gitlab.com/g/p/-/merge_requests/1',
      }).success,
    ).toBe(true)
    expect(
      feedRepoActionPayloadSchema.safeParse({ ...row, url: 'javascript:alert(1)' }).success,
    ).toBe(false)
  })
  it('ci vars are names only', () => {
    expect(
      feedRepoCiVarsPayloadSchema.safeParse({
        v: 1,
        names: ['SSH_PRIVATE_KEY'],
        settingsUrl: 'https://gitlab.com/g/p/-/settings/ci_cd',
      }).success,
    ).toBe(true)
    expect(
      feedRepoCiVarsPayloadSchema.safeParse({
        v: 1,
        names: ['A=secret'],
        settingsUrl: 'https://x.ru',
      }).success,
    ).toBe(false)
  })
})
