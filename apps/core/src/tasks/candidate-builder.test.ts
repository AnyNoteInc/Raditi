import { createHash } from 'node:crypto'

import {
  candidateFactsSchema,
  candidateFilesSchema,
  candidateMediaSchema,
  candidatePatchKey,
  type SiteAdapter,
} from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import {
  CandidateBuilder,
  createdIdFiles,
  mediaContentType,
  type CandidateContext,
} from './candidate-builder.ts'
import {
  candidateGitOf,
  isComparisonMissing,
  type CandidateGit,
  type CommitComparison,
} from './candidate-git.ts'

const TASK = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'
const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const NEXT = 'c'.repeat(40)
const BASE_TREE = 'd'.repeat(40)
const HEAD_TREE = 'e'.repeat(40)
const MEDIA = 'wp-content/uploads/raditi/'
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const repo = { provider: 'gitea' as const, owner: 'sites', name: 'site-x' }

const op = (id: number, patch: Record<string, unknown> = {}) => ({
  id: BigInt(id),
  kind: 'content_update',
  objectRef: 'post:12',
  fields: ['title'],
  beforeHash: '1'.repeat(64),
  afterHash: '2'.repeat(64),
  beforeObjectKey: `previews/p/ops/${id}/before`,
  beforeSha256: '3'.repeat(64),
  beforeBytes: 40,
  afterObjectKey: `previews/p/ops/${id}/after`,
  afterSha256: '4'.repeat(64),
  afterBytes: 42,
  excluded: false,
  ...patch,
})

/** The trees of the commits of a test: a commit not named here points at its own tree. */
const defaultTrees: Record<string, string> = { [BASE]: BASE_TREE, [HEAD]: HEAD_TREE }

function setup(
  comparisons: Record<string, CommitComparison>,
  operations: ReturnType<typeof op>[] = [],
  trees: Record<string, string> = defaultTrees,
) {
  const compareCommits = vi.fn(async (input: { baseSha: string; headSha: string }) => {
    const answer = comparisons[`${input.baseSha}..${input.headSha}`]
    if (!answer) throw new Error('unexpected comparison')
    return answer
  })
  const treeOf = vi.fn(async ({ sha }: { sha: string }) => trees[sha] ?? sha.replace(/./, '9'))
  const git = {
    readBranchHead: vi.fn(),
    rebaseCandidate: vi.fn(),
    treeOf,
    comparesCommits: true,
    compareCommits,
  } as unknown as CandidateGit
  const put = vi.fn(async () => {})
  const db = {
    previewDbOperation: { findMany: vi.fn(async () => operations) },
  } as unknown as ConstructorParameters<typeof CandidateBuilder>[0]
  // The values the mcp role sealed, as the reader of the plan opens them.
  const record = (stateHash: string, title: string) => ({
    version: 1 as const,
    objectRef: 'post:12',
    kind: 'post' as const,
    title,
    content: '<p>Текст</p>',
    excerpt: '',
    stateHash,
  })
  const values = {
    values: {
      read: vi.fn(),
      readState: vi.fn(async (_owner: unknown, _ref: string, side: 'before' | 'after') => ({
        state: side === 'before' ? record('1'.repeat(64), 'До') : record('2'.repeat(64), 'После'),
        callId: '00000000-0000-4000-8000-0000000000c1',
      })),
    },
    clientValues: vi.fn(async () => ({
      values: [] as string[],
      variables: [{ name: 'API_TOKEN', keyVersion: 3 }],
    })),
  }
  const builder = new CandidateBuilder(
    db,
    git,
    { put },
    () => ({ dbSettings: () => [] }) as unknown as SiteAdapter,
    values,
  )
  return { builder, compareCommits, treeOf, put, values }
}

const context = (patch: Partial<CandidateContext> = {}): CandidateContext => ({
  taskId: TASK,
  workspaceId: '00000000-0000-4000-8000-00000000000b',
  site: {
    id: '00000000-0000-4000-8000-00000000000c',
    stack: 'wordpress',
    url: 'https://site.example.test/',
  },
  repo,
  addOnlyPaths: [MEDIA],
  base: BASE,
  standing: null,
  installedVersion: 'v1.4.2',
  installedSha: null,
  releasedVersions: ['v1.4.2', 'v1.5.0'],
  revision: 1,
  ...patch,
})

const comparison = (patch: Partial<CommitComparison> = {}): CommitComparison => ({
  baseTree: BASE_TREE,
  headTree: HEAD_TREE,
  patch: new TextEncoder().encode('diff --git a/x b/x\n'),
  files: [
    {
      path: 'wp-content/themes/t/header.php',
      change: 'modified',
      sizeBytes: 120,
      executable: false,
    },
    { path: 'wp-content/themes/t/new.php', change: 'added', sizeBytes: 30, executable: false },
    { path: `${MEDIA}logo.png`, change: 'added', sizeBytes: png.byteLength, executable: false },
  ],
  added: [{ path: `${MEDIA}logo.png`, bytes: png }],
  ...patch,
})

describe('CandidateBuilder', () => {
  it('builds the next revision: files, media apart, the plan, facts and a proposed version', async () => {
    const { builder, put } = setup({ [`${BASE}..${HEAD}`]: comparison() }, [op(1)])

    const build = await builder.build(context(), {
      turnNo: 1,
      headSha: HEAD,
      claims: { change_type: 'code', risk: 'low' },
    })

    if (build.kind !== 'candidate') throw new Error(`expected a candidate, got ${build.kind}`)
    const { record } = build
    expect(record).toMatchObject({
      taskId: TASK,
      revision: 1,
      turnNo: 1,
      baseSha: BASE,
      baseTree: BASE_TREE,
      baseVersion: 'v1.4.2',
      headSha: HEAD,
      // A new file makes it a minor version over the highest one the site had.
      proposedBump: 'minor',
      proposedVersion: 'v1.6.0',
      checks: ['php_lint', 'preview_smoke'],
      installed: null,
    })
    expect(candidateFilesSchema.parse(record.files)).toEqual([
      {
        path: 'wp-content/themes/t/header.php',
        change: 'modified',
        sizeBytes: 120,
        executable: false,
      },
      { path: 'wp-content/themes/t/new.php', change: 'added', sizeBytes: 30, executable: false },
    ])
    expect(candidateMediaSchema.parse(record.media)).toEqual([
      {
        path: `${MEDIA}logo.png`,
        contentType: 'image/png',
        sizeBytes: png.byteLength,
        sha256: createHash('sha256').update(png).digest('hex'),
      },
    ])
    expect(record.dbPlan).toHaveLength(1)
    expect(record.dbPlanSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(candidateFactsSchema.parse(record.facts)).toEqual({
      changeType: 'code',
      risk: 'low',
      addedFiles: 1,
      modifiedFiles: 1,
      deletedFiles: 0,
      mediaFiles: 1,
      dbObjects: 1,
      dbSettings: 0,
      dbCreated: 0,
      dbTables: 0,
      createdIdFiles: 0,
      newFunctionality: false,
    })
    // What the client reads of the plan, kept with the revision.
    expect(record.dbView).toMatchObject({
      v: 1,
      planSha256: record.dbPlanSha256,
      oversize: false,
      operations: [
        {
          kind: 'content_update',
          objectRef: 'post:12',
          title: { before: 'До', after: 'После', truncated: false },
        },
      ],
    })
    // The variables the description was checked against, as their rows named them.
    expect(record.dbViewVariables).toEqual([{ name: 'API_TOKEN', keyVersion: 3 }])
    // The diff is in raditi-artifacts before the revision is recorded (R2 reads it).
    expect(put).toHaveBeenCalledWith('artifacts', candidatePatchKey(TASK, 1), comparison().patch, {
      contentType: 'text/x-diff',
      sizeBytes: comparison().patch.byteLength,
    })
  })

  it('names what the site has installed, with its tree, for the record to judge the base', async () => {
    const INSTALLED = 'f'.repeat(40)
    const { builder } = setup({ [`${BASE}..${HEAD}`]: comparison() }, [], {
      ...defaultTrees,
      [INSTALLED]: BASE_TREE,
    })
    const build = await builder.build(context({ installedSha: INSTALLED }), {
      turnNo: 1,
      headSha: HEAD,
      claims: null,
    })
    if (build.kind !== 'candidate') throw new Error(`expected a candidate, got ${build.kind}`)
    expect(build.record.installed).toEqual({ sha: INSTALLED, tree: BASE_TREE })
  })

  it('keeps the revision when the pass added nothing to the standing candidate', async () => {
    // A new commit with the tree of the standing head: the publication of a pass that changed
    // nothing. No comparison is needed to tell it.
    const { builder, compareCommits, put } = setup({}, [], {
      ...defaultTrees,
      [NEXT]: HEAD_TREE,
    })
    const plan = await builder.dbPlan(TASK)
    const standing = {
      id: 'candidate',
      revision: 2,
      baseSha: BASE,
      headSha: HEAD,
      dbPlanSha256: plan.sha256,
      facts: candidateFactsSchema.parse({
        changeType: 'code',
        risk: 'low',
        addedFiles: 1,
        modifiedFiles: 0,
        deletedFiles: 0,
        mediaFiles: 0,
        dbObjects: 0,
        newFunctionality: false,
      }),
    }

    const build = await builder.build(context({ standing, revision: 3 }), {
      turnNo: 3,
      headSha: NEXT,
      claims: { change_type: 'none', risk: 'low' },
    })

    expect(build).toEqual({ kind: 'unchanged' })
    expect(compareCommits).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it('has no candidate when the tree of the head is the base tree and the plan is empty', async () => {
    const { builder, compareCommits, put } = setup({}, [], { [BASE]: BASE_TREE, [HEAD]: BASE_TREE })

    expect(
      await builder.build(context(), {
        turnNo: 1,
        headSha: HEAD,
        claims: { change_type: 'none', risk: 'low' },
      }),
    ).toEqual({
      kind: 'empty',
      baseTree: BASE_TREE,
      dbPlanSha256: (await builder.dbPlan(TASK)).sha256,
    })
    expect(compareCommits).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it('is a new revision when only the plan changed on top of the standing candidate', async () => {
    const { builder } = setup(
      { [`${BASE}..${NEXT}`]: comparison({ headTree: HEAD_TREE }) },
      [op(1)],
      {
        ...defaultTrees,
        [NEXT]: HEAD_TREE,
      },
    )
    const standing = {
      id: 'candidate',
      revision: 1,
      baseSha: BASE,
      headSha: HEAD,
      dbPlanSha256: '0'.repeat(64),
      facts: candidateFactsSchema.parse({
        changeType: 'code',
        risk: 'low',
        addedFiles: 1,
        modifiedFiles: 0,
        deletedFiles: 0,
        mediaFiles: 0,
        dbObjects: 0,
        newFunctionality: false,
      }),
    }

    const build = await builder.build(context({ standing, revision: 2 }), {
      turnNo: 2,
      headSha: NEXT,
      claims: { change_type: 'mixed', risk: 'low' },
    })
    expect(build.kind).toBe('candidate')
  })

  it('refuses a comparison that does not stand on the trees it was asked about', async () => {
    const { builder, put } = setup({ [`${BASE}..${HEAD}`]: comparison({ headTree: NEXT }) })

    await expect(
      builder.build(context(), { turnNo: 1, headSha: HEAD, claims: null }),
    ).rejects.toMatchObject({ code: 'GIT_OPERATION_FAILED' })
    expect(put).not.toHaveBeenCalled()
  })

  it('carries a standing candidate onto a new base with its own claims («Обновить»)', async () => {
    const { builder, compareCommits, treeOf } = setup({ [`${NEXT}..${HEAD}`]: comparison() }, [], {
      [NEXT]: BASE_TREE,
      [HEAD]: HEAD_TREE,
    })
    const standing = {
      id: 'candidate',
      revision: 1,
      baseSha: BASE,
      headSha: 'f'.repeat(40),
      dbPlanSha256: '0'.repeat(64),
      facts: candidateFactsSchema.parse({
        changeType: 'mixed',
        risk: 'medium',
        addedFiles: 1,
        modifiedFiles: 1,
        deletedFiles: 0,
        mediaFiles: 1,
        dbObjects: 0,
        newFunctionality: false,
      }),
    }

    const build = await builder.build(context({ standing, revision: 2 }), {
      turnNo: 1,
      headSha: HEAD,
      baseSha: NEXT,
      claims: null,
    })

    if (build.kind !== 'candidate') throw new Error(`expected a candidate, got ${build.kind}`)
    expect(build.record).toMatchObject({ revision: 2, baseSha: NEXT, headSha: HEAD })
    expect(build.record.facts).toMatchObject({ changeType: 'mixed', risk: 'medium' })
    // No check against the standing head: the base itself moved.
    expect(compareCommits).toHaveBeenCalledTimes(1)
    expect(treeOf).not.toHaveBeenCalledWith(expect.objectContaining({ sha: 'f'.repeat(40) }))
  })

  it('leaves the excluded writes of failed turns out of the plan', async () => {
    const { builder } = setup({}, [op(1, { excluded: true })])
    expect((await builder.dbPlan(TASK)).plan).toEqual([])
  })
})

describe('candidateGitOf', () => {
  it('tells trees without the comparison and refuses the comparison it does not have', async () => {
    const treeOf = vi.fn(async () => BASE_TREE)
    const git = candidateGitOf({ readBranchHead: vi.fn(), rebaseCandidate: vi.fn(), treeOf })
    expect(git.comparesCommits).toBe(false)
    expect(await git.treeOf({ repo, sha: BASE })).toBe(BASE_TREE)
    const refused = await git
      .compareCommits({ repo, baseSha: BASE, headSha: HEAD, addOnlyPaths: [] })
      .catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: 'NOT_IMPLEMENTED' })
    expect(isComparisonMissing(refused)).toBe(true)
  })

  it('checks the shape of what the service answers', async () => {
    const compareCommits = vi.fn(async () => ({ baseTree: 'nope' }))
    const git = candidateGitOf({
      readBranchHead: vi.fn(),
      rebaseCandidate: vi.fn(),
      treeOf: vi.fn(),
      compareCommits,
    })
    expect(git.comparesCommits).toBe(true)
    await expect(
      git.compareCommits({ repo, baseSha: BASE, headSha: HEAD, addOnlyPaths: [] }),
    ).rejects.toMatchObject({ code: 'GIT_OPERATION_FAILED' })
    const good = comparison()
    compareCommits.mockResolvedValueOnce(good as never)
    await expect(
      git.compareCommits({ repo, baseSha: BASE, headSha: HEAD, addOnlyPaths: [] }),
    ).resolves.toEqual(good)
  })
})

describe('candidateGitOf and the row of a repository', () => {
  it('names the repository to the workspace service by its ref alone', async () => {
    // The facts of a pass hold the row of git_repositories: the strict schemas of the service
    // refused the default branch beside the ref as BAD_REQUEST (stand R12).
    const row = { ...repo, defaultBranch: 'main' }
    const readBranchHead = vi.fn(async (_input: { repo: object }) => HEAD)
    const treeOf = vi.fn(async (_input: { repo: object }) => HEAD_TREE)
    const rebaseCandidate = vi.fn(async (_input: { repo: object }) => ({
      status: 'conflict' as const,
      paths: [],
    }))
    const compareCommits = vi.fn(async (_input: { repo: object }) => comparison())
    const git = candidateGitOf({ readBranchHead, treeOf, rebaseCandidate, compareCommits })
    await git.readBranchHead({ repo: row, branch: 'main' })
    await git.treeOf({ repo: row, sha: HEAD })
    await git.compareCommits({ repo: row, baseSha: BASE, headSha: HEAD, addOnlyPaths: [] })
    await git.rebaseCandidate(
      {
        repo: row,
        branch: `agent/${TASK}`,
        fromBase: BASE,
        toBase: NEXT,
        head: HEAD,
        committedAt: '2026-10-17T00:00:00.000Z',
      },
      async () => {},
    )
    for (const call of [readBranchHead, treeOf, compareCommits, rebaseCandidate])
      expect(call.mock.calls[0]?.[0].repo).toStrictEqual(repo)
  })
})

describe('mediaContentType', () => {
  it('names the type by the extension and falls back to an octet stream', () => {
    expect(mediaContentType('a/b.JPG')).toBe('image/jpeg')
    expect(mediaContentType('a/b.woff2')).toBe('font/woff2')
    expect(mediaContentType('a/b.bin')).toBe('application/octet-stream')
  })
})

describe('the files of a candidate that name a created record by its id', () => {
  const created = {
    kind: 'post_create' as const,
    objectRef: 'page:1000000001',
    fields: ['title', 'content', 'excerpt'] as ('title' | 'content' | 'excerpt')[],
    beforeHash: '1'.repeat(64),
    afterHash: '2'.repeat(64),
    before: { key: 'tasks/t/db/1/before.json', sha256: '3'.repeat(64), sizeBytes: 9 },
    after: { key: 'tasks/t/db/1/after.json', sha256: '4'.repeat(64), sizeBytes: 9 },
  }
  const patch = (text: string) => new TextEncoder().encode(text)

  it('counts a path or an added line with the id, never a removed or unchanged one', () => {
    const diff = [
      'diff --git a/wp-content/themes/t/style.css b/wp-content/themes/t/style.css',
      '--- a/wp-content/themes/t/style.css',
      '+++ b/wp-content/themes/t/style.css',
      '@@ -1 +1,2 @@',
      ' body {}',
      '+.page-id-1000000001 h1 { color: red }',
      'diff --git a/wp-content/themes/t/page-1000000001.php b/wp-content/themes/t/page-1000000001.php',
      'new file mode 100644',
      'diff --git a/wp-content/themes/t/functions.php b/wp-content/themes/t/functions.php',
      '@@ -1,2 +1 @@',
      '-// 1000000001',
      ' <?php',
      '+$id = 10000000012;',
      '',
    ].join('\n')
    expect(createdIdFiles(patch(diff), [created])).toBe(2)
    expect(createdIdFiles(patch(diff), [])).toBe(0)
  })
})
