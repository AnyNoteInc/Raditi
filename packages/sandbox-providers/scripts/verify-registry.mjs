// Local synthetic fixture only: no existing accounts, credentials or package names are used.
import process from 'node:process'
import console from 'node:console'
import { URL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Docker from 'dockerode'

const cli = promisify(execFile)
const [source, containerId, origin = 'http://127.0.0.1:3300'] = process.argv.slice(2)
if (
  !source ||
  !/^[a-f0-9]{12,64}$/.test(containerId ?? '') ||
  !/^http:\/\/(?:localhost|127\.0\.0\.1):[0-9]+$/.test(origin)
)
  throw new Error(
    'Usage: verify-registry.mjs <existing-image> <fixture-gitea-container-id> [local-origin]',
  )
const user = `raditi-p2-${randomBytes(6).toString('hex')}`
const repository = `${new URL(origin).host}/${user}/runtime-proof`
const tag = `${repository}:verification`
const docker = new Docker({
  socketPath: process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock',
})
let token = ''
let created = false
let tagged = false
let pinned
let step = 'create synthetic user'
let success = false
const progress = (stream) =>
  new Promise((resolve, reject) =>
    docker.modem.followProgress(stream, (error, output) =>
      error ? reject(error) : resolve(output),
    ),
  )
const api = async (path, method = 'GET') => {
  const response = await globalThis.fetch(`${origin}/api/v1${path}`, {
    method,
    headers: { authorization: `token ${token}` },
    signal: globalThis.AbortSignal.timeout(15000),
  })
  if (!response.ok && response.status !== 404) throw new Error('Synthetic package cleanup failed')
  return response
}
try {
  await cli(
    'docker',
    [
      'exec',
      containerId,
      'gitea',
      'admin',
      'user',
      'create',
      '--username',
      user,
      '--email',
      `${user}@example.invalid`,
      '--random-password',
      '--must-change-password=false',
    ],
    { maxBuffer: 1024 * 1024 },
  )
  created = true
  step = 'create fixture token'
  const generated = await cli(
    'docker',
    [
      'exec',
      containerId,
      'gitea',
      'admin',
      'user',
      'generate-access-token',
      '--username',
      user,
      '--token-name',
      'registry-proof',
      '--scopes',
      'write:package',
      '--raw',
    ],
    { maxBuffer: 1024 * 1024 },
  )
  token =
    generated.stdout
      .trim()
      .split('\n')
      .find((line) => /^[a-f0-9]{40,128}$/i.test(line)) ?? ''
  if (!token) throw new Error('Could not obtain fixture token')
  const authconfig = { username: user, password: token, serveraddress: new URL(origin).host }
  step = 'tag existing local image'
  const before = await docker.getImage(source).inspect()
  await docker.getImage(source).tag({ repo: repository, tag: 'verification' })
  tagged = true
  step = 'push into local Gitea registry'
  const push = await progress(await docker.getImage(tag).push({ authconfig }))
  const pushed = await docker.getImage(tag).inspect()
  const digest =
    push.findLast((entry) => entry.aux?.Digest)?.aux.Digest ??
    pushed.RepoDigests?.find((value) => value.startsWith(`${repository}@`))?.split('@')[1]
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? ''))
    throw new Error('Push did not confirm a manifest digest')
  pinned = `${repository}@${digest}`
  step = 'remove fixture local registry references'
  await docker.getImage(tag).remove({ noprune: true })
  tagged = false
  await docker
    .getImage(pinned)
    .remove({ noprune: true })
    .catch((error) => {
      if (error.statusCode !== 404) throw error
    })
  step = 'pull exact manifest from Gitea'
  await progress(await docker.pull(pinned, { authconfig }))
  const after = await docker.getImage(pinned).inspect()
  if (after.Id !== before.Id || !after.RepoDigests?.includes(pinned))
    throw new Error('Pulled image identity differs')
  console.log(
    JSON.stringify({
      registry: origin,
      digest,
      sourceImageId: before.Id,
      pulledImageId: after.Id,
      pushPullVerified: true,
    }),
  )
  success = true
} catch (error) {
  console.error(`Registry proof failed during: ${step}`)
  const message = String(error?.message ?? '').toLowerCase()
  console.error(
    JSON.stringify({
      diagnostic: [
        'unauthorized',
        'denied',
        'connection refused',
        'http response to https',
        'no such host',
        'unsupported',
        'manifest',
        'not found',
        'timeout',
      ].filter((value) => message.includes(value)),
      status: error?.statusCode ?? null,
    }),
  )
  process.exitCode = 1
} finally {
  let clean = true
  if (token) {
    try {
      await api(`/packages/${user}/container/runtime-proof`, 'DELETE')
    } catch {
      clean = false
    }
  }
  if (tagged)
    await docker
      .getImage(tag)
      .remove({ noprune: true })
      .catch(() => {
        clean = false
      })
  if (pinned)
    await docker
      .getImage(pinned)
      .remove({ noprune: true })
      .catch((error) => {
        if (error.statusCode !== 404) clean = false
      })
  if (created) {
    try {
      await cli(
        'docker',
        ['exec', containerId, 'gitea', 'admin', 'user', 'delete', '--username', user, '--purge'],
        { maxBuffer: 1024 * 1024 },
      )
    } catch {
      clean = false
    }
  }
  token = ''
  console.log(
    JSON.stringify({ fixtureAccount: user, cleanupVerified: clean, proofPassed: success }),
  )
  if (!clean) process.exitCode = 1
}
