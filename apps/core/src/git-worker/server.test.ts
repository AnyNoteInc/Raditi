import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { GitWorkerClient } from '../git-workspace/worker-client.ts'
import { startGitWorker, type GitWorkerOptions, type GitWorkerServer } from './server.ts'

const roots: string[] = []
const servers: GitWorkerServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function worker(options: Partial<GitWorkerOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'raditi-git-worker-'))
  roots.push(root)
  await mkdir(join(root, 'ops'))
  const server = await startGitWorker({
    root,
    allowLoopback: false,
    refusedSubnets: [],
    allowFileProtocol: false,
    ...options,
  })
  servers.push(server)
  return { root, client: new GitWorkerClient(server.socket), socket: server.socket }
}

describe('git worker', () => {
  it('runs git with its own options in a directory of the volume', async () => {
    const { root, client, socket } = await worker()
    expect(((await stat(socket)).mode & 0o777).toString(8)).toBe('660')
    const result = await client.run({
      tool: 'git',
      args: ['config', '--get', 'core.hooksPath'],
      cwd: join(root, 'ops'),
      protocol: 'none',
    })
    expect(result.code).toBe(0)
    expect(result.stdout.toString().trim()).toBe('/dev/null')
  })

  it('refuses a directory outside the volume', async () => {
    const { client } = await worker()
    await expect(
      client.run({ tool: 'git', args: ['version'], cwd: tmpdir(), protocol: 'none' }),
    ).rejects.toMatchObject({ code: 'GIT_WORKER_REFUSED' })
    const { root, client: other } = await worker()
    await expect(
      other.run({
        tool: 'git',
        args: ['version'],
        cwd: join(root, 'ops'),
        protocol: 'none',
        env: { GIT_DIR: '/etc' },
      }),
    ).rejects.toMatchObject({ code: 'GIT_WORKER_REFUSED' })
  })

  it('refuses file remotes unless it runs a test, and https without a public pinned address', async () => {
    const { root, client } = await worker()
    const cwd = join(root, 'ops')
    await expect(
      client.run({ tool: 'git', args: ['version'], cwd, protocol: 'file' }),
    ).rejects.toMatchObject({
      code: 'GIT_WORKER_REFUSED',
    })
    for (const pin of [
      undefined,
      { host: 'gitlab.example.ru', address: '10.0.0.1' },
      { host: 'gitlab.example.ru', address: '127.0.0.1' },
      { host: 'gitlab.example.ru', address: 'gitlab.example.ru' },
    ])
      await expect(
        client.run({
          tool: 'git',
          args: ['version'],
          cwd,
          protocol: 'https',
          ...(pin ? { pin } : {}),
        }),
      ).rejects.toMatchObject({ code: 'GIT_WORKER_REFUSED' })
    const pinned = await client.run({
      tool: 'git',
      args: ['version'],
      cwd,
      protocol: 'https',
      pin: { host: 'gitlab.example.ru', address: '93.184.216.34' },
    })
    expect(pinned.code).toBe(0)
  })

  it('pins loopback only for the fakes of a stand (GIT_ALLOW_LOOPBACK)', async () => {
    const { root, client } = await worker({ allowLoopback: true })
    const result = await client.run({
      tool: 'git',
      args: ['version'],
      cwd: join(root, 'ops'),
      protocol: 'https',
      pin: { host: 'localhost', address: '127.0.0.1' },
    })
    expect(result.code).toBe(0)
  })

  it('refuses an environment variable it does not know and runs no other tool', async () => {
    const { root, client } = await worker()
    const cwd = join(root, 'ops')
    await expect(
      client.run({
        tool: 'git',
        args: ['version'],
        cwd,
        protocol: 'none',
        env: { GIT_SSL_NO_VERIFY: '1' } as never,
      }),
    ).rejects.toMatchObject({ code: 'GIT_WORKER_REFUSED' })
    await expect(
      client.run({ tool: 'sh' as never, args: ['-c', 'id'], cwd, protocol: 'none' }),
    ).rejects.toMatchObject({ code: 'GIT_WORKER_REFUSED' })
  })
})
