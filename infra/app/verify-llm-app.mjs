// The actual app Compose llm service and production image against owned synthetic dependencies.
// This validates runtime wiring; the separate firewall verifier proves host packet filtering.
// No working .env, external Vault/database, provider account or cloud resource is accepted.
import assert from 'node:assert/strict'
import { X509Certificate, randomBytes, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { bootstrapLocalVault, localVaultRequest } from '../vault/bootstrap.mjs'
import { abortVerification, chooseCliSubnet, eventually, run } from '../dev/llm-verify/stack.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const app = join(root, 'infra/app')
const { values: options } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    image: { type: 'string', default: 'raditi-p3verify-orchestrator:b14' },
    'hairpin-only': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})
if (options.help) {
  process.stdout.write(
    'Usage: node infra/app/verify-llm-app.mjs [--image <local production image>] [--hairpin-only]\n',
  )
  process.stdout.write(
    'Build first: docker build -f apps/orchestrator/Dockerfile --target runtime -t raditi-p3verify-orchestrator:b14 .\n',
  )
  process.exit(0)
}

let directory,
  project,
  compose,
  stage = 'local Docker preflight',
  closing,
  interrupted = false
let passed = 0
const setStage = (value) => {
  stage = value
  process.stdout.write(`B14: ${value}\n`)
}
const check = (name) => {
  passed++
  process.stdout.write(`PASS ${passed}: ${name}\n`)
}
const docker = (args, init) => run('docker', args, init)
const envText = (values) =>
  Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n') + '\n'
const secretText = (values) =>
  Object.entries(values)
    .map(([name, value]) => `${name}="${value}"`)
    .join('\n') + '\n'

async function port() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return value
}

async function close() {
  return (closing ??= (async () => {
    if (compose) {
      await compose(['down', '--volumes', '--remove-orphans'], { cleanup: true, timeoutMs: 60_000 })
      const remaining = await docker(
        ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
        { cleanup: true },
      )
      assert.equal(remaining.stdout.trim(), '', 'Owned containers remain')
      const networks = await docker(
        ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`],
        { cleanup: true },
      )
      assert.equal(networks.stdout.trim(), '', 'Owned networks remain')
    }
    if (directory) await rm(directory, { recursive: true, force: true })
  })())
}

for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    interrupted = true
    abortVerification()
  })

async function hairpinOnly() {
  setStage('native Linux Docker control hairpin')
  const context = (
    await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
  ).stdout.trim()
  const endpoint = process.env.DOCKER_CONTEXT ? context : (process.env.DOCKER_HOST ?? context)
  assert.match(endpoint, /^(unix:\/\/\/[^\s?#]+|npipe:\/\/\/[/\\][^\s?#]+)$/)
  assert.equal(
    (await docker(['info', '--format', '{{.OperatingSystem}}'])).stdout.includes('Docker Desktop'),
    false,
    'A native Linux Docker VM is required',
  )
  await docker(['image', 'inspect', options.image])
  const ids = (await docker(['network', 'ls', '-q'])).stdout.trim().split(/\s+/).filter(Boolean)
  const networks = ids.length
    ? JSON.parse((await docker(['network', 'inspect', ...ids])).stdout)
    : []
  const taken = networks
    .flatMap((network) => network.IPAM.Config ?? [])
    .map((item) => item.Subnet ?? '')
  const prefix = chooseCliSubnet(taken)
  const corePrefix = chooseCliSubnet([...taken, `${prefix}.0/24`])
  const gateway = `${prefix}.1`
  const project = `raditi-b14-hairpin-${randomBytes(5).toString('hex')}`
  const ownedNetworks = [],
    ownedContainers = []
  const label = `raditi.b14.verification=${project}`
  try {
    for (const [suffix, args] of [
      ['out', ['--subnet', `${prefix}.0/24`, '--gateway', gateway]],
      ['data', ['--internal']],
      ['edge', ['--internal']],
      ['core', ['--subnet', `${corePrefix}.0/24`]],
    ]) {
      const name = `${project}-${suffix}`
      await docker(['network', 'create', '--label', label, ...args, name])
      ownedNetworks.push(name)
    }
    const name = `${project}-llm`
    ownedContainers.push(name)
    await docker([
      'run',
      '-d',
      '--name',
      name,
      '--label',
      label,
      '--network',
      `name=${project}-out,gw-priority=1`,
      '--publish',
      `${gateway}::8084`,
      '--user',
      '10008:10008',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--entrypoint',
      'node',
      options.image,
      '-e',
      `require('node:http').createServer((request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({source:request.socket.remoteAddress,host:request.headers.host}));}).listen(8084,'0.0.0.0')`,
    ])
    for (const suffix of ['data', 'edge'])
      await docker(['network', 'connect', `${project}-${suffix}`, name])
    const published = (await docker(['port', name, '8084/tcp'])).stdout.trim()
    assert.match(published, new RegExp(`^${gateway.replaceAll('.', '\\.')}:\\d+$`))
    const coreName = `${project}-core`
    ownedContainers.push(coreName)
    const result = await docker([
      'run',
      '--name',
      coreName,
      '--label',
      label,
      '--network',
      `${project}-core`,
      '--user',
      '10002:10002',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--entrypoint',
      'node',
      options.image,
      '--input-type=module',
      '-e',
      `const r=await fetch(${JSON.stringify(`http://${published}/internal/subscriptions/probe`)},{signal:AbortSignal.timeout(5000)});console.log(await r.text())`,
    ])
    const observed = JSON.parse(result.stdout.trim())
    assert.equal(observed.host, published)
    assert.equal(observed.source.replace(/^::ffff:/, ''), gateway)
    check(
      'native Linux separate core bridge reaches the private published origin with llm-out gateway source',
    )
    process.stdout.write(`Hairpin observation: source ${gateway}; Host ${published}.\n`)
  } finally {
    for (const name of ownedContainers.reverse())
      await docker(['rm', '-f', name], { cleanup: true, allowFailure: true })
    for (const name of ownedNetworks.reverse())
      await docker(['network', 'rm', name], { cleanup: true, allowFailure: true })
    assert.equal(
      (await docker(['ps', '-aq', '--filter', `label=${label}`], { cleanup: true })).stdout.trim(),
      '',
    )
    assert.equal(
      (
        await docker(['network', 'ls', '-q', '--filter', `label=${label}`], { cleanup: true })
      ).stdout.trim(),
      '',
    )
  }
}

async function main() {
  const context = (
    await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
  ).stdout.trim()
  const endpoint = process.env.DOCKER_CONTEXT ? context : (process.env.DOCKER_HOST ?? context)
  assert.match(endpoint, /^(unix:\/\/\/[^\s?#]+|npipe:\/\/\/[/\\][^\s?#]+)$/)
  await docker(['image', 'inspect', options.image])
  directory = await mkdtemp(join(tmpdir(), 'raditi-b14-app-'))
  project = `raditi-b14-app-${randomBytes(5).toString('hex')}`
  const networkIds = (await docker(['network', 'ls', '-q'])).stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const networks = networkIds.length
    ? JSON.parse((await docker(['network', 'inspect', ...networkIds])).stdout)
    : []
  const subnet = chooseCliSubnet(
    networks.flatMap((network) => network.IPAM.Config ?? []).map((item) => item.Subnet ?? ''),
  )
  const desktop = (await docker(['info', '--format', '{{.OperatingSystem}}'])).stdout.includes(
    'Docker Desktop',
  )
  // Desktop forwards published ports through macOS, where the Linux bridge IP does not exist.
  // Native Linux can exercise the exact core → host-private-IP → published-container hairpin.
  const privateIp = desktop ? '127.0.0.1' : `${subnet}.1`
  const llmPort = await port()
  const secrets = join(directory, 'secrets')
  const authority = join(directory, 'authority')
  const password = randomBytes(24).toString('hex')
  const metricsToken = randomBytes(32).toString('hex')
  const canary = `b14-secret-${randomUUID()}`
  const fixtureTokenCanaries = [password, metricsToken, canary]
  for (const name of ['postgres', 'vault-tls', 'egress-tls', 'secrets/llm', 'secrets/core'])
    await mkdir(join(directory, name), { recursive: true })
  for (const name of ['password', 'superuser-password'])
    await writeFile(join(directory, 'postgres', name), password, { mode: 0o444 })

  setStage('owned certificates and Compose configuration')
  const issue = (...args) => run('sh', [join(root, 'infra/egress/make-ca.sh'), ...args])
  await issue('ca', authority)
  await issue('server', authority, 'egress-1.raditi.internal')
  await issue('server', authority, 'vault.raditi.internal')
  await issue('client', authority, 'b14-llm')
  for (const [source, target] of [
    ['server/vault.raditi.internal.pem', 'vault-tls/server.pem'],
    ['server/vault.raditi.internal-key.pem', 'vault-tls/server-key.pem'],
    ['server/egress-1.raditi.internal.pem', 'egress-tls/server.pem'],
    ['server/egress-1.raditi.internal-key.pem', 'egress-tls/server-key.pem'],
    ['root.pem', 'egress-tls/root.pem'],
    ['client-ca.pem', 'egress-tls/client-ca.pem'],
    ['clients/b14-llm.pem', 'secrets/llm/egress-client.pem'],
    ['clients/b14-llm-key.pem', 'secrets/llm/egress-client-key.pem'],
    ['root.pem', 'secrets/llm/egress-ca.pem'],
    ['root.pem', 'secrets/llm/vault-ca.pem'],
    ['root.pem', 'secrets/core/vault-ca.pem'],
  ]) {
    await copyFile(join(authority, source), join(directory, target))
    // Only synthetic fixtures: the outer temporary directory is 0700. Actual production
    // uid/0400/tmpfs permissions are checked separately by preflight, not weakened there.
    await chmod(join(directory, target), 0o444)
  }
  await writeFile(
    join(directory, 'bao.hcl'),
    `disable_mlock = true\nstorage "inmem" {}\nlistener "tcp" {\n address = "0.0.0.0:8200"\n tls_cert_file = "/tls/server.pem"\n tls_key_file = "/tls/server-key.pem"\n}\nlistener "tcp" {\n address = "0.0.0.0:8201"\n tls_disable = true\n}\n`,
    { mode: 0o444 },
  )
  const defaults = Object.fromEntries(
    (await readFile(join(app, 'env.example'), 'utf8'))
      .split('\n')
      .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line))
      .filter(Boolean)
      .map(([, name, value]) => [name, value]),
  )
  const values = {
    ...defaults,
    APP_DOMAIN: 'b14.invalid',
    APP_PRIVATE_IP: privateIp,
    APP_REVISION: 'a'.repeat(40),
    ORCHESTRATOR_IMAGE: options.image,
    POSTGRES_IMAGE:
      'postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24',
    SECRETS_DIR: secrets,
    VOLUME_PREFIX: project,
    BRIDGE_PREFIX: `v${randomBytes(2).toString('hex')}`,
    COMPOSE_PROFILES: 'llm',
    VERIFY_DIR: directory,
    VERIFY_ROOT: root,
    LLM_OUT_SUBNET: `${subnet}.0/24`,
    LLM_OUT_GATEWAY: `${subnet}.1`,
    VAULT_PRIVATE_IP: `${subnet}.20`,
    EGRESS_PROXY_IP: `${subnet}.21`,
    VAULT_ADDR: 'https://vault.raditi.internal:8200',
    LLM_GATEWAY_PUBLISH: String(llmPort),
    LLM_GATEWAY_CLIENTS: `${subnet}.1/32`,
    LLM_GATEWAY_HOSTS: `127.0.0.1:8084,127.0.0.1:${llmPort}`,
    VERIFY_EGRESS_CLIENT_SHA256: new X509Certificate(
      await readFile(join(authority, 'clients/b14-llm.pem')),
    ).fingerprint256,
  }
  const envFile = join(directory, 'compose.env')
  await writeFile(envFile, envText(values), { mode: 0o600 })
  const composeArgs = [
    'compose',
    '--project-name',
    project,
    '--project-directory',
    app,
    '--env-file',
    envFile,
    '-f',
    join(app, 'docker-compose.yml'),
    '-f',
    join(app, 'verify/compose.llm.yml'),
  ]
  compose = (args, init) => docker([...composeArgs, ...args], init)
  const config = JSON.parse((await compose(['config', '--format', 'json'])).stdout)
  assert.equal(config.services.llm.user, '10008:10008')
  assert.equal(config.services.llm.environment.ORCHESTRATOR_ROLES, 'llm')
  assert.equal(config.services.llm.environment.APP_ENV, 'production')
  assert.equal(config.services.llm.ports.length, 1)
  assert.equal(config.services.llm.ports[0].host_ip, privateIp)
  assert.equal(config.services.llm.ports[0].target, 8084)
  assert.deepEqual(Object.keys(config.services.llm.networks).sort(), [
    'llm-data',
    'llm-edge',
    'llm-out',
  ])
  for (const name of [
    'REDIS_URL',
    'S3_ENDPOINT',
    'S3_ACCESS_KEY_ID',
    'LLM_UPSTREAM_CA_FILE',
    'LLM_BACKEND_URL_OPENAI_CHATGPT',
    'LLM_BACKEND_URL_KIMI_CODE',
  ])
    assert.equal(config.services.llm.environment[name], undefined, `${name} is absent`)
  check('production role, uid, private port, three networks and no Redis/S3/provider override')

  setStage('owned PostgreSQL, HTTPS OpenBao and mTLS proxy')
  await compose(
    ['up', '-d', '--no-deps', 'verify-postgres', 'verify-vault', 'verify-egress', 'verify-core'],
    {
      infrastructureDiagnostics: true,
    },
  )
  const published = async (service, number) => {
    const value = (await compose(['port', service, String(number)])).stdout.trim()
    assert.match(value, /^127\.0\.0\.1:\d+$/)
    return value
  }
  await eventually(
    async () =>
      (
        await compose(
          [
            'exec',
            '-T',
            'verify-postgres',
            'pg_isready',
            '-h',
            '127.0.0.1',
            '-U',
            'postgres',
            '-d',
            'raditi',
          ],
          { allowFailure: true },
        )
      ).code === 0,
  )
  await compose(['exec', '-T', 'verify-postgres', 'sh', '-s'], {
    input: await readFile(join(app, 'postgres/init-roles.sh')),
  })
  const databaseUrl = `postgresql://raditi:${password}@${await published('verify-postgres', 5432)}/raditi`
  const prismaConfig = join(directory, 'prisma.config.ts')
  await writeFile(
    prismaConfig,
    `export default {schema:${JSON.stringify(join(root, 'packages/db/prisma/schema.prisma'))},migrations:{path:${JSON.stringify(join(root, 'packages/db/prisma/migrations'))}},datasource:{url:process.env.DATABASE_URL}}\n`,
  )
  await run(
    'pnpm',
    ['--filter', '@repo/db', 'exec', 'prisma', 'migrate', 'deploy', '--config', prismaConfig],
    { env: { DATABASE_URL: databaseUrl, NODE_ENV: 'test', JITI_FS_CACHE: 'false' } },
  )
  const address = `http://${await published('verify-vault', 8201)}`
  await eventually(async () => (await localVaultRequest({ address }, 'sys/health')).status === 501)
  const initialized = await localVaultRequest({ address }, 'sys/init', {
    method: 'POST',
    body: { secret_shares: 1, secret_threshold: 1 },
  })
  assert.equal(initialized.status, 200)
  assert.equal(
    (
      await localVaultRequest({ address }, 'sys/unseal', {
        method: 'POST',
        body: { key: initialized.body.keys_base64[0] },
      })
    ).status,
    200,
  )
  const vault = { address, token: initialized.body.root_token }
  fixtureTokenCanaries.push(vault.token)
  const request = async (path, init = {}) => {
    const result = await localVaultRequest(vault, path, init)
    assert.ok([200, 204].includes(result.status), 'Vault fixture setup failed')
    return result.body
  }
  await bootstrapLocalVault(vault)
  await request('sys/auth/approle', { method: 'POST', body: { type: 'approle' } })
  await request('auth/approle/role/llm', {
    method: 'POST',
    body: {
      token_policies: ['llm-subscriptions'],
      token_no_default_policy: true,
      token_ttl: '15m',
      token_max_ttl: '1h',
      secret_id_ttl: '1h',
    },
  })
  const roleId = (await request('auth/approle/role/llm/role-id')).data.role_id
  const secretId = (await request('auth/approle/role/llm/secret-id', { method: 'POST', body: {} }))
    .data.secret_id
  fixtureTokenCanaries.push(secretId)
  await request('subs/data/b14/canary', {
    method: 'POST',
    body: { options: { cas: 0 }, data: { value: canary } },
  })
  await writeFile(
    join(secrets, 'llm/app.env'),
    secretText({
      DATABASE_URL: `postgresql://raditi:${password}@verify-postgres:5432/raditi`,
      VAULT_ROLE_ID: roleId,
      VAULT_SECRET_ID: secretId,
      METRICS_TOKEN: metricsToken,
    }),
    { mode: 0o444 },
  )

  setStage('production image startup and dependency health')
  await compose(['up', '-d', '--no-deps', 'llm'], { infrastructureDiagnostics: true })
  const execute = async (script, input) => {
    const result = await compose(
      [
        'exec',
        '-T',
        'llm',
        'node',
        '--env-file=/run/raditi/app.env',
        '--input-type=module',
        '-e',
        script,
      ],
      { input },
    )
    return JSON.parse(result.stdout.trim().split('\n').at(-1))
  }
  // `control`: the bearer of the private control endpoint, read inside the container from its own
  // app.env, so the token never reaches a command line.
  const http = (path, method = 'GET', body, control = false) =>
    execute(
      `const r=await fetch('http://127.0.0.1:8084'+${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{host:'127.0.0.1:8084','content-type':'application/json'${control ? ",authorization:'Bearer '+process.env.METRICS_TOKEN" : ''}},${body ? `body:${JSON.stringify(JSON.stringify(body))},` : ''}signal:AbortSignal.timeout(5000)});console.log(JSON.stringify({status:r.status,body:await r.text()}))`,
    )
  await eventually(async () => (await http('/health')).status === 200, 60_000)
  assert.deepEqual(JSON.parse((await http('/health')).body), { status: 'ok' })
  const running = (await compose(['ps', '--services', '--status', 'running'])).stdout
    .trim()
    .split('\n')
    .sort()
  assert.deepEqual(running, [
    'llm',
    'verify-core',
    'verify-egress',
    'verify-postgres',
    'verify-vault',
  ])
  // The mTLS probe behind that health passed a proxy that admits only the pinned client leaf.
  const egressLog = await compose(['logs', '--no-color', '--no-log-prefix', 'verify-egress'])
  assert.match(egressLog.stdout, /^\{"event":"listening","port":443,"pinned":true\}$/m)
  check('real production image is healthy with only PostgreSQL, HTTPS Vault and mTLS egress')
  const inspected = JSON.parse(
    (await docker(['inspect', (await compose(['ps', '-q', 'llm'])).stdout.trim()])).stdout,
  )[0]
  assert.equal(inspected.Config.User, '10008:10008')
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true)
  assert.deepEqual(inspected.HostConfig.CapDrop, ['ALL'])
  assert.ok(inspected.HostConfig.SecurityOpt.includes('no-new-privileges:true'))
  check('running container retains the production hardening')

  setStage('production core service: Vault CA and pinned Vault name')
  // core issues the turn keys llm reads. The service as Compose resolves it, without starting
  // the role: its own secret directory, environment and hosts file under its own uid.
  const wiring = await compose([
    'run',
    '--rm',
    '--no-deps',
    '-T',
    'core',
    '--input-type=module',
    '-e',
    `
      import { X509Certificate } from 'node:crypto'
      import { lookup } from 'node:dns/promises'
      import tls from 'node:tls'
      console.log(JSON.stringify({
        uid: process.getuid(),
        vault: process.env.VAULT_ADDR,
        trusted: tls.getCACertificates('extra').map((pem) => new X509Certificate(pem).fingerprint256),
        address: (await lookup('vault.raditi.internal', 4)).address,
      }))
    `,
  ])
  assert.deepEqual(JSON.parse(wiring.stdout.trim().split('\n').at(-1)), {
    uid: 10002,
    vault: 'https://vault.raditi.internal:8200',
    trusted: [new X509Certificate(await readFile(join(authority, 'root.pem'))).fingerprint256],
    address: values.VAULT_PRIVATE_IP,
  })
  check('core trusts exactly the Vault CA of its own secrets and resolves the pinned Vault name')

  if (desktop) {
    process.stdout.write(
      'SKIP: Docker Desktop cannot bind the Linux bridge IP on macOS; native Linux control hairpin remains unverified.\n',
    )
  } else {
    setStage('private control call from a separate core egress bridge')
    const control = await compose(
      [
        'exec',
        '-T',
        'verify-core',
        'node',
        '--input-type=module',
        '-e',
        `
      const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
      const config=JSON.parse(Buffer.concat(chunks).toString());
      try {const r=await fetch(config.url,{method:'POST',headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},body:JSON.stringify({accountIds:[config.accountId]}),signal:AbortSignal.timeout(5000)});console.log(JSON.stringify({status:r.status}));}
      catch(error){console.log(JSON.stringify({status:0,error:error.cause?.code??'request_failed'}));}
    `,
      ],
      {
        input: JSON.stringify({
          url: `http://${privateIp}:${llmPort}/internal/subscriptions/probe`,
          host: `${privateIp}:${llmPort}`,
          token: metricsToken,
          accountId: randomUUID(),
        }),
      },
    )
    const controlResult = JSON.parse(control.stdout.trim())
    if (controlResult.status !== 204)
      process.stdout.write(`Control check: ${JSON.stringify(controlResult)}\n`)
    assert.equal(controlResult.status, 204)
    check('authenticated control reaches the published port from an independent core bridge')
  }

  setStage('actual AppRole authentication and exact subscription ACL')
  const acl = await execute(`
    const base=process.env.VAULT_ADDR+'/v1/';
    const call=async(path,method='GET',body,token)=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{'X-Vault-Token':token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});return {status:r.status,body:await r.json().catch(()=>null)}};
    const login=await call('auth/approle/login','POST',{role_id:process.env.VAULT_ROLE_ID,secret_id:process.env.VAULT_SECRET_ID});
    const token=login.body?.auth?.client_token;
    if(login.status!==200||!token)throw Error('AppRole verification failed');
    const read=await call('subs/data/b14/canary','GET',undefined,token);
    const cas=await call('subs/data/b14/canary','POST',{options:{cas:read.body?.data?.metadata?.version},data:read.body?.data?.data},token);
    const denied=[];for(const [path,method] of [['subs/metadata/b14/canary','GET'],['subs/data/b14/canary','DELETE'],['subs/destroy/b14/canary','POST'],['turns/data/b14/canary','GET']])denied.push((await call(path,method,method==='POST'?{versions:[1]}:undefined,token)).status);
    const previous=await call('subs/data/b14/canary?version=1','GET',undefined,token);
    console.log(JSON.stringify({login:login.status,policies:login.body.auth.policies,read:read.status,cas:cas.status,denied,previous:previous.status}));
  `)
  assert.equal(acl.login, 200)
  assert.deepEqual(acl.policies, ['llm-subscriptions'])
  assert.equal(acl.read, 200)
  assert.equal(acl.cas, 200)
  assert.deepEqual(acl.denied, [403, 403, 403, 403])
  assert.equal(acl.previous, 404)
  check(
    'own AppRole reads/CAS subscription KV; metadata, deletion, turn keys and old version are unavailable',
  )

  assert.equal(
    (await http('/codex/responses', 'POST', { model: 'gpt-5.4', input: [] })).status,
    401,
  )
  assert.equal((await http('/v1/chat/completions', 'POST', {})).status, 403)
  assert.equal(
    (await http('/internal/subscriptions/probe', 'POST', { accountIds: [randomUUID()] })).status,
    401,
  )
  check('missing turn/control keys and forbidden public routes fail safely')

  setStage('egress loss at process startup closes admission')
  await compose(['stop', '-t', '2', 'verify-egress'])
  await compose(['restart', 'llm'])
  await eventually(async () => (await http('/health')).status === 503, 45_000)
  // A provider request is authenticated before admission: without a turn key it stays 401. The
  // authenticated control endpoint answers from the admission gate itself, before any probe.
  const probe = { accountIds: [randomUUID()] }
  assert.equal(
    (await http('/codex/responses', 'POST', { model: 'gpt-5.4', input: [] })).status,
    401,
  )
  const blocked = await http('/internal/subscriptions/probe', 'POST', probe, true)
  assert.equal(blocked.status, 503)
  assert.match(blocked.body, /raditi_busy/)
  check('unavailable egress yields degraded health and closes admission after restart')
  await compose(['start', 'verify-egress'])
  await compose(['restart', 'llm'])
  await eventually(async () => (await http('/health')).status === 200, 45_000)
  // An unknown account: admission is open again, and no provider request follows.
  assert.equal((await http('/internal/subscriptions/probe', 'POST', probe, true)).status, 204)
  check('restored mTLS egress reopens health and admission after restart')

  setStage('diagnostic redaction and owned cleanup')
  const logResult = await compose(['logs', '--no-color'])
  const logs = logResult.stdout + logResult.stderr
  for (const value of fixtureTokenCanaries)
    assert.equal(logs.includes(value), false, 'A synthetic secret reached service logs')
  assert.equal(/"event":"connect"/.test(logs), false, 'No provider CONNECT may occur')
  check('no provider request or synthetic secret occurs in service logs')
}

try {
  if (options['hairpin-only']) await hairpinOnly()
  else await main()
  await close()
  check('all owned containers, networks and private fixture files removed')
  process.stdout.write(
    `B14 ${options['hairpin-only'] ? 'control hairpin' : 'app runtime'} verification passed: ${passed} groups. Host firewall was not applied by this verifier.\n`,
  )
} catch (error) {
  if (error.infrastructureDiagnostic) process.stderr.write(`${error.infrastructureDiagnostic}\n`)
  process.stderr.write(
    `B14 app runtime verification ${interrupted ? 'interrupted' : 'failed'} at: ${stage}. No private diagnostics are printed.\n`,
  )
  process.exitCode = 1
} finally {
  try {
    await close()
  } catch {
    process.stderr.write('Owned B14 cleanup failed.\n')
    process.exitCode = 1
  }
}
