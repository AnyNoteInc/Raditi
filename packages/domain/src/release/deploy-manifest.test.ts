import { describe, expect, it } from 'vitest'

import {
  DEPLOY_ENVELOPE_MAGIC,
  DEPLOY_WRAP_SECRET_NAME,
  DEPLOY_WRAP_TTL_SECONDS,
  deployAccessSchema,
  deployBackupAad,
  createdRecordPage,
  deployManifestSchema,
  deployMethods,
  deployStepCodes,
  deployValueAad,
  deployValueSchemas,
  deployWrapDataMatches,
  deployWrapDataSchema,
  deployWrapMatchesRun,
  formatDeployWrap,
  parseDeployWrap,
  releaseApiPaths,
  releaseBackupRequestSchema,
  releaseReportKey,
  releaseStepDetailSchema,
  releaseStepReportSchema,
} from './deploy-manifest.ts'

const releaseId = '0196abcd-0000-7000-8000-00000000000a'
const sha = 'a'.repeat(40)
const wrap = { releaseId, attempt: 2, tag: 'v1.4.0', sha, wrapToken: 'hvs.CAESIAbc_def-123' }

describe('the deploy secret', () => {
  it('reads back what it writes and refuses anything else', () => {
    expect(DEPLOY_WRAP_SECRET_NAME).toBe('RADITI_DEPLOY_WRAP')
    const text = formatDeployWrap(wrap)
    expect(text).toBe(`${releaseId}:2:v1.4.0:${sha}:hvs.CAESIAbc_def-123`)
    expect(parseDeployWrap(text)).toEqual(wrap)
    for (const broken of [
      text.replace(':2:', ':0:'),
      text.replace('v1.4.0', '1.4.0'),
      text.replace(sha, 'b'.repeat(39)),
      `${text}:extra`,
      text.replace('hvs.', 'hvs '),
      '',
    ])
      expect(parseDeployWrap(broken), broken).toBeNull()
  })

  it('matches only the run of its tag and commit', () => {
    expect(deployWrapMatchesRun(wrap, { refName: 'v1.4.0', sha })).toBe(true)
    expect(deployWrapMatchesRun(wrap, { refName: 'v0.0.0', sha })).toBe(false)
    expect(deployWrapMatchesRun(wrap, { refName: 'v1.4.0', sha: 'b'.repeat(40) })).toBe(false)
  })
})

describe('the release API', () => {
  it('names the four routes of the plan', () => {
    expect(releaseApiPaths.manifest(releaseId)).toBe(`/v1/releases/${releaseId}/manifest`)
    expect(releaseApiPaths.access(releaseId)).toBe(`/v1/releases/${releaseId}/access`)
    expect(releaseApiPaths.steps(releaseId)).toBe(`/v1/releases/${releaseId}/steps`)
    expect(releaseApiPaths.backup(releaseId)).toBe(`/v1/releases/${releaseId}/backup`)
  })

  it('takes a manifest of paths, hashes and presigned values', () => {
    const manifest = {
      v: 1,
      kind: 'release',
      releaseId,
      siteId: releaseId,
      deployAttempt: 1,
      tag: 'v1.4.0',
      installedSha: null,
      approvedSha: sha,
      method: 'sftp',
      files: {
        write: [
          {
            path: 'wp-content/themes/shop/style.css',
            before: null,
            after: 'c'.repeat(64),
            sizeBytes: 10,
            executable: false,
          },
        ],
        delete: [{ path: 'wp-content/themes/shop/old.css', before: 'd'.repeat(64) }],
      },
      db: [],
      contentEpoch: 7,
      rollbackOf: null,
      addOnlyPaths: ['wp-content/uploads/raditi/'],
      verify: {
        origin: 'https://shop.example.ru',
        failureMarkers: ['There has been a critical error'],
        pages: ['/', '/shop/'],
      },
    }
    expect(deployManifestSchema.parse(manifest)).toEqual(manifest)
    // The folders where a release only adds (Р12): none when core names none; each a folder.
    const { addOnlyPaths: _none, ...withoutFolders } = manifest
    expect(deployManifestSchema.parse(withoutFolders).addOnlyPaths).toEqual([])
    for (const folder of ['wp-content/uploads', '/abs/', '../up/'])
      expect(
        deployManifestSchema.safeParse({ ...manifest, addOnlyPaths: [folder] }).success,
        folder,
      ).toBe(false)
    // The pages are fetched at the origin of the site's address, nothing longer.
    for (const origin of ['https://shop.example.ru/', 'https://shop.example.ru/x', 'ftp://shop'])
      expect(
        deployManifestSchema.safeParse({ ...manifest, verify: { ...manifest.verify, origin } })
          .success,
        origin,
      ).toBe(false)
    expect(deployManifestSchema.safeParse({ ...manifest, contentEpoch: 0 }).success).toBe(false)
    // Where a published record the release created is checked (docs/plan/53, critique S9).
    const withPages = {
      ...manifest.verify,
      recordPages: { page: '/?page_id={id}', post: '/?p={id}' },
    }
    expect(deployManifestSchema.parse({ ...manifest, verify: withPages }).verify).toEqual(withPages)
    for (const page of ['/?page_id=', '/{id}/{id}', 'https://other.example/{id}', '/a b{id}'])
      expect(
        deployManifestSchema.safeParse({
          ...manifest,
          verify: { ...manifest.verify, recordPages: { page } },
        }).success,
        page,
      ).toBe(false)
    expect(
      deployManifestSchema.safeParse({
        ...manifest,
        verify: { ...manifest.verify, recordPages: { 'Page!': '/?p={id}' } },
      }).success,
    ).toBe(false)
    // A regular attempt may leave `rollbackOf` out.
    const { rollbackOf: _regular, ...regular } = manifest
    expect(deployManifestSchema.parse(regular).rollbackOf).toBeNull()
    expect(
      deployManifestSchema.safeParse({
        ...manifest,
        files: {
          ...manifest.files,
          delete: [{ path: '../wp-config.php', before: 'd'.repeat(64) }],
        },
      }).success,
    ).toBe(false)
    expect(deployManifestSchema.safeParse({ ...manifest, method: 'ssh' }).success).toBe(false)
    expect(deployMethods).toEqual(['rsync', 'git_ftp', 'docker', 'sftp', 'ftp'])
  })

  it('gives the hosting access as Vault keeps it, sftp or ftp', () => {
    const access = {
      v: 1,
      hosting: {
        method: 'ftp',
        access: {
          v: '1',
          host: 'ftp.example.ru',
          port: '21',
          tls: 'verified',
          rootPath: '/public_html',
          username: 'u',
          password: 'p4ssword-long',
        },
      },
      content: null,
    }
    expect(deployAccessSchema.safeParse(access).success).toBe(true)
    expect(
      deployAccessSchema.safeParse({ ...access, hosting: { ...access.hosting, method: 'sftp' } })
        .success,
    ).toBe(false)
    // The stack names the content adapter that reads the secret.
    const content = { stack: 'wordpress', access: { v: '1', origin: 'https://shop.example.ru' } }
    expect(deployAccessSchema.safeParse({ ...access, content }).success).toBe(true)
    expect(
      deployAccessSchema.safeParse({ ...access, content: { ...content, stack: 'joomla' } }).success,
    ).toBe(false)
  })

  it('wraps the attempt, a token of the release API and a 32-byte key, nothing else', () => {
    const data = {
      v: '1',
      releaseId,
      attempt: '2',
      releaseApiToken: 'a'.repeat(43),
      backupKey: `${'A'.repeat(43)}=`,
    }
    expect(deployWrapDataSchema.safeParse(data).success).toBe(true)
    for (const broken of [
      { ...data, backupKey: 'A'.repeat(44) },
      { ...data, releaseApiToken: 'a'.repeat(42) },
      { ...data, attempt: '0' },
      { ...data, extra: 'x' },
    ])
      expect(deployWrapDataSchema.safeParse(broken).success).toBe(false)
    const parsed = deployWrapDataSchema.parse(data)
    expect(deployWrapDataMatches(parsed, wrap)).toBe(true)
    expect(deployWrapDataMatches(parsed, { ...wrap, attempt: 3 })).toBe(false)
    expect(
      deployWrapDataMatches(parsed, { ...wrap, releaseId: '0196abcd-0000-7000-8000-00000000000b' }),
    ).toBe(false)
    expect(DEPLOY_WRAP_TTL_SECONDS).toBe(1800)
  })

  it('carries every kind of a plan in its one order, each value in its own shape', () => {
    const hash = (char: string) => char.repeat(64)
    const value = (key: string) => ({ key, sha256: hash('e'), sizeBytes: 40 })
    const presigned = {
      method: 'GET',
      url: 'https://core.example.ru/v1/releases/x/values/0',
      headers: {},
      expiresAt: '2026-10-18T10:00:00.000Z',
    }
    const operation = (kind: string, objectRef: string, fields: string[]) => ({
      operation: {
        kind,
        objectRef,
        fields,
        beforeHash: hash('a'),
        afterHash: hash('b'),
        before: value('a/before'),
        after: value('a/after'),
      },
      after: presigned,
    })
    const db = [
      operation('schema_migration', 'table:bookings', ['definition']),
      operation('option_update', 'option:blogname', ['value']),
      operation('post_create', 'page:1000000001', ['title', 'content', 'excerpt']),
      operation('content_update', 'page:42', ['title']),
    ]
    const manifest = {
      v: 1,
      releaseId,
      siteId: releaseId,
      deployAttempt: 1,
      tag: 'v1.4.0',
      installedSha: null,
      approvedSha: sha,
      method: 'sftp',
      files: { write: [], delete: [] },
      db,
      contentEpoch: 7,
      verify: { origin: 'https://shop.example.ru', failureMarkers: [], pages: ['/'] },
    }
    expect(deployManifestSchema.safeParse(manifest).success).toBe(true)
    // A created record of production is never a creation of a plan.
    const wrongCreation = [...db]
    wrongCreation[2] = operation('post_create', 'page:42', ['title', 'content', 'excerpt'])
    expect(deployManifestSchema.safeParse({ ...manifest, db: wrongCreation }).success).toBe(false)

    const definition = {
      columns: [{ name: 'starts_at', type: 'datetime', nullable: true }],
      indexes: [],
    }
    expect(
      deployValueSchemas.schema_migration.safeParse({
        v: 1,
        before: { exists: false, managed: false, definition: null },
        definition,
      }).success,
    ).toBe(true)
    expect(deployValueSchemas.option_update.safeParse({ v: 1, value: '10' }).success).toBe(true)
    expect(deployValueSchemas.option_update.safeParse({ v: 1, value: 'a\0b' }).success).toBe(false)
    const record = { status: 'publish', slug: 'prices', title: 'Цены', content: '', excerpt: '' }
    expect(deployValueSchemas.post_create.safeParse({ v: 1, record }).success).toBe(true)
    expect(
      deployValueSchemas.post_create.safeParse({ v: 1, record: { ...record, slug: 'Цены' } })
        .success,
    ).toBe(false)
    expect(
      deployValueSchemas.content_update.safeParse({ v: 1, fields: { title: 'Цены' } }).success,
    ).toBe(true)
    // A rollback says what it left: counts only.
    expect(releaseStepDetailSchema.safeParse({ keptRecords: 1, keptTables: 2 }).success).toBe(true)
    expect(releaseStepDetailSchema.safeParse({ keptTables: -1 }).success).toBe(false)
  })

  it('names the associated data of a backup and of a value apart', () => {
    expect(deployBackupAad(releaseId, 2)).toBe(`raditi-release-backup-v1|${releaseId}|2`)
    expect(deployBackupAad(releaseId.toUpperCase(), 2)).toBe(deployBackupAad(releaseId, 2))
    expect(deployValueAad(releaseId, 'post:42', 'f'.repeat(64))).toBe(
      `raditi-release-value-v1|${releaseId}|post:42|${'f'.repeat(64)}`,
    )
    expect(DEPLOY_ENVELOPE_MAGIC).toBe('RDE1')
    for (const code of deployStepCodes)
      expect(releaseStepDetailSchema.safeParse({ code }).success, code).toBe(true)
  })

  it('keys a report by its attempt, step and state and keeps only counts and a code', () => {
    const report = {
      reportKey: releaseReportKey(1, 'files', 'succeeded'),
      deployAttempt: 1,
      step: 'files',
      state: 'succeeded',
      detail: { files: 3, bytes: 1200 },
    }
    expect(report.reportKey).toBe('1:files:succeeded')
    expect(releaseStepReportSchema.safeParse(report).success).toBe(true)
    expect(
      releaseStepReportSchema.safeParse({ ...report, reportKey: '1:db:succeeded' }).success,
    ).toBe(false)
    expect(
      releaseStepReportSchema.safeParse({ ...report, detail: { message: 'wp-config.php: denied' } })
        .success,
    ).toBe(false)
    expect(
      releaseStepReportSchema.safeParse({ ...report, detail: { code: 'Permission denied' } })
        .success,
    ).toBe(false)
  })

  it('asks for a backup upload and its check by size and hash', () => {
    for (const phase of ['put', 'verify'])
      expect(
        releaseBackupRequestSchema.safeParse({
          phase,
          deployAttempt: 1,
          sha256: 'e'.repeat(64),
          sizeBytes: 10,
        }).success,
      ).toBe(true)
    expect(
      releaseBackupRequestSchema.safeParse({
        phase: 'get',
        deployAttempt: 1,
        sha256: 'e'.repeat(64),
        sizeBytes: 10,
      }).success,
    ).toBe(false)
  })
})

describe('the page of a created record', () => {
  const pages = { page: '/?page_id={id}', post: '/blog/?p={id}' }
  it('names the page of the type with the number production gave the record', () => {
    expect(createdRecordPage(pages, 'page:900')).toBe('/?page_id=900')
    expect(createdRecordPage(pages, 'post:12')).toBe('/blog/?p=12')
  })
  it('names none for a type without a page or a reference that is not one', () => {
    expect(createdRecordPage(pages, 'attachment:5')).toBeNull()
    expect(createdRecordPage(pages, 'page:0')).toBeNull()
    expect(createdRecordPage(pages, 'page:abc')).toBeNull()
    expect(createdRecordPage(pages, 'toString:1')).toBeNull()
    expect(createdRecordPage({}, 'page:900')).toBeNull()
  })
})
