import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { DomainError, INITIAL_SITE_TAG } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { directory, file } from '../testing/file-source.ts'
import {
  DATABASE_PASSWORD,
  FTP_PASSWORD,
  fixtureGit,
  LEAK_MARKER,
  sampleSite,
  SCANNER_ERROR_MARKER,
  siteImportFixture,
  type SiteImportFixture,
} from '../testing/site-import.ts'
import { InitialVersionGit, TAG_REF, MAIN_REF } from './initial-version.ts'

const fixtures: SiteImportFixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

async function fixture(options: Parameters<typeof siteImportFixture>[0] = {}) {
  const created = await siteImportFixture(options)
  fixtures.push(created)
  return created
}

const remoteRef = async (f: SiteImportFixture, ref: string) =>
  (await fixtureGit(f.root, 'ls-remote', '--refs', f.remote, ref)).trim().split('\t')[0] || null

/** The stage as the sweep or a requeue leaves it: queued again, the same attempt. */
const requeue = (f: SiteImportFixture) => {
  const row = f.store.stage(f.siteId)
  row.status = 'queued'
  row.enqueues += 1
}

/** git of the fixture whose push of one ref fails once, as a core killed before it. */
class Interrupted extends InitialVersionGit {
  constructor(
    f: SiteImportFixture,
    readonly target: typeof MAIN_REF | typeof TAG_REF,
  ) {
    super({
      provider: { issueCredentials: vi.fn() },
      transport: { kind: 'local-test', root: f.root },
    })
  }

  override async push(...args: Parameters<InitialVersionGit['push']>): Promise<boolean> {
    if (args[4] === this.target) throw new Error('core was killed')
    return super.push(...args)
  }
}

describe('importSite', () => {
  it('publishes the site as one root commit on main and the lightweight tag v0.0.0', async () => {
    const f = await fixture()
    const { commitSha } = await f.run()

    expect(await remoteRef(f, MAIN_REF)).toBe(commitSha)
    // Lightweight: the tag names the commit itself, there is no tag object.
    expect(await remoteRef(f, TAG_REF)).toBe(commitSha)
    expect((await fixtureGit(f.remote, 'cat-file', '-t', INITIAL_SITE_TAG)).trim()).toBe('commit')
    expect((await fixtureGit(f.remote, 'rev-list', '--count', commitSha)).trim()).toBe('1')
    const commit = await fixtureGit(f.remote, 'cat-file', 'commit', commitSha)
    expect(commit).not.toMatch(/^parent /m)
    expect(commit).toMatch(/^author Raditi Bot <bot@raditi\.ru> 1792231200 \+0000$/m)
    expect(commit).toMatch(/^committer Raditi Bot <bot@raditi\.ru> 1792231200 \+0000$/m)
    expect(commit.endsWith(`\nInitial version of the site\n\nRaditi-Site: ${f.siteId}\n`)).toBe(
      true,
    )

    // Core and media are in it, wp-config.php is not; every file is 100644.
    const tree = await fixtureGit(f.remote, 'ls-tree', '-r', commitSha)
    expect(
      tree
        .trim()
        .split('\n')
        .map((line) => line.replace(/ [0-9a-f]{40}/, '')),
    ).toEqual([
      '100644 blob\tindex.php',
      '100644 blob\twp-content/themes/site/style.css',
      '100644 blob\twp-content/uploads/logo.png',
      '100644 blob\twp-includes/version.php',
    ])
    expect(
      Buffer.from(await execBuffer(f.remote, `${commitSha}:wp-content/uploads/logo.png`)).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]),
      ),
    ).toBe(true)

    const row = f.store.stage(f.siteId)
    expect(row.step).toBe('publish')
    expect(row.summary).toEqual({ files: 4, bytes: expect.any(Number), skipped: { excluded: 1 } })
    expect(f.store.plans.get(f.siteId)).toMatchObject({ commitSha, files: 4, importedAt: null })
    expect([...f.store.repositories.values()]).toEqual([
      expect.objectContaining({
        provider: 'gitea',
        owner: 'sites',
        name: `site-${f.siteId}`,
        url: `https://gitea.raditi.test/sites/site-${f.siteId}`,
      }),
    ])
    // The private directory of the run is gone: the scanner ran in one of its folders.
    const scan = JSON.parse((await readFile(f.scannerLog, 'utf8')).trim().split('\n')[0]!) as {
      cwd: string
      args: string[]
    }
    await expect(access(dirname(scan.cwd))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(scan.args).toEqual(
      expect.arrayContaining([
        '--ignore-gitleaks-allow',
        '--redact=100',
        '--report-format',
        'json',
      ]),
    )
  })

  it('leaves out the files with a secret of the access or a scanner finding', async () => {
    const tree = sampleSite()
    tree['backup.php'] = file(`<?php $ftp = '${FTP_PASSWORD}';\n`)
    tree['keys.php'] = file(`<?php // ${LEAK_MARKER}\n`)
    // A value of wp-config.php found elsewhere is left out as well.
    tree['old.php'] = file(`<?php $db = 'synthetic-db-password';\n`)
    const f = await fixture({ tree })
    const { commitSha } = await f.run()

    const paths = (await fixtureGit(f.remote, 'ls-tree', '-r', '--name-only', commitSha))
      .trim()
      .split('\n')
    expect(paths).not.toContain('backup.php')
    expect(paths).not.toContain('keys.php')
    expect(paths).not.toContain('old.php')
    expect(f.store.stage(f.siteId).summary).toMatchObject({ skipped: { excluded: 1, secret: 3 } })
  })

  it('fails scan_failed when the scanner cannot finish', async () => {
    const tree = sampleSite()
    tree['odd.php'] = file(SCANNER_ERROR_MARKER)
    const f = await fixture({ tree })
    await expect(f.run()).rejects.toMatchObject({ code: 'scan_failed' })
    expect(await remoteRef(f, MAIN_REF)).toBeNull()
  })

  it('fails source_empty when nothing is left to import', async () => {
    const f = await fixture({ tree: { 'wp-config.php': file('<?php\n'), error_log: file('x') } })
    await expect(f.run()).rejects.toMatchObject({ code: 'source_empty' })
  })

  it.each([
    ['no git', (f: SiteImportFixture) => (f.deps.git = null)],
    ['no provisioner', (f: SiteImportFixture) => (f.deps.provisioner = null)],
    ['no gitleaks', (f: SiteImportFixture) => (f.deps.gitleaksBinary = join(f.root, 'missing'))],
  ])('refuses repository_not_configured with %s, before any download', async (_, change) => {
    const f = await fixture()
    change(f)
    await expect(f.run()).rejects.toMatchObject({ code: 'repository_not_configured' })
    expect(f.opened()).toBe(0)
  })

  it.each([
    ['access_missing', (f: SiteImportFixture) => (f.secret = null)],
    // Vault no longer keeps the version the reference names.
    ['access_missing', (f: SiteImportFixture) => (f.secret = { ...f.secret!, version: 3 })],
    [
      'access_mismatch',
      (f: SiteImportFixture) => (f.store.access.get(f.siteId)!.reference!.keyVersion = 0),
    ],
    [
      'access_mismatch',
      (f: SiteImportFixture) =>
        (f.secret = { ...f.secret!, data: { ...f.secret!.data, rootPath: '/other' } }),
    ],
    [
      'access_mismatch',
      (f: SiteImportFixture) =>
        (f.secret = { ...f.secret!, data: { ...f.secret!.data, extra: 'x' } }),
    ],
    [
      'access_mismatch',
      (f: SiteImportFixture) =>
        (f.store.access.get(f.siteId)!.reference!.vaultPath = 'kv/sites/other/ftp'),
    ],
    [
      'access_mismatch',
      (f: SiteImportFixture) => (f.store.access.get(f.siteId)!.reference!.kind = 'ssh'),
    ],
    ['access_missing', (f: SiteImportFixture) => (f.store.access.get(f.siteId)!.source = null)],
    ['access_refused', (f: SiteImportFixture) => (f.store.stage(f.siteId).siteStatus = 'archived')],
    ['address_not_allowed', (f: SiteImportFixture) => (f.deps.appEnv = 'production')],
  ])('fails %s before it connects', async (code, change) => {
    const f = await fixture()
    // After the claim: a site that stopped being connected meanwhile is the reader's refusal.
    await expect(f.run({ afterClaim: () => change(f) })).rejects.toMatchObject({
      code,
      transient: false,
    })
    expect(f.opened()).toBe(0)
  })

  it('reads the version the reference names: a newer one a failed request left does not count', async () => {
    const f = await fixture()
    // «Изменить доступ» wrote version 3 and then failed to move the reference: still version 2.
    f.vault.set(`kv/sites/${f.siteId}/ftp`, [
      { version: 3, data: { ...f.secret!.data, rootPath: '/other' } },
    ])
    const { commitSha } = await f.run()
    expect(await remoteRef(f, MAIN_REF)).toBe(commitSha)
    expect(f.deps.secrets.kvRead).toHaveBeenCalledWith(`kv/sites/${f.siteId}/ftp`, { version: 2 })
  })

  it('leaves out a file with the password of the site database, wp-config.php above the root', async () => {
    const tree = sampleSite()
    // A hardened layout: wp-config.php one folder above, so its values are not read.
    delete tree['wp-config.php']
    tree['backup.php'] = file(`<?php $db = '${DATABASE_PASSWORD}';\n`)
    const f = await fixture({ tree })
    f.addDatabase()
    const { commitSha } = await f.run()

    const paths = await fixtureGit(f.remote, 'ls-tree', '-r', '--name-only', commitSha)
    expect(paths.split('\n')).not.toContain('backup.php')
    expect(f.store.stage(f.siteId).summary).toMatchObject({ skipped: { secret: 1 } })
    expect(f.deps.secrets.kvRead).toHaveBeenCalledWith(`kv/sites/${f.siteId}/db`, { version: 1 })
  })

  it.each([
    ['access_missing', (f: SiteImportFixture) => f.vault.delete(`kv/sites/${f.siteId}/db`)],
    [
      'access_missing',
      (f: SiteImportFixture) => (f.store.access.get(f.siteId)!.database!.reference = null),
    ],
    [
      'access_missing',
      (f: SiteImportFixture) => (f.store.access.get(f.siteId)!.database!.reference!.keyVersion = 2),
    ],
    [
      'access_mismatch',
      (f: SiteImportFixture) => (f.store.access.get(f.siteId)!.database!.row.host = '127.0.0.2'),
    ],
    [
      'access_mismatch',
      (f: SiteImportFixture) => (f.store.access.get(f.siteId)!.database!.reference!.kind = 'ftp'),
    ],
    [
      'access_mismatch',
      (f: SiteImportFixture) =>
        (f.store.access.get(f.siteId)!.database!.reference!.vaultPath = `kv/sites/${f.siteId}/ftp`),
    ],
    [
      'access_mismatch',
      (f: SiteImportFixture) => {
        const [stored] = f.vault.get(`kv/sites/${f.siteId}/db`)!
        stored!.data = { ...stored!.data, extra: 'x' }
      },
    ],
  ])('fails %s for the database access of the site, before it connects', async (code, change) => {
    const f = await fixture()
    f.addDatabase()
    change(f)
    await expect(f.run()).rejects.toMatchObject({ code, transient: false })
    expect(f.opened()).toBe(0)
  })

  it('counts a folder and a file the server refuses to open, and imports the rest', async () => {
    const tree = sampleSite()
    tree['private'] = directory({ 'a.php': file('x') }, { fails: 'access_denied' })
    tree['locked.php'] = file('x', { fails: 'access_denied' })
    tree['gone.php'] = file('x', { fails: 'not_found' })
    const f = await fixture({ tree })
    const { commitSha } = await f.run()
    const paths = (await fixtureGit(f.remote, 'ls-tree', '-r', '--name-only', commitSha)).split(
      '\n',
    )
    expect(paths).toContain('index.php')
    expect(paths).not.toContain('locked.php')
    expect(f.store.stage(f.siteId).summary).toMatchObject({ skipped: { unreadable: 3 } })
  })

  it('does not stall while a slow listing is still coming in', async () => {
    const tree = sampleSite()
    // Six windows of the stall rule pass while one folder is listed, with no byte meanwhile.
    tree['wp-includes'] = directory(
      { 'version.php': file('<?php $wp_version = "6.8";\n') },
      { listDelayMs: 150 },
    )
    const f = await fixture({ tree })
    f.deps.stall = { windowMs: 25, bytes: 1 }
    const { commitSha } = await f.run()
    expect(await remoteRef(f, MAIN_REF)).toBe(commitSha)
  })

  it('still stalls a walk that does nothing outside a listing', async () => {
    const tree = sampleSite()
    tree['slow.php'] = file('x'.repeat(14), { delayMs: 150 })
    const f = await fixture({ tree })
    f.deps.stall = { windowMs: 25, bytes: 1 }
    await expect(f.run()).rejects.toMatchObject({ code: 'transfer_failed', transient: true })
  })

  it('makes a refusal of Gitea final and Gitea away a hiccup', async () => {
    const f = await fixture()
    f.provisioner.ensureRepository.mockRejectedValueOnce(
      new DomainError('GIT_PROVIDER_FAILED', 'refused', 502, { reason: 'forbidden' }),
    )
    await expect(f.run()).rejects.toMatchObject({
      code: 'repository_not_created',
      transient: false,
    })
    requeue(f)
    f.provisioner.ensureRepository.mockRejectedValueOnce(
      new DomainError('GIT_PROVIDER_FAILED', 'Gitea request failed', 502),
    )
    await expect(f.run()).rejects.toMatchObject({ code: 'repository_not_created', transient: true })
  })

  it('refuses a repository address outside the transport', async () => {
    const f = await fixture()
    f.provisioner.ensureRepository.mockResolvedValueOnce({
      ref: { provider: 'gitea', owner: 'sites', name: `site-${f.siteId}` },
      defaultBranch: 'main',
      cloneUrl: '/tmp',
      private: true,
    })
    await expect(f.run()).rejects.toMatchObject({ code: 'repository_not_configured' })
  })

  describe('recovery', () => {
    it('after the repository was created: builds the commit, never a second repository', async () => {
      const f = await fixture()
      f.tree['broken.php'] = file('x', { fails: 'transfer_failed' })
      await expect(f.run()).rejects.toMatchObject({ code: 'transfer_failed', transient: true })
      delete f.tree['broken.php']
      requeue(f)
      const { commitSha } = await f.run()
      expect(await remoteRef(f, MAIN_REF)).toBe(commitSha)
      expect(f.provisioner.ensureRepository).toHaveBeenCalledTimes(2)
      expect(f.store.repositories.size).toBe(1)
    })

    it('after the plan, before main landed: replaces the plan and publishes it', async () => {
      const f = await fixture()
      const versions = f.deps.git!.versions
      f.deps.git!.versions = new Interrupted(f, MAIN_REF)
      await expect(f.run()).rejects.toThrow()
      const first = f.store.plans.get(f.siteId)!.commitSha
      expect(await remoteRef(f, MAIN_REF)).toBeNull()
      f.deps.git!.versions = versions
      f.deps.now = () => new Date('2026-10-17T11:00:00Z')
      requeue(f)
      const { commitSha } = await f.run()
      expect(commitSha).not.toBe(first)
      expect(f.store.plans.get(f.siteId)!.commitSha).toBe(commitSha)
      expect(await remoteRef(f, MAIN_REF)).toBe(commitSha)
      expect(await remoteRef(f, TAG_REF)).toBe(commitSha)
    })

    it('between main and the tag: no second download, the recorded commit gets its tag', async () => {
      const f = await fixture()
      const versions = f.deps.git!.versions
      f.deps.git!.versions = new Interrupted(f, TAG_REF)
      await expect(f.run()).rejects.toThrow()
      const recorded = f.store.plans.get(f.siteId)!.commitSha
      expect(await remoteRef(f, MAIN_REF)).toBe(recorded)
      expect(await remoteRef(f, TAG_REF)).toBeNull()
      expect(f.opened()).toBe(1)

      f.deps.git!.versions = versions
      // Its address would be refused now: a run that only finishes the tag never dials it.
      f.deps.appEnv = 'production'
      requeue(f)
      const { commitSha } = await f.run()
      expect(commitSha).toBe(recorded)
      expect(f.opened()).toBe(1)
      expect(await remoteRef(f, TAG_REF)).toBe(recorded)
      expect((await fixtureGit(f.remote, 'rev-list', '--all', '--count')).trim()).toBe('1')
    })

    it('after the tag, before the database: only the check is left', async () => {
      const f = await fixture()
      const first = await f.run()
      requeue(f)
      const again = await f.run()
      expect(again.commitSha).toBe(first.commitSha)
      expect(f.opened()).toBe(1)
      expect((await fixtureGit(f.remote, 'rev-list', '--all', '--count')).trim()).toBe('1')
    })
  })

  describe('a push of main that outlived its run', () => {
    /**
     * git of a run whose push of `main` outlives it: the push is kept aside and the run fails as
     * a deadline would have it. `land()` makes the push arrive at the remote later.
     */
    class Outliving extends InitialVersionGit {
      #side = ''
      sha = ''

      constructor(readonly f: SiteImportFixture) {
        super({
          provider: { issueCredentials: vi.fn() },
          transport: { kind: 'local-test', root: f.root },
        })
      }

      override async push(...args: Parameters<InitialVersionGit['push']>): Promise<boolean> {
        const [root, , , sha, target] = args
        if (target !== MAIN_REF) return super.push(...args)
        this.#side = join(this.f.root, 'side.git')
        await fixtureGit(this.f.root, 'init', '--quiet', '--bare', this.#side)
        await fixtureGit(
          join(root, 'repo'),
          'push',
          '--quiet',
          this.#side,
          `${sha}:refs/heads/late`,
        )
        this.sha = sha
        throw new Error('the run was given up while git pushed')
      }

      async land(): Promise<void> {
        await fixtureGit(
          this.#side,
          'push',
          '--quiet',
          this.f.remote,
          `refs/heads/late:${MAIN_REF}`,
        )
      }
    }

    it('lands during the walk of the next run: that run takes the plan over and tags it', async () => {
      const f = await fixture()
      const versions = f.deps.git!.versions
      const outliving = new Outliving(f)
      f.deps.git!.versions = outliving
      await expect(f.run()).rejects.toThrow()
      expect(f.store.plans.get(f.siteId)!.commitSha).toBe(outliving.sha)
      expect(await remoteRef(f, MAIN_REF)).toBeNull()

      f.deps.git!.versions = versions
      // Another commit time: this run's own commit would be another one.
      f.deps.now = () => new Date('2026-10-17T11:00:00Z')
      const adapter = f.deps.sources('ftp') as { open: (...args: never[]) => Promise<unknown> }
      const open = adapter.open
      adapter.open = async (...args: never[]) => {
        await outliving.land()
        return open(...args)
      }
      requeue(f)
      const { commitSha } = await f.run()

      expect(commitSha).toBe(outliving.sha)
      expect(await remoteRef(f, MAIN_REF)).toBe(outliving.sha)
      expect(await remoteRef(f, TAG_REF)).toBe(outliving.sha)
      expect((await fixtureGit(f.remote, 'rev-list', '--all', '--count')).trim()).toBe('1')
      expect(f.store.plans.get(f.siteId)).toMatchObject({
        commitSha: outliving.sha,
        files: 4,
        leaseEpoch: 2,
      })
    })

    it('lands just before the push of the next run: the refused push takes the plan over', async () => {
      const f = await fixture()
      const outliving = new Outliving(f)
      f.deps.git!.versions = outliving
      await expect(f.run()).rejects.toThrow()

      // The next run's own push of main: the earlier one arrives right before it.
      class Late extends InitialVersionGit {
        override async push(...args: Parameters<InitialVersionGit['push']>): Promise<boolean> {
          if (args[4] === MAIN_REF) await outliving.land()
          return super.push(...args)
        }
      }
      f.deps.git!.versions = new Late({
        provider: { issueCredentials: vi.fn() },
        transport: { kind: 'local-test', root: f.root },
      })
      f.deps.now = () => new Date('2026-10-17T11:00:00Z')
      requeue(f)
      const { commitSha } = await f.run()

      expect(commitSha).toBe(outliving.sha)
      expect(await remoteRef(f, TAG_REF)).toBe(outliving.sha)
      expect(f.store.plans.get(f.siteId)!.commitSha).toBe(outliving.sha)
      // The next run finds both refs at the plan and only checks.
      requeue(f)
      expect((await f.run()).commitSha).toBe(outliving.sha)
    })
  })

  describe('repository_mismatch, never forced', () => {
    it('main of another commit without a plan', async () => {
      const f = await fixture()
      await f.provisioner.ensureRepository(`site-${f.siteId}`)
      await pushForeign(f, MAIN_REF)
      await expect(f.run()).rejects.toMatchObject({ code: 'repository_mismatch' })
      expect(f.opened()).toBe(0)
    })

    it('a tag without main', async () => {
      const f = await fixture()
      await f.provisioner.ensureRepository(`site-${f.siteId}`)
      await pushForeign(f, TAG_REF)
      await expect(f.run()).rejects.toMatchObject({ code: 'repository_mismatch' })
    })

    it('main at the plan and the tag at another commit', async () => {
      const f = await fixture()
      const versions = f.deps.git!.versions
      f.deps.git!.versions = new Interrupted(f, TAG_REF)
      await expect(f.run()).rejects.toThrow()
      const foreign = await pushForeign(f, TAG_REF)
      f.deps.git!.versions = versions
      requeue(f)
      await expect(f.run()).rejects.toMatchObject({ code: 'repository_mismatch' })
      expect(await remoteRef(f, TAG_REF)).toBe(foreign)
    })

    it('main that appeared while the import built its own commit', async () => {
      const f = await fixture()
      // The walk of this run pushes a foreign main before the import pushes its own.
      const tree = sampleSite()
      f.tree = tree
      tree['wp-includes'] = directory({ 'version.php': file('<?php // 6.8\n') })
      const open = f.deps.sources('ftp')
      const original = (open as { open: (...args: never[]) => unknown }).open
      ;(open as { open: unknown }).open = async (...args: never[]) => {
        await pushForeign(f, MAIN_REF)
        return original(...args)
      }
      await expect(f.run()).rejects.toMatchObject({ code: 'repository_mismatch' })
    })
  })
})

function execBuffer(cwd: string, object: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    execFile('git', ['cat-file', 'blob', object], { cwd, encoding: 'buffer' }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  )
}

/** A commit someone else pushed to the repository of the site. */
async function pushForeign(f: SiteImportFixture, ref: string): Promise<string> {
  const work = join(f.root, `foreign-${Math.random().toString(36).slice(2)}`)
  await fixtureGit(f.root, 'init', '--quiet', '--initial-branch=main', work)
  await fixtureGit(work, 'commit', '--quiet', '--allow-empty', '-m', 'foreign')
  const sha = (await fixtureGit(work, 'rev-parse', 'HEAD')).trim()
  await fixtureGit(work, 'push', '--quiet', '--force', f.remote, `HEAD:${ref}`)
  return sha
}
