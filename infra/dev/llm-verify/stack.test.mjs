import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { serviceImages } from '../../../apps/core/scripts/verify-agent-supervisor.mjs'
import { parseClientPins } from '../../egress/llm-egress.mjs'
import { createVerificationCertificates } from './certificates.mjs'
import { chooseCliSubnet, mcpUpstream } from './stack.mjs'

test('chooses a subnet outside both wider and narrower existing Docker networks', () => {
  assert.equal(chooseCliSubnet([]), '172.30.120')
  assert.equal(chooseCliSubnet(['172.30.0.0/17']), '172.30.128')
  assert.equal(chooseCliSubnet(['172.30.120.16/28']), '172.30.121')
  assert.equal(chooseCliSubnet(['172.30.0.0/16']), '172.31.120')
  assert.throws(() => chooseCliSubnet(['172.16.0.0/12']), /No disposable CLI subnet/)
})

test('disposable topology never joins CLI to provider, Vault or PostgreSQL networks', async () => {
  const source = await readFile(new URL('./compose.yml', import.meta.url), 'utf8')
  assert.match(source, /providers:\n\s+internal: true/)
  assert.match(source, /cli:\n\s+internal: true/)
  for (const port of [5432, 8200, 8787, 8443]) assert.ok(source.includes(`127.0.0.1::${port}`))
  // The fake provider's TLS port, on loopback only: the role llm of a stand without a proxy
  // connects to it itself, under the name localhost of the fake's certificate.
  assert.match(source, /^ {4}ports: \['127\.0\.0\.1::8787', '127\.0\.0\.1::443'\]$/m)
  // The synthetic MCP is reachable only through sandbox-gw, never published to the host.
  assert.ok(!source.includes('::8788'))
  assert.match(source, /ALLOWED_ROUTES: '\["llm","mcp"\]'/)
  // The harness names the MCP upstream; without the content stand it is the synthetic server.
  assert.match(source, /MCP_UPSTREAM: \$\{VERIFY_MCP_UPSTREAM:\?\}/)
  assert.ok(!source.includes('root_token'))
  assert.ok(!source.includes('VAULT_DEV_ROOT_TOKEN'))
})

test('sandbox-gw reaches the synthetic MCP unless the stand runs the real role mcp', async () => {
  assert.equal(mcpUpstream(), 'http://fake-subscriptions:8788')
  // The role mcp is a process on the host, like the role llm.
  assert.equal(mcpUpstream(18082), 'http://host.docker.internal:18082')
  for (const port of [0, 65536, 1.5, '18082', null]) assert.throws(() => mcpUpstream(port))
  // A live stack runs the MCP side of the synthetic services alone, under its own name; the
  // real role mcp of the content stand is where it always was.
  assert.equal(mcpUpstream(undefined, { live: true }), 'http://synthetic-mcp:8788')
  assert.equal(mcpUpstream(18082, { live: true }), 'http://host.docker.internal:18082')
  const source = await readFile(new URL('./stack.mjs', import.meta.url), 'utf8')
  assert.match(source, /VERIFY_MCP_UPSTREAM: mcpUpstream\(mcpPort, \{ live \}\),/)
  assert.match(source, /const mcpPort = content \? await unusedPort\(\) : undefined/)
})

test('the content profile adds one S3 for snapshots and leaves the gateway stand as it was', async () => {
  const source = await readFile(new URL('./compose.yml', import.meta.url), 'utf8')
  const [, s3] = /^ {2}s3:\n((?: {4}.*\n)+)/m.exec(source) ?? []
  assert.ok(s3, 'compose.yml has the s3 service')
  // verify:llm-gateway starts without the profile: the same services as before. The one other
  // profile is the MCP side a live stack starts by name (live.test.mjs).
  assert.match(s3, /^ {4}profiles: \[content\]$/m)
  assert.deepEqual(source.match(/profiles: .*/g), ['profiles: [live]', 'profiles: [content]'])
  // The image every stand pins, published on loopback only, with the harness's own identity.
  assert.ok(s3.includes(` ${serviceImages.s3}\n`), "the S3 image differs from the stands' pin")
  assert.match(s3, /^ {4}ports: \['127\.0\.0\.1::8333'\]$/m)
  assert.match(s3, /\$\{VERIFY_DIR\}\/s3\.json:\/config\/s3\.json:ro/)
  assert.match(s3, /^ {4}networks: \[trusted\]$/m)
  const stack = await readFile(new URL('./stack.mjs', import.meta.url), 'utf8')
  assert.match(stack, /\.\.\.\(content \? \['--profile', 'content'\] : \[\]\),/)
})

test('the stand directory is removed the way the CLI session removes its own', async () => {
  // The CLI session's uid 10001 files live under this directory: a plain host rm cannot delete
  // them on native Linux (cli.test.mjs covers removeMountedDirectory itself).
  const source = await readFile(new URL('./stack.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\brm\(directory\b/)
  assert.match(
    source,
    /await removeMountedDirectory\(directory, \{\n\s+docker: \(args\) => docker\(args, \{ cleanup: true \}\),\n\s+image: CLI_IMAGE,\n\s+\}\)/,
  )
  // One image for the stand's services and for that cleanup: it is built before the stack starts.
  assert.match(source, /VERIFY_NODE_IMAGE: CLI_IMAGE,/)
})

test(
  'the stand pins the llm role certificate at its egress proxy, as egress-1 does',
  { skip: spawnSync('openssl', ['version']).status !== 0 && 'openssl is not installed' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'raditi-b13-certificates-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const repository = fileURLToPath(new URL('../../../', import.meta.url))
    const { authority, egress } = await createVerificationCertificates(repository, directory)
    const pins = parseClientPins((await readFile(join(egress, 'client-pins.txt'), 'utf8')).trim())
    const client = new X509Certificate(await readFile(join(authority, 'clients/b13-llm.pem')))
    assert.deepEqual([...pins], [client.fingerprint256.replaceAll(':', '').toLowerCase()])
  },
)

test('the gateway stand keeps its signal listeners until its cleanup has ended', async () => {
  const main = await readFile(
    new URL('../../../apps/core/scripts/verify-llm-gateway.mjs', import.meta.url),
    'utf8',
  )
  // With `once` no listener is left after the first signal: the second one (a second Ctrl-C,
  // a CI cancellation) ends the process in the middle of its cleanup and the stack stays behind.
  assert.match(main, /process\.on\('SIGINT', interrupt\)\nprocess\.on\('SIGTERM', interrupt\)/)
  assert.doesNotMatch(main, /process\.once\('SIG/)
  // A repeated signal starts nothing twice.
  assert.match(main, /const interrupt = \(\) => \{\n {2}if \(interrupted\) return\n/)
  // Removed last, after every owned resource was closed.
  assert.match(main, /process\.removeListener\('SIGTERM', interrupt\)\n\}\n$/)
})

/** The modules of infra/sandbox a module imports, itself among them, by relative name. */
async function sandboxModules(name, seen = new Set()) {
  if (seen.has(name)) return seen
  seen.add(name)
  const source = await readFile(new URL(`../../sandbox/${name}`, import.meta.url), 'utf8')
  for (const [, imported] of source.matchAll(/^import [^;]*? from '\.\/([a-z-]+\.mjs)'$/gm))
    await sandboxModules(imported, seen)
  return seen
}

test('sandbox-gw of the stand mounts the gateway with every module it imports', async () => {
  const source = await readFile(new URL('./compose.yml', import.meta.url), 'utf8')
  const [, gateway] = /^ {2}sandbox-gw:\n((?: {4}.*\n)+)/m.exec(source) ?? []
  assert.ok(gateway, 'compose.yml has the sandbox-gw service')
  assert.match(gateway, /^ {4}entrypoint: \['node', '\/repo\/gateway\.mjs'\]$/m)
  const modules = await sandboxModules('gateway.mjs')
  // The client egress proxy (plan 53, Р13) is a module of its own since R10.
  assert.ok(modules.has('client-egress.mjs'))
  const mounted = [
    ...gateway.matchAll(
      /^ {6}- \$\{VERIFY_ROOT\}\/infra\/sandbox\/([a-z-]+\.mjs):\/repo\/\1:ro$/gm,
    ),
  ].map(([, name]) => name)
  assert.deepEqual(mounted.sort(), [...modules].sort())
})

test('the stack waits for sandbox-gw to listen and stops with its log when it does not', async () => {
  const { gatewayReady, GATEWAY_READY_CHECK } = await import('./stack.mjs')
  const source = await readFile(new URL('./stack.mjs', import.meta.url), 'utf8')
  // Every stack, the live ones too: they start sandbox-gw by name (live.mjs).
  assert.match(source, /\n {4}await gatewayReady\(compose, onStage\)\n/)
  // The ready file gateway.mjs writes once all its listeners listen.
  const gatewaySource = await readFile(
    new URL('../../sandbox/gateway.mjs', import.meta.url),
    'utf8',
  )
  assert.match(gatewaySource, /writeFileSync\('\/run\/raditi-gateway\/ready'/)
  assert.ok(GATEWAY_READY_CHECK.includes("'/run/raditi-gateway/ready'"))
  const calls = []
  const ready = async (args) => {
    calls.push(args)
    return { code: calls.length < 3 ? 1 : 0, stdout: '', stderr: '' }
  }
  await gatewayReady(ready)
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0], ['exec', '-T', 'sandbox-gw', 'node', '-e', GATEWAY_READY_CHECK])
  // A gateway that ended at start: the stand stops with what it printed.
  const asked = []
  const ended = async (args) => {
    asked.push(args[0])
    return args[0] === 'logs'
      ? { code: 0, stdout: 'sandbox-gw-1  | Error [ERR_MODULE_NOT_FOUND]\n', stderr: '' }
      : { code: 1, stdout: '', stderr: 'service "sandbox-gw" is not running' }
  }
  await assert.rejects(
    gatewayReady(ended, () => {}, 300),
    (error) => {
      assert.equal(error.message, 'sandbox-gw did not become ready')
      assert.match(error.infrastructureDiagnostic, /ERR_MODULE_NOT_FOUND/)
      return true
    },
  )
  assert.equal(asked.at(-1), 'logs')
})
