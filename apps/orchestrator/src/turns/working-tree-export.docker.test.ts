import { execFile, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import {
  SANDBOX_WORKDIR,
  type ExecChunk,
  type ExecHandle,
  type ExecSpec,
  type Sandbox,
} from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { untrackedFiles } from '../git-workspace/archive.ts'
import { exportSandboxWorkingTree } from './working-tree-export.ts'

// The working tree of a running turn (docs/plan/53-chat-preview-release.md, Р23) exported by the
// commands of the sandbox image itself — git, GNU tar, zstd — in a container of it. Needs Docker
// and the sandbox image (P2_SANDBOX_IMAGE of the stands, by default the runtime image of the
// gateway stand); runs with RADITI_PREVIEW_DOCKER_TESTS=1.

const enabled = process.env.RADITI_PREVIEW_DOCKER_TESTS === '1'
const IMAGE = process.env.P2_SANDBOX_IMAGE ?? 'raditi-p3verify-runtime:b13'
const run = promisify(execFile)
const name = `raditi-r5c-export-${randomBytes(4).toString('hex')}`

/** A Sandbox over `docker exec` of one container: what the exports run through. */
function dockerSandbox(container: string): Sandbox {
  return {
    id: container,
    labels: { workspaceId: 'w', siteId: 's', taskId: 't', sessionId: 'x', turn: 1 },
    async exec(spec: ExecSpec): Promise<ExecHandle> {
      const child = spawn(
        'docker',
        ['exec', '-i', ...(spec.cwd ? ['-w', spec.cwd] : []), container, ...spec.argv],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )
      void (async () => {
        if (spec.stdin) for await (const chunk of spec.stdin) child.stdin.write(chunk)
        child.stdin.end()
      })()
      const chunks: ExecChunk[] = []
      const offsets = { stdout: 0, stderr: 0 }
      const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
      for (const stream of ['stdout', 'stderr'] as const)
        child[stream].on('data', (data: Buffer) => {
          chunks.push({ stream, offset: offsets[stream], data })
          offsets[stream] += data.byteLength
        })
      return {
        id: randomUUID(),
        async *output() {
          await exited
          yield* chunks
        },
        async kill() {
          child.kill('SIGKILL')
        },
        async wait() {
          return { code: await exited, reason: 'exited' as const }
        },
      }
    },
  } as unknown as Sandbox
}

const shell = (script: string) =>
  run('docker', ['exec', '-w', SANDBOX_WORKDIR, name, 'sh', '-c', script])

describe.skipIf(!enabled)('the working tree of a turn, exported in its sandbox', () => {
  let baseSha = ''

  beforeAll(async () => {
    await run('docker', [
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--user',
      '10001:10001',
      '--network',
      'none',
      '--tmpfs',
      '/workspace:rw,uid=10001,gid=10001,mode=0755',
      '--entrypoint',
      'sleep',
      IMAGE,
      '600',
    ])
    await run('docker', ['exec', name, 'mkdir', '-p', SANDBOX_WORKDIR])
    await shell(`
      set -e
      export HOME=/tmp GIT_AUTHOR_NAME=a GIT_AUTHOR_EMAIL=a@b GIT_COMMITTER_NAME=a GIT_COMMITTER_EMAIL=a@b
      git init -q -b main .
      mkdir -p theme wp-content/uploads
      printf 'wp-content/uploads/\\n' > .gitignore
      for f in a b d f; do echo "<?php // $f" > theme/$f.php; done
      git add . && git commit -qm base
    `)
    baseSha = (await shell('git rev-parse HEAD')).stdout.trim()
    // The agent: a change, a deletion, a new file, a file taken out of the index, a new media
    // file the site's ignore file hides, and a commit of its own.
    await shell(`
      set -e
      export HOME=/tmp GIT_AUTHOR_NAME=a GIT_AUTHOR_EMAIL=a@b GIT_COMMITTER_NAME=a GIT_COMMITTER_EMAIL=a@b
      echo '<?php // changed' > theme/a.php
      git rm -q theme/b.php
      echo '<?php // new' > theme/c.php
      git rm -q --cached theme/d.php
      mkdir -p wp-content/uploads/raditi && printf 'png' > wp-content/uploads/raditi/new.png
      git commit -qam agent
    `)
  }, 120_000)
  afterAll(async () => {
    await run('docker', ['rm', '--force', name]).catch(() => {})
  })

  it('lists what differs from the base, takes back earlier paths and hidden new media', async () => {
    const tree = await exportSandboxWorkingTree(dockerSandbox(name), {
      baseSha,
      addOnlyPaths: ['wp-content/uploads/raditi/'],
      alsoPaths: ['theme/f.php', 'theme/gone.php'],
    })
    expect(tree.deletes).toEqual(['theme/b.php', 'theme/gone.php'])
    const files = await untrackedFiles(tree.archive)
    expect(files.map((file) => file.path).sort()).toEqual([
      'theme/a.php',
      'theme/c.php',
      'theme/d.php',
      'theme/f.php',
      'wp-content/uploads/raditi/new.png',
    ])
    expect(Buffer.from(files.find((file) => file.path === 'theme/a.php')!.bytes).toString()).toBe(
      '<?php // changed\n',
    )
  }, 60_000)

  it('never rewrites the index under the agent, even with files git has to look at again', async () => {
    // Stat-dirty: the same content, a new time. A refresh would rewrite .git/index under a lock.
    await shell('touch theme/a.php theme/f.php && sleep 1')
    const before = (await shell('stat -c %Y.%i .git/index')).stdout.trim()
    await exportSandboxWorkingTree(dockerSandbox(name), { baseSha })
    expect((await shell('stat -c %Y.%i .git/index')).stdout.trim()).toBe(before)
    // The copy of the index it read is gone.
    expect((await shell('ls -A /tmp')).stdout).not.toContain('raditi-export-index')
  }, 60_000)

  it('carries a link as it is, for the checks of core to refuse', async () => {
    await shell('ln -s ../../etc/passwd theme/link.php')
    const tree = await exportSandboxWorkingTree(dockerSandbox(name), { baseSha })
    await expect(untrackedFiles(tree.archive)).rejects.toMatchObject({
      code: 'TURN_OUTPUT_REJECTED',
    })
    await shell('rm theme/link.php')
  }, 60_000)

  it('refuses a base that is not a commit id and add-only paths of another shape', async () => {
    await expect(
      exportSandboxWorkingTree(dockerSandbox(name), { baseSha: 'HEAD' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      exportSandboxWorkingTree(dockerSandbox(name), { baseSha, addOnlyPaths: ['../x'] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
