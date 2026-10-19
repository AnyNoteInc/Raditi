// The agent's working set, add-only media, the repository mirror and «Обновить» on the stand's
// Gitea (docs/plan/53-chat-preview-release.md, Р10–Р12, Р27): the built GitWorkspaceService over
// HTTPS with real grants. Runs last: it moves `main` of sites/demo.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { emptyUntrackedArchive } from '../../../apps/orchestrator/dist/git-workspace/archive.js'
import { GitWorkspaceService } from '../../../apps/orchestrator/dist/git-workspace/git-workspace.service.js'

const png = (text) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(text)])

/**
 * `context`: the scenario's provider with its grant counter `count(access)`, the real provider
 * `real`, the options of GitWorkspaceModule, `git(cwd, args, { grant })` of the scenario, its
 * temporary `directory`, `serverHead(branch)`, `serverCommit(sha)`, `stage(name)`, `passed(text)`.
 */
export async function verifyWorkingSet(context) {
  const { url, repo, provider, real, count, options, git, directory, serverHead, serverCommit } =
    context
  const { stage, passed, createdAt, protectedPaths } = context
  const remote = `${url}/sites/demo.git`
  const service = new GitWorkspaceService(provider, {
    ...options,
    mirrorDir: join(directory, 'mirrors'),
  })
  const write = async (root, files) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true })
      await writeFile(join(root, path), content)
    }
  }
  const head = async (cwd, rev = 'HEAD') =>
    (await git(cwd, ['rev-parse', rev])).stdout.toString().trim()

  stage('working set: the site of the stand')
  // The site as plan 39 imports it: its core and media are in git, next to the theme.
  const seed = join(directory, 'working-set-seed')
  await git(directory, ['clone', '--quiet', remote, seed], {
    grant: await real.issueCredentials(repo, 'read', 30),
  })
  await write(seed, {
    'wp-includes/version.php': "<?php $wp_version = '7.1';\n",
    'wp-content/themes/demo/style.css': 'body { color: black; }\n',
    'wp-content/uploads/2026/photo.png': png('library'),
    'wp-content/uploads/raditi/old.png': png('old'),
  })
  await git(seed, ['add', '--all'])
  await git(seed, ['commit', '--quiet', '-m', 'fixture: a site with core and media'])
  await git(seed, ['push', '--quiet', remote, 'HEAD:refs/heads/main'], {
    grant: await real.issueCredentials(repo, 'write', 30),
  })
  const base = await head(seed)
  assert.equal(await serverHead('main'), base, 'The fixture did not reach main')

  stage('working set: the bundle from the mirror')
  const taskId = `task${randomBytes(6).toString('hex')}`
  const branch = `agent/${taskId}`
  const source = {
    repo,
    branch,
    expectedBaseSha: base,
    protectedPaths: [...protectedPaths, 'wp-content/uploads/', '**/.htaccess'],
    // As the WordPress adapter: the agent's media folder is not in the set, it only grows.
    workingSet: {
      include: ['/wp-content/themes/', '/*'],
      exclude: ['/wp-*.php', '/index.php'],
      maxBytes: 1024 * 1024,
    },
    addOnlyPaths: ['wp-content/uploads/raditi/'],
    media: {
      extensions: { png: [{ offset: 0, hex: '89504e470d0a1a0a' }] },
      refusedNameParts: ['.php', '.svg'],
      maxFileBytes: 1024 * 1024,
    },
  }
  const reads = count('read')
  const bundle = await service.buildBaseBundle(source, createdAt)
  assert.equal(count('read'), reads + 1, 'The mirror took other than one fetch with a read grant')
  assert.equal(bundle.baseSha, base)
  assert.match(bundle.sandboxBaseSha ?? '', /^[a-f0-9]{40}$/, 'The bundle has no working set')
  const again = await service.buildBaseBundle(source, createdAt)
  assert.equal(again.sandboxBaseSha, bundle.sandboxBaseSha, 'The working set is not deterministic')
  assert.equal(count('read'), reads + 1, 'A commit the mirror has was fetched again')
  assert.equal((await readdir(join(directory, 'mirrors', 'repos'))).length, 1)
  const chunks = []
  for await (const chunk of bundle.read()) chunks.push(chunk)
  const file = join(directory, `${taskId}.bundle`)
  await writeFile(file, Buffer.concat(chunks))
  const sandbox = join(directory, `${taskId}-sandbox`)
  await git(directory, ['clone', '--quiet', '--branch', 'raditi-base', file, sandbox])
  const files = (await git(sandbox, ['ls-files'])).stdout.toString().trim().split('\n')
  for (const path of ['README.md', 'wp-content/themes/demo/style.css'])
    assert.ok(files.includes(path), `The sandbox lacks ${path} of its working set`)
  for (const path of ['index.php', 'wp-config.php', 'wp-includes/version.php'])
    assert.ok(!files.includes(path), `The sandbox got ${path} outside its working set`)
  assert.deepEqual(
    files.filter((path) => path.startsWith('wp-content/uploads/')),
    [],
    'The sandbox got the media library or the media of earlier releases',
  )
  assert.equal((await git(sandbox, ['rev-list', '--count', 'HEAD'])).stdout.toString().trim(), '1')
  passed(
    'working set: one fetch fills the mirror, the bundle is the root commit of the working set',
  )

  stage('working set: publication on the full tree')
  await write(sandbox, {
    'wp-content/themes/demo/style.css': 'body { color: navy; }\n',
    'wp-content/uploads/raditi/new.png': png('new'),
  })
  await git(sandbox, ['add', '--all'])
  const diff = ['diff', '--cached', '--binary', '--full-index', '--no-renames', 'HEAD', '--']
  const input = (patch) => ({
    ...source,
    taskId,
    turn: 1,
    createdAt,
    patch,
    untracked: emptyUntrackedArchive(),
    credentials: [],
  })
  const writes = count('write')
  const candidate = await service.preparePublication(input((await git(sandbox, diff)).stdout))
  assert.equal(candidate.sandboxBaseSha, bundle.sandboxBaseSha)
  assert.equal(count('read'), reads + 1, 'Publication fetched what the mirror has')
  await candidate.publish(async () => {})
  await candidate.dispose()
  assert.equal(await serverHead(branch), candidate.headSha)
  assert.deepEqual(
    (await serverCommit(candidate.headSha)).parents.map((p) => p.sha),
    [base],
  )
  await git(seed, ['fetch', '--quiet', remote, candidate.headSha], {
    grant: await real.issueCredentials(repo, 'read', 30),
  })
  const tree = (await git(seed, ['ls-tree', '-r', '--name-only', candidate.headSha])).stdout
    .toString()
    .split('\n')
  for (const path of ['wp-includes/version.php', 'wp-content/uploads/2026/photo.png'])
    assert.ok(tree.includes(path), `The full tree lost ${path}`)
  assert.ok(tree.includes('wp-content/uploads/raditi/new.png'), 'The new media is missing')
  // The same change of the full tree, outside the working set: refused before a write grant.
  await write(seed, { 'wp-includes/version.php': "<?php $wp_version = '0';\n" })
  await git(seed, ['add', '--all'])
  const outside = (await git(seed, diff)).stdout
  await git(seed, ['reset', '--quiet', '--hard'])
  const refused = await service.preparePublication(input(outside)).then(
    () => null,
    (error) => error.code,
  )
  assert.equal(refused, 'PUBLICATION_FORBIDDEN', 'A change outside the working set was accepted')
  assert.equal(count('write'), writes + 1, 'Only the push took a write grant')
  passed('working set: its patch lands on the full tree; a change outside it is refused')

  stage('working set: «Обновить» onto a new main')
  await write(seed, { 'README.md': '# demo\n\nMoved on by the client.\n' })
  await git(seed, ['commit', '--quiet', '-am', 'fixture: main moves on'])
  await git(seed, ['push', '--quiet', remote, 'HEAD:refs/heads/main'], {
    grant: await real.issueCredentials(repo, 'write', 30),
  })
  const toBase = await head(seed)
  let fenced = 0
  const { protectedPaths: sourcePaths, workingSet, addOnlyPaths, media } = source
  const update = {
    repo,
    branch,
    fromBase: base,
    toBase,
    head: candidate.headSha,
    committedAt: createdAt,
    rules: { protectedPaths: sourcePaths, workingSet, addOnlyPaths, media },
  }
  const rebased = await service.rebaseCandidate(update, async () => void fenced++)
  assert.equal(rebased.status, 'rebased', 'The update found a conflict where there is none')
  assert.equal(fenced, 1, 'The fence was not asserted before the push')
  assert.equal(await serverHead(branch), rebased.headSha, 'The task branch did not move')
  const commit = await serverCommit(rebased.headSha)
  assert.deepEqual(
    [commit.commit.author.name, commit.parents.map((p) => p.sha)],
    ['Raditi Bot', [toBase]],
    'The update is not one bot commit on the new main',
  )
  assert.equal(await service.treeOf({ repo, sha: rebased.headSha }), rebased.treeSha)
  assert.deepEqual(
    await service.rebaseCandidate(update, async () => {}),
    rebased,
    'A repeated update differs',
  )
  assert.equal(await serverHead(branch), rebased.headSha)
  // What the dialog's candidate is made of: the change against the new main, media with bytes.
  const comparison = await service.compareCommits({
    repo,
    baseSha: toBase,
    headSha: rebased.headSha,
    addOnlyPaths,
  })
  assert.deepEqual(
    comparison.files.map((file) => [file.path, file.change]),
    [
      ['wp-content/themes/demo/style.css', 'modified'],
      ['wp-content/uploads/raditi/new.png', 'added'],
    ],
    'The candidate against the new main is not its own change',
  )
  assert.deepEqual(
    comparison.added.map((file) => [file.path, Buffer.from(file.bytes).equals(png('new'))]),
    [['wp-content/uploads/raditi/new.png', true]],
  )
  passed('«Обновить»: the candidate moves onto the new main as one bot commit, by compare-and-swap')
}
