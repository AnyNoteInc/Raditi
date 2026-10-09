import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  checkLlmPreflight,
  llmEnabled,
  parseSettings,
  validateSecrets,
  validateSettings,
} from './llm-preflight.mjs'

const directory = mkdtempSync(join(tmpdir(), 'raditi-llm-preflight-'))
after(() => rmSync(directory, { recursive: true, force: true }))
const ca = join(directory, 'ca')
const makeCa = fileURLToPath(new URL('../egress/make-ca.sh', import.meta.url))
for (const args of [
  ['ca', ca],
  ['client', ca, 'app-1'],
  ['client', ca, 'other'],
  ['server', ca, 'egress-1.raditi.internal'],
])
  execFileSync('sh', [makeCa, ...args], { stdio: 'pipe' })
const base = {
  COMPOSE_PROFILES: 'ops,llm',
  APP_PRIVATE_IP: '10.10.0.10',
  VAULT_PRIVATE_IP: '10.10.0.20',
  VAULT_ADDR: 'https://vault.raditi.internal:8200',
  EGRESS_PROXY_IP: '93.184.216.34',
  LLM_GATEWAY_PUBLISH: '8084',
  LLM_GATEWAY_CLIENTS: '10.10.1.0/24,172.29.84.1/32',
  LLM_OUT_SUBNET: '172.29.84.0/24',
  LLM_OUT_GATEWAY: '172.29.84.1',
  BRIDGE_PREFIX: 'rd',
}
const secret = {
  DATABASE_URL: 'postgresql://raditi:synthetic-password@postgres:5432/raditi',
  VAULT_ROLE_ID: 'synthetic-llm-role',
  VAULT_SECRET_ID: 'synthetic-llm-secret',
  METRICS_TOKEN: 'synthetic-metrics-token-at-least-thirty-two-characters',
}
const core = {
  DATABASE_URL: secret.DATABASE_URL,
  VAULT_ROLE_ID: 'synthetic-core-role',
  VAULT_SECRET_ID: 'synthetic-core-secret',
  METRICS_TOKEN: secret.METRICS_TOKEN,
}
// web keeps its own secrets; only the token that must differ matters here.
const web = { METRICS_TOKEN: 'synthetic-web-metrics-token-of-thirty-two-characters' }
const dotenv = (values, quoted = false) =>
  Object.entries(values)
    .map(([name, value]) => `${name}=${quoted ? `"${value}"` : value}`)
    .join('\n') + '\n'
let fixtureNumber = 0
function fixture() {
  const root = join(directory, `fixture-${++fixtureNumber}`)
  mkdirSync(join(root, 'llm'), { recursive: true })
  mkdirSync(join(root, 'core'))
  mkdirSync(join(root, 'web'))
  const settings = { ...base, SECRETS_DIR: root }
  writeFileSync(join(root, 'llm', 'app.env'), dotenv(secret, true))
  writeFileSync(join(root, 'core', 'app.env'), dotenv(core, true))
  writeFileSync(join(root, 'web', 'app.env'), dotenv(web, true))
  for (const [source, target] of [
    ['clients/app-1.pem', 'egress-client.pem'],
    ['clients/app-1-key.pem', 'egress-client-key.pem'],
    ['root.pem', 'egress-ca.pem'],
    ['root.pem', 'vault-ca.pem'],
  ])
    cpSync(join(ca, source), join(root, 'llm', target))
  for (const service of ['web', 'core'])
    cpSync(join(ca, 'root.pem'), join(root, service, 'vault-ca.pem'))
  const envFile = join(root, 'compose.env')
  writeFileSync(envFile, dotenv(settings))
  return { root, settings, envFile }
}

test('disabled profile does not require any LLM settings or access its secret directory', () => {
  assert.deepEqual(validateSettings({ COMPOSE_PROFILES: 'ops' }), { enabled: false })
  const envFile = join(directory, 'disabled.env')
  writeFileSync(envFile, 'COMPOSE_PROFILES=\nSECRETS_DIR=/does-not-exist/llm\n')
  assert.deepEqual(checkLlmPreflight(envFile), { enabled: false })
  assert.equal(llmEnabled({ COMPOSE_PROFILES: 'llm-other' }), false)
})

test('production bridge names remain fixed even with the llm profile disabled', () => {
  for (const COMPOSE_PROFILES of ['', 'ops', 'llm']) {
    assert.throws(
      () => validateSettings({ ...base, COMPOSE_PROFILES, BRIDGE_PREFIX: 'other' }),
      /BRIDGE_PREFIX/,
    )
    const settings = { ...base, COMPOSE_PROFILES }
    delete settings.BRIDGE_PREFIX
    assert.doesNotThrow(() => validateSettings(settings))
  }
})

test('the shell gate rejects Compose wildcard profiles before touching host state', () => {
  const cliEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => ['PATH', 'HOME'].includes(name) || name.startsWith('DOCKER_'),
    ),
  )
  const resolved = JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '-f',
        fileURLToPath(new URL('./docker-compose.yml', import.meta.url)),
        '--env-file',
        fileURLToPath(new URL('./env.example', import.meta.url)),
        'config',
        '--format',
        'json',
      ],
      { encoding: 'utf8', env: { ...cliEnv, COMPOSE_PROFILES: '*' } },
    ),
  )
  assert.ok(resolved.services.llm, 'Docker Compose must demonstrate that * activates llm')

  const root = mkdtempSync(join(directory, 'shell-gate-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  for (const name of ['preflight.sh', 'llm-preflight.mjs'])
    cpSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), join(root, name))
  // A failing regression must not inspect the real host, Docker daemon or firewall.
  for (const name of [
    'docker',
    'grep',
    'stat',
    'ip',
    'systemctl',
    'pgrep',
    'sysctl',
    'timedatectl',
    'getent',
  ])
    writeFileSync(join(bin, name), '#!/bin/sh\necho HOST-CHECK-REACHED >&2\nexit 99\n', {
      mode: 0o755,
    })
  symlinkSync(process.execPath, join(bin, 'node'))
  for (const [fileProfiles, ambientProfiles, prefix] of [
    ['*', undefined, 'rd'],
    ['ops,*', undefined, 'rd'],
    ['', '*', 'rd'],
    ['llm,', undefined, 'rd'],
    ['', 'llm ops', 'rd'],
    ['', undefined, 'other'],
  ]) {
    writeFileSync(
      join(root, '.env'),
      dotenv({
        COMPOSE_PROFILES: fileProfiles,
        BRIDGE_PREFIX: prefix,
        SECRETS_DIR: join(root, 'absent-secrets'),
      }),
    )
    const result = spawnSync('/bin/sh', [join(root, 'preflight.sh')], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        ...(ambientProfiles === undefined ? {} : { COMPOSE_PROFILES: ambientProfiles }),
      },
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^llm-preflight: /)
    assert.doesNotMatch(result.stdout + result.stderr, /HOST-CHECK-REACHED|absent-secrets/)
  }
})

test('the shell gate requires Docker 29 with the llm profile, Docker 28 without it', () => {
  // core reaches llm through a port published for another bridge network: with the userland
  // proxy off Docker 28 drops it (DOCKER-ISOLATION-STAGE-2), Docker 29 does not.
  const root = mkdtempSync(join(directory, 'engine-gate-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  cpSync(fileURLToPath(new URL('./preflight.sh', import.meta.url)), join(root, 'preflight.sh'))
  const stub = (name, body) =>
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  // Only the engine gate is under test: the settings check passes, the daemon reports the
  // version of the case, and the commands that would query the real host, daemon or firewall
  // are stubs that fail.
  stub('node', 'exit 0')
  stub('docker', '[ "$1" = version ] || exit 1\necho "$PREFLIGHT_TEST_SERVER"')
  for (const name of ['stat', 'ip', 'systemctl', 'pgrep', 'sysctl', 'timedatectl', 'getent', 'cmp'])
    stub(name, 'exit 1')
  const general = 'preflight: Docker server 28 or newer is required'
  const llm = 'preflight: Docker server 29 or newer is required with the llm profile'
  for (const [fileProfiles, ambientProfiles, server, expected] of [
    ['llm', undefined, '28.0.4', [llm]],
    ['ops,llm', undefined, '28.5.2', [llm]],
    ['', 'llm', '28.0.4', [llm]],
    ['llm', undefined, '27.5.1', [general, llm]],
    ['llm', undefined, '', [general, llm]],
    ['llm', undefined, '29.0.0', []],
    ['ops,llm', undefined, '29.5.2', []],
    ['llm', undefined, '30.1.0', []],
    ['', undefined, '28.0.4', []],
    ['ops', undefined, '27.5.1', [general]],
  ]) {
    writeFileSync(
      join(root, '.env'),
      dotenv({ COMPOSE_PROFILES: fileProfiles, SECRETS_DIR: join(root, 'absent-secrets') }),
    )
    const result = spawnSync('/bin/sh', [join(root, 'preflight.sh')], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        PREFLIGHT_TEST_SERVER: server,
        ...(ambientProfiles === undefined ? {} : { COMPOSE_PROFILES: ambientProfiles }),
      },
    })
    // The stubbed host fails the other checks; the engine lines are what the case decides.
    assert.equal(result.status, 1)
    assert.deepEqual(
      result.stderr.split('\n').filter((line) => line.startsWith('preflight: Docker server ')),
      expected,
      `profiles "${fileProfiles}"/"${ambientProfiles ?? ''}", Docker ${server || 'unknown'}`,
    )
  }
})

test('env parser rejects ambiguity and never executes interpolation', () => {
  for (const value of [
    'A=one\nA=two',
    'export A=value',
    'A="value"',
    'A=value # comment',
    'A=${B}',
    'A=$(touch marker)',
    'A=`touch marker`',
    'A=bad\0value',
  ])
    assert.throws(() => parseSettings(value))
  // The operator gets the number of the line, never its text.
  assert.throws(() => parseSettings('A=one\n\nexport B=value'), {
    message: 'env file contains an invalid line: line 3',
  })
  assert.throws(() => parseSettings('# c\nA=one\nA=two'), {
    message: 'env file contains a duplicate setting: line 3',
  })
  assert.equal(parseSettings('A="a#b"', { secret: true }).A, 'a#b')
  for (const value of ['llm,', ' llm', 'llm ops', ',llm', '*'])
    assert.throws(() => llmEnabled({ COMPOSE_PROFILES: value }))
})

test('fixed production network settings accept private clients and the exact hairpin gateway', () => {
  assert.equal(validateSettings(base).enabled, true)
  for (const [name, values] of Object.entries({
    APP_PRIVATE_IP: ['0.0.0.0', '127.0.0.1', 'example.test', '8.8.8.8', '172.29.84.2'],
    VAULT_PRIVATE_IP: ['169.254.169.254', '10.10.0.10', '::1'],
    VAULT_ADDR: [
      'http://vault.raditi.internal:8200',
      'https://10.10.0.20:8200',
      'https://vault.raditi.internal:8200/path',
    ],
    EGRESS_PROXY_IP: [
      '',
      'proxy.test',
      '10.0.0.1',
      '127.0.0.1',
      '100.64.1.1',
      '169.254.169.254',
      '192.0.2.1',
      '224.1.1.1',
    ],
    LLM_GATEWAY_PUBLISH: ['8085', '0', '8084:8084'],
    LLM_OUT_SUBNET: ['172.29.84.2/24', '0.0.0.0/0', '172.29.84.0/31', '10.10.0.0/24'],
    LLM_OUT_GATEWAY: ['172.29.84.0', '172.29.84.255', '172.29.85.1', 'localhost'],
    LLM_GATEWAY_CLIENTS: [
      '',
      '0.0.0.0/0',
      '10.10.1.0/24',
      '10.10.1.0/24,172.29.84.0/24',
      '172.29.84.1/32',
      '10.10.0.0/16,172.29.84.1/32',
      '10.10.1.1/24,172.29.84.1/32',
      '10.10.1.0/24,172.29.84.1/32,172.29.84.1/32',
    ],
    BRIDGE_PREFIX: ['TOO-LONG', '../bad', '123', 'other'],
  }))
    for (const value of values)
      assert.throws(() => validateSettings({ ...base, [name]: value }), undefined, name)
})

test('development TLS and upstream overrides cannot enter production settings', () => {
  for (const name of [
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_EXTRA_CA_CERTS',
    'NODE_OPTIONS',
    'NODE_USE_SYSTEM_CA',
    'LLM_UPSTREAM_CA_FILE',
    'LLM_BACKEND_URL_OPENAI_CHATGPT',
    'LLM_AUTH_URL_OPENAI',
    'LLM_BACKEND_URL_KIMI_CODE',
    'LLM_BACKEND_URL_ZAI_CODING',
    'LLM_EGRESS_PROXY_URL',
    'LLM_CONTROL_URL',
  ])
    assert.throws(() => validateSettings({ ...base, [name]: 'injected' }))
})

test('real synthetic CA chain, matching client key and isolated AppRole pass', () => {
  const { settings, envFile } = fixture()
  assert.doesNotThrow(() => validateSecrets(settings))
  assert.equal(checkLlmPreflight(envFile).enabled, true)
})

test('the shell cannot override the checked profile or network values', () => {
  const { envFile } = fixture()
  assert.equal(
    checkLlmPreflight(envFile, { environment: { COMPOSE_PROFILES: base.COMPOSE_PROFILES } })
      .enabled,
    true,
  )
  for (const environment of [
    { COMPOSE_PROFILES: '' },
    { EGRESS_PROXY_IP: '8.8.8.8' },
    { SECRETS_DIR: '/another' },
  ])
    assert.throws(() => checkLlmPreflight(envFile, { environment }), /overrides/)
})

test('core and llm must use the same decoded PostgreSQL password and connection', () => {
  const { root, settings } = fixture()
  const llmEnv = join(root, 'llm', 'app.env')
  writeFileSync(
    llmEnv,
    dotenv(
      {
        ...secret,
        DATABASE_URL: secret.DATABASE_URL.replace('synthetic-password', '%73ynthetic-password'),
      },
      true,
    ),
  )
  assert.doesNotThrow(() => validateSecrets(settings))
  for (const database of [
    secret.DATABASE_URL.replace('synthetic-password', 'different-password'),
    secret.DATABASE_URL.replace('synthetic-password', '%ZZ'),
    secret.DATABASE_URL.replace('@postgres:', '@other:'),
    `${secret.DATABASE_URL}?host=other`,
    '',
  ]) {
    writeFileSync(join(root, 'core', 'app.env'), dotenv({ ...core, DATABASE_URL: database }, true))
    assert.throws(() => validateSecrets(settings))
  }
})

test('secret files reject extra privileges, foreign database routes and reused core identities', () => {
  for (const changes of [
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    { LLM_UPSTREAM_CA_FILE: '/untrusted' },
    { REDIS_URL: 'redis://redis' },
    { S3_SECRET_ACCESS_KEY: 'secret' },
    { DATABASE_URL: 'postgresql://postgres:password@postgres:5432/raditi' },
    { DATABASE_URL: 'postgresql://raditi:password@elsewhere:5432/raditi' },
    { DATABASE_URL: 'postgresql://raditi:password@postgres:5432/raditi?host=elsewhere' },
    { DATABASE_URL: 'postgresql://raditi@postgres:5432/raditi' },
    { VAULT_ROLE_ID: core.VAULT_ROLE_ID },
    { VAULT_SECRET_ID: core.VAULT_SECRET_ID },
    { METRICS_TOKEN: 'too-short' },
    { METRICS_TOKEN: 'another-token-that-is-at-least-thirty-two-characters' },
  ]) {
    const { root, settings } = fixture()
    writeFileSync(join(root, 'llm', 'app.env'), dotenv({ ...secret, ...changes }, true))
    assert.throws(() => validateSecrets(settings))
  }
  const { root, settings } = fixture()
  writeFileSync(
    join(root, 'core', 'app.env'),
    dotenv({ ...core, LLM_CONTROL_URL: 'http://foreign:8084' }, true),
  )
  assert.throws(() => validateSecrets(settings), /static LLM control/)
})

test('the public web service never holds the token of the private control endpoint', () => {
  const { root, settings } = fixture()
  // web is the service exposed to the Internet: with the shared token it could start account
  // probes and read the gateway metrics as soon as any route to :8084 opens.
  writeFileSync(
    join(root, 'web', 'app.env'),
    dotenv({ ...web, METRICS_TOKEN: secret.METRICS_TOKEN }, true),
  )
  assert.throws(() => validateSecrets(settings), {
    message: 'web METRICS_TOKEN must differ from the control token of core and llm',
  })
  rmSync(join(root, 'web', 'app.env'))
  assert.throws(() => validateSecrets(settings))
})

test('core and web carry a valid Vault CA of their own: llm depends on what core writes to Vault', () => {
  for (const service of ['core', 'web']) {
    const missing = fixture()
    rmSync(join(missing.root, service, 'vault-ca.pem'))
    assert.throws(() => validateSecrets(missing.settings))
    const leaf = fixture()
    cpSync(join(ca, 'clients/app-1.pem'), join(leaf.root, service, 'vault-ca.pem'))
    assert.throws(() => validateSecrets(leaf.settings), {
      message: `${service}/vault-ca.pem must contain CA certificates only`,
    })
    const expired = fixture()
    assert.throws(
      () => validateSecrets(expired.settings, { now: Date.now() + 20 * 365 * 86400_000 }),
      /expired/,
    )
  }
})

test('TLS checks reject mismatched keys, server leaves, missing intermediate, bad roots and expiry', () => {
  for (const [source, target] of [
    ['clients/other-key.pem', 'egress-client-key.pem'],
    ['server/egress-1.raditi.internal.pem', 'egress-client.pem'],
    ['clients/app-1.pem', 'egress-ca.pem'],
    ['clients/app-1.pem', 'vault-ca.pem'],
  ]) {
    const { root, settings } = fixture()
    cpSync(join(ca, source), join(root, 'llm', target))
    assert.throws(() => validateSecrets(settings))
  }
  const { root, settings } = fixture()
  const chain = readFileSync(join(root, 'llm', 'egress-client.pem'), 'utf8')
  writeFileSync(
    join(root, 'llm', 'egress-client.pem'),
    chain.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)[0],
  )
  assert.throws(() => validateSecrets(settings), /chain/)
  const valid = fixture()
  assert.throws(
    () => validateSecrets(valid.settings, { now: Date.now() + 400 * 86400_000 }),
    /expired/,
  )
  assert.throws(
    () => validateSecrets(valid.settings, { now: Date.now() - 86400_000 }),
    /not yet valid/,
  )
})

test('secret symlinks are rejected before their targets are read', () => {
  const { root, settings } = fixture()
  rmSync(join(root, 'llm', 'app.env'))
  symlinkSync(join(root, 'core', 'app.env'), join(root, 'llm', 'app.env'))
  assert.throws(() => validateSecrets(settings), /regular file/)
})

test('CLI refuses a runtime older than the pinned Node instead of exiting 0 with nothing checked', () => {
  const helper = fileURLToPath(new URL('./llm-preflight.mjs', import.meta.url))
  // Absent before Node 22.18 and 24.2: guarded by it, an older Node loaded the helper, skipped
  // every check and let preflight.sh print ok.
  const code = readFileSync(helper, 'utf8').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /import\.meta\.main/)
  const { envFile } = fixture()
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"18.19.1"})',
      helper,
      '--env-file',
      envFile,
    ],
    { encoding: 'utf8', env: { PATH: process.env.PATH } },
  )
  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'llm-preflight: Node 26 or newer is required\n')
  assert.equal(result.stdout, '')
  const link = join(directory, 'linked-preflight.mjs')
  symlinkSync(helper, link)
  for (const flags of [[], ['--preserve-symlinks', '--preserve-symlinks-main']]) {
    const linked = spawnSync(process.execPath, [...flags, link, '--env-file', envFile], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    })
    assert.equal(linked.stdout, 'llm-preflight: ok\n')
    assert.equal(linked.status, 0)
  }
})

test('CLI failures print fixed diagnostics without certificate or secret material', () => {
  const { root, envFile } = fixture()
  const marker = 'NEVER-ECHO-THIS-SECRET-MARKER'
  writeFileSync(join(root, 'llm', 'egress-client-key.pem'), marker)
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./llm-preflight.mjs', import.meta.url)), '--env-file', envFile],
    { encoding: 'utf8', env: { PATH: process.env.PATH } },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^llm-preflight: configuration or TLS validation failed\n$/)
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(marker))
})
