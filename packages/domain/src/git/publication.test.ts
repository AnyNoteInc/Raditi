import { describe, expect, it } from 'vitest'

import {
  isPublicationPath,
  publicationChangeOf,
  publicationLimits,
  repoBranchSchema,
  repoChatRef,
  repoPublicationSchema,
} from './publication.ts'

const change = (sizeBytes: number, path = 'src/app.ts') => ({
  path,
  oldMode: '000000',
  newMode: '100644',
  sizeBytes,
})

describe('publicationChangeOf', () => {
  it('accepts a file at the size limit', () => {
    expect(publicationChangeOf(change(publicationLimits.fileBytes))).toEqual({ build: false })
  })

  it('reports a file over the size limit as too large (413), not as invalid input', () => {
    expect(() => publicationChangeOf(change(publicationLimits.fileBytes + 1))).toThrow(
      expect.objectContaining({ code: 'PUBLICATION_TOO_LARGE', httpStatus: 413 }),
    )
  })

  it('reports an impossible size as rejected agent output', () => {
    expect(() => publicationChangeOf(change(-1))).toThrow(
      expect.objectContaining({ code: 'TURN_OUTPUT_REJECTED', httpStatus: 502 }),
    )
  })

  it.each([
    '-option',
    '.git/config',
    'nested/.GIT/hooks/pre-commit',
    'a/../b',
    'a\\b',
    'git~1/config',
    '.git./config',
    'a/.GIT . /b',
    '.git::$INDEX_ALLOCATION/x',
  ])('refuses the agent path %s', (path) => {
    expect(isPublicationPath(path)).toBe(false)
    expect(() => publicationChangeOf(change(1, path))).toThrow(
      expect.objectContaining({ code: 'TURN_OUTPUT_REJECTED' }),
    )
  })

  it.each(['.gitlab-ci.yml', '.github/workflows/ci.yml', '.gitmodules', 'Jenkinsfile'])(
    'marks %s as a path of the build instead of refusing it (ПР12)',
    (path) => {
      expect(publicationChangeOf(change(10, path))).toEqual({ build: true })
    },
  )

  it.each([
    ['000000', '120000'],
    ['100644', '160000'],
    ['100644', '100755'],
  ])('refuses a link, a submodule or a mode change (%s → %s)', (oldMode, newMode) => {
    expect(() => publicationChangeOf({ ...change(1), oldMode, newMode })).toThrow(
      expect.objectContaining({ code: 'PUBLICATION_FORBIDDEN' }),
    )
  })
})

describe('repoPublicationSchema', () => {
  const valid = {
    projectRepositoryId: '0193b7a2-1c3d-7e4f-8a9b-0c1d2e3f4a5b',
    baseSha: 'a'.repeat(40),
    chatId: '0193b7a2-1c3d-7e4f-8a9b-0c1d2e3f4a5c',
    turn: 1,
    createdAt: '2026-11-16T10:00:00.000Z',
    expectedRef: null,
  }

  it('takes a publication and refuses an extra field', () => {
    expect(repoPublicationSchema.safeParse(valid).success).toBe(true)
    expect(repoPublicationSchema.safeParse({ ...valid, branch: 'main' }).success).toBe(false)
  })

  it('names the ref of a chat under refs/raditi', () => {
    expect(repoChatRef(valid.chatId)).toBe(`refs/raditi/${valid.chatId}`)
  })
})

describe('repoBranchSchema', () => {
  it.each(['main', 'raditi/chat-1', 'release/2.0'])('takes %s', (branch) => {
    expect(repoBranchSchema.safeParse(branch).success).toBe(true)
  })

  it.each(['-x', '../main', 'a..b', 'refs/heads/x.lock', 'a b', '.hidden', 'a//b', 'a/'])(
    'refuses %s',
    (branch) => {
      expect(repoBranchSchema.safeParse(branch).success).toBe(false)
    },
  )
})
