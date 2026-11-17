import { describe, expect, it } from 'vitest'

import {
  ciConfigPathOf,
  ciIncludePaths,
  noRepoCiPaths,
  readRepoCiPaths,
  repoBuildPathMatcher,
  repoCiLintSchema,
  repoCiOwnPaths,
  repoPushRefusalTexts,
  splitDiffByFile,
} from './index.ts'

describe('ciConfigPathOf', () => {
  it('reads an own path, the default and another project apart', () => {
    expect(ciConfigPathOf('ci/pipeline.yml')).toEqual({ path: 'ci/pipeline.yml', foreign: false })
    expect(ciConfigPathOf(null)).toEqual({ path: null, foreign: false })
    expect(ciConfigPathOf('')).toEqual({ path: null, foreign: false })
    for (const value of [
      '.gitlab-ci.yml@group/other',
      'ci/x.yml@group/other:main',
      'https://example.ru/ci.yml',
      '/etc/ci.yml',
      '../other/ci.yml',
      'ci//x.yml',
      'a'.repeat(256),
    ])
      expect(ciConfigPathOf(value)).toEqual({ path: null, foreign: true })
  })
})

describe('readRepoCiPaths', () => {
  it('reads v1, the array of slice 84.17 and anything else', () => {
    const v1 = { v: 1, configPath: 'ci/a.yml', foreign: false, includes: ['ci/b.yml'] }
    expect(readRepoCiPaths(v1)).toEqual(v1)
    expect(readRepoCiPaths(['ci/a.yml'])).toEqual({ ...noRepoCiPaths, configPath: 'ci/a.yml' })
    expect(readRepoCiPaths(null)).toEqual(noRepoCiPaths)
    expect(readRepoCiPaths({ v: 2 })).toEqual(noRepoCiPaths)
  })
})

describe('ciIncludePaths', () => {
  it('normalises the locations and bounds a wildcard by its directory', () => {
    expect(
      ciIncludePaths(['/ci/deploy.yml', 'ci/deploy.yml', 'configs/**/*.yml', '*.yml']),
    ).toEqual(['*', 'ci/deploy.yml', 'configs/'])
  })

  it('more files than it keeps are every path, not the first hundred', () => {
    const many = Array.from({ length: 100 }, (_, i) => `ci/a${String(i).padStart(3, '0')}.yml`)
    expect(ciIncludePaths(many)).toHaveLength(100)
    expect(ciIncludePaths([...many, 'ci/zz-new.yml'])).toEqual(['*'])
  })
})

describe('repoBuildPathMatcher', () => {
  const gitlab = ['.gitlab-ci.yml', '.gitlab/', 'CODEOWNERS', 'docs/CODEOWNERS']
  const matches = repoBuildPathMatcher({
    providerPaths: gitlab,
    own: repoCiOwnPaths(
      { v: 1, configPath: 'ci/pipeline.yml', foreign: false, includes: ['ci/deploy.yml', 'tpl/'] },
      ['extra/job.yml'],
    ),
  })

  it('takes the domain, the provider and the own paths', () => {
    for (const path of [
      '.gitlab-ci.yml',
      '.github/workflows/x.yml',
      '.gitmodules',
      'CODEOWNERS',
      'docs/CODEOWNERS',
      '.gitlab/CODEOWNERS',
      'ci/pipeline.yml',
      'CI/Deploy.yml',
      'tpl/a/b.yml',
      'extra/job.yml',
      '../x',
    ])
      expect(matches(path)).toBe(true)
    for (const path of ['src/app.ts', 'ci/other.yml', 'src/CODEOWNERS', 'tplx/a.yml'])
      expect(matches(path)).toBe(false)
  })

  it('takes everything when an include cannot be bounded', () => {
    expect(repoBuildPathMatcher({ providerPaths: [], own: ['*'] })('src/app.ts')).toBe(true)
  })
})

describe('repoCiLintSchema', () => {
  it('holds what git.ci_lint writes', () => {
    const row = {
      v: 1,
      headSha: 'a'.repeat(40),
      fromSha: 'b'.repeat(40),
      ciDiffSha256: 'c'.repeat(64),
      files: [{ path: '.gitlab-ci.yml', additions: 3, deletions: 1 }],
      tooLarge: false,
      lint: { valid: false, errors: ['jobs config should contain at least one visible job'] },
      includes: ['ci/deploy.yml'],
      declined: false,
    }
    expect(repoCiLintSchema.parse(row)).toEqual(row)
    expect(repoCiLintSchema.safeParse({ ...row, token: 'x' }).success).toBe(false)
  })
})

describe('splitDiffByFile', () => {
  it('cuts a diff into its files', () => {
    const patch =
      'diff --git a/.gitlab-ci.yml b/.gitlab-ci.yml\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/CODEOWNERS b/CODEOWNERS\n@@ -0,0 +1 @@\n+* @x\n'
    expect(splitDiffByFile(patch).map((file) => file.path)).toEqual([
      '.gitlab-ci.yml',
      'CODEOWNERS',
    ])
    expect(splitDiffByFile(patch)[1]!.diff).toMatch(/^diff --git a\/CODEOWNERS/)
    expect(splitDiffByFile('')).toEqual([])
  })
})

describe('the words of the card', () => {
  it('are in Russian', () => {
    for (const code of ['REPO_CI_CHANGE', 'REPO_CI_CONFIG_FOREIGN', 'REPO_CI_DECLINED'] as const)
      expect(repoPushRefusalTexts[code]).toMatch(/настройк/i)
  })
})
