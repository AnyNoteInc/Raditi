import { describe, expect, it } from 'vitest'

import {
  agentWorkingSetSchema,
  candidateCheckKinds,
  candidateCheckStatuses,
  candidateCounts,
  candidateFilesSchema,
  candidateMediaSchema,
  candidateRefusalsOf,
  candidateStatuses,
  canCandidateTransition,
  candidateLimits,
  candidatePatchKey,
  candidateFactsSchema,
  candidateVersionFacts,
  isEmptyCandidate,
  jsonbTextBytes,
  mediaRulesSchema,
} from './candidate.ts'
import { proposeBump } from './semver.ts'

const tree = (c: string) => c.repeat(40)

describe('candidates', () => {
  it('lists the statuses and checks of the plan', () => {
    expect(candidateStatuses).toEqual(['current', 'superseded', 'stale', 'released'])
    expect(candidateCheckStatuses).toEqual(['pending', 'passed', 'failed', 'stale'])
    expect(candidateCheckKinds).toEqual(['php_lint', 'preview_smoke', 'agent_browser'])
  })

  it('supersedes, goes stale or is released; never comes back', () => {
    expect(canCandidateTransition('current', 'superseded')).toBe(true)
    expect(canCandidateTransition('current', 'stale')).toBe(true)
    expect(canCandidateTransition('current', 'released')).toBe(true)
    expect(canCandidateTransition('stale', 'superseded')).toBe(true)
    expect(canCandidateTransition('stale', 'current')).toBe(false)
    expect(canCandidateTransition('released', 'current')).toBe(false)
    expect(canCandidateTransition('superseded', 'current')).toBe(false)
  })

  it('counts «nothing changed» from the start: the same tree and no records', () => {
    expect(isEmptyCandidate({ headTree: tree('a'), baseTree: tree('a'), plan: [] })).toBe(true)
    expect(isEmptyCandidate({ headTree: tree('b'), baseTree: tree('a'), plan: [] })).toBe(false)
  })

  it('takes files and media of the site tree only', () => {
    const files = [
      {
        path: 'wp-content/themes/shop/style.css',
        change: 'modified',
        sizeBytes: 10,
        executable: false,
      },
      { path: 'wp-content/themes/shop/new.php', change: 'added', sizeBytes: 5, executable: false },
      {
        path: 'wp-content/themes/shop/old.php',
        change: 'deleted',
        sizeBytes: 0,
        executable: false,
      },
    ]
    expect(candidateFilesSchema.parse(files)).toEqual(files)
    expect(candidateFilesSchema.safeParse([{ ...files[0], path: '/etc/passwd' }]).success).toBe(
      false,
    )
    const media = [
      {
        path: 'wp-content/uploads/raditi/a.webp',
        contentType: 'image/webp',
        sizeBytes: 100,
        sha256: 'e'.repeat(64),
      },
    ]
    expect(candidateMediaSchema.parse(media)).toEqual(media)
    expect(
      candidateMediaSchema.safeParse([{ ...media[0], sizeBytes: 9 * 1024 * 1024 }]).success,
    ).toBe(false)
    expect(candidateCounts(candidateFilesSchema.parse(files), media, [])).toEqual({
      addedFiles: 1,
      modifiedFiles: 1,
      deletedFiles: 1,
      mediaFiles: 1,
      dbObjects: 0,
      dbSettings: 0,
      dbCreated: 0,
      dbTables: 0,
    })
  })

  it('counts an added medium as a new file when it proposes a number', () => {
    const facts = {
      changeType: 'code' as const,
      risk: 'low' as const,
      addedFiles: 0,
      modifiedFiles: 2,
      deletedFiles: 0,
      mediaFiles: 1,
      dbObjects: 0,
      newFunctionality: false,
    }
    expect(candidateVersionFacts(facts)).toEqual({
      changeType: 'code',
      risk: 'low',
      addedFiles: 1,
      deletedFiles: 0,
      newFunctionality: false,
      newTables: 0,
    })
    expect(proposeBump(candidateVersionFacts(facts))).toBe('minor')
    expect(proposeBump(candidateVersionFacts({ ...facts, mediaFiles: 0 }))).toBe('patch')
  })

  it('keeps the diff of a candidate under one key, whatever case its id came in', () => {
    const taskId = '0192F3A4-5B6C-7D8E-9F01-23456789ABCD'
    expect(candidatePatchKey(taskId, 3)).toBe(
      'candidates/0192f3a4-5b6c-7d8e-9f01-23456789abcd/3/patch.diff',
    )
    expect(candidatePatchKey(taskId.toLowerCase(), 3)).toBe(candidatePatchKey(taskId, 3))
  })
})

describe('what the CHECK of task_candidates measures', () => {
  it('counts the bytes of jsonb text: a space after every colon and comma', () => {
    // SELECT '[{"a": 1, "b": "й"}, {"c": [], "d": {}}]'::jsonb::text
    expect(
      jsonbTextBytes([
        { a: 1, b: 'й' },
        { c: [], d: {} },
      ]),
    ).toBe(new TextEncoder().encode('[{"a": 1, "b": "й"}, {"c": [], "d": {}}]').byteLength)
    expect(jsonbTextBytes([])).toBe(2)
    expect(jsonbTextBytes({ a: undefined, b: null })).toBe('{"b": null}'.length)
  })

  it('refuses a list of files the database would refuse, within the count it allows', () => {
    const file = (index: number) => ({
      path: `wp-content/themes/shop/${String(index).padStart(5, '0')}-${'x'.repeat(900)}.php`,
      change: 'added' as const,
      sizeBytes: 1,
      executable: false,
    })
    const many = Array.from({ length: 5_000 }, (_, index) => file(index))
    expect(many.length).toBeLessThan(candidateLimits.files)
    expect(jsonbTextBytes(many)).toBeGreaterThan(candidateLimits.filesJsonBytes)
    expect(candidateFilesSchema.safeParse(many).success).toBe(false)
    expect(candidateFilesSchema.safeParse(many.slice(0, 4_000)).success).toBe(true)
    const media = Array.from({ length: 1_000 }, (_, index) => ({
      path: `wp-content/uploads/raditi/${index}-${'m'.repeat(1_000)}.webp`,
      contentType: 'image/webp',
      sizeBytes: 1,
      sha256: 'e'.repeat(64),
    }))
    expect(candidateMediaSchema.safeParse(media).success).toBe(false)
  })
})

describe('may it be released (Р27)', () => {
  const ready = {
    status: 'current' as const,
    revision: 3,
    confirmedRevision: 3,
    checks: [{ status: 'passed' as const }, { status: 'pending' as const }],
    baseTree: tree('a'),
    mainTree: tree('a'),
    releaseInProgress: false,
  }

  it('is ready when current, the same revision, no failed check, its base is main and nothing runs', () => {
    expect(candidateRefusalsOf(ready)).toEqual([])
  })

  it('names every reason it is not', () => {
    expect(
      candidateRefusalsOf({
        ...ready,
        status: 'stale',
        confirmedRevision: 2,
        checks: [{ status: 'failed' }],
        mainTree: tree('b'),
        releaseInProgress: true,
      }),
    ).toEqual([
      'not_current',
      'revision_changed',
      'checks_failed',
      'base_outdated',
      'release_in_progress',
    ])
  })
})

describe('what a stack says about the agent’s tree and media', () => {
  it('takes patterns and a size limit for the working set', () => {
    expect(
      agentWorkingSetSchema.safeParse({
        include: ['/wp-content/themes/', '/wp-content/plugins/'],
        exclude: ['/wp-content/plugins/raditi-content/'],
        maxBytes: 64 * 1024 * 1024,
      }).success,
    ).toBe(true)
    expect(agentWorkingSetSchema.safeParse({ include: [], exclude: [], maxBytes: 1 }).success).toBe(
      false,
    )
  })

  it('takes directories to add media to, extensions with signatures and a file limit', () => {
    const rules = {
      addOnlyPaths: ['wp-content/uploads/raditi/'],
      extensions: {
        png: [{ offset: 0, hex: '89504e470d0a1a0a' }],
        pdf: [{ offset: 0, hex: '25504446' }],
      },
      refusedNameParts: ['.php', '.phar', '.htaccess'],
      maxFileBytes: 8 * 1024 * 1024,
    }
    expect(mediaRulesSchema.parse(rules)).toEqual(rules)
    expect(
      mediaRulesSchema.safeParse({ ...rules, addOnlyPaths: ['wp-content/uploads/raditi'] }).success,
    ).toBe(false)
    expect(mediaRulesSchema.safeParse({ ...rules, extensions: { svg: [] } }).success).toBe(false)
    expect(mediaRulesSchema.safeParse({ ...rules, maxFileBytes: 9 * 1024 * 1024 }).success).toBe(
      false,
    )
  })
})

describe('the kinds of a database plan in the facts of a candidate', () => {
  it('reads facts recorded before the kinds, and makes a table a new feature', () => {
    const facts = candidateFactsSchema.parse({
      changeType: 'content',
      risk: 'low',
      addedFiles: 0,
      modifiedFiles: 0,
      deletedFiles: 0,
      mediaFiles: 0,
      dbObjects: 1,
      newFunctionality: false,
    })
    expect(facts).toMatchObject({ dbSettings: 0, dbCreated: 0, dbTables: 0, createdIdFiles: 0 })
    expect(proposeBump(candidateVersionFacts(facts))).toBe('patch')
    // A table of the platform is a minor release, whatever the agent calls the change.
    expect(candidateVersionFacts({ ...facts, dbTables: 1 }).newTables).toBe(1)
    expect(proposeBump(candidateVersionFacts({ ...facts, dbTables: 1 }))).toBe('minor')
  })
})
