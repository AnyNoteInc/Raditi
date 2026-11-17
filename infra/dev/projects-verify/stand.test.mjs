// The pure parts of the projects stand (stand.mjs; pnpm test:infra).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { textPdf } from './scenarios.mjs'
import { hostOf } from '../browser-task-verify/stand.mjs'
import {
  BUILT_IMAGES,
  PROJECTS_BUILD,
  forwarderArgs,
  gitWorkerEnvironment,
  gvisorKernel,
  hostProbes,
  leakedIn,
  probeAnswers,
  procRemotePorts,
  projectAppEnvironment,
  projectRelays,
  projectWebEnvironment,
  scenariosToRun,
  standNames,
  standOptions,
} from './stand.mjs'

const names = standNames('0123abcd')
const context = {
  run: '0123abcd',
  path: '/usr/bin',
  directory: '/tmp/run',
  ports: {
    vault: 41001,
    s3: 41002,
    web: 41004,
    core: 41005,
    mcp: 41006,
    llm: 41007,
    pages: 41008,
    zai: 41011,
    gitlab: 41012,
  },
  databaseUrl: 'postgresql://raditi:x@127.0.0.1:5432/raditi',
  redisUrl: 'redis://default:x@127.0.0.1:6379',
  vault: { address: 'http://127.0.0.1:41001' },
  roles: Object.fromEntries(
    ['core', 'mcp', 'llm', 'web'].map((name) => [
      name,
      { roleId: `r-${name}`, secretId: `s-${name}` },
    ]),
  ),
  s3: { endpoint: 'http://127.0.0.1:41002', accessKey: 'access', secretKey: 'secret' },
  secrets: {
    metrics: 'metrics-token',
    auth: 'auth-secret',
    workerToken: 'w',
    pagesCookie: 'c',
    pagesSigning: 'p',
  },
  caFile: '/tmp/run/ca.pem',
  socket: '/var/run/docker.sock',
  images: { sandbox: 'a@sha256:1', gateway: 'b@sha256:2', guard: 'c@sha256:3' },
  git: {
    mirrorDir: '/tmp/run/mirrors',
    fakePort: 41012,
    oauth: { clientId: 'client', secret: 'client-secret' },
    confirmSecret: 'confirm-secret-of-the-stand',
    github: {
      origin: 'https://localhost:41013',
      appId: '4242',
      keyFile: '/tmp/run/github-app.pem',
      slug: 'raditi-stand',
      clientId: 'gh-client',
      clientSecret: 'gh-client-secret',
      webhookSecret: 'gh-webhook-secret',
    },
  },
}

describe('projects stand', () => {
  it('takes only its own options', () => {
    assert.deepEqual(standOptions(['--', '--no-build', '--only', 'E']), {
      build: false,
      keep: false,
      webDev: false,
      only: ['E'],
      runtime: 'runc',
    })
    assert.equal(standOptions(['--runtime=runsc']).runtime, 'runsc')
    assert.throws(() => standOptions(['--runtime=kata']), /runc or runsc/)
    assert.throws(() => standOptions(['--database', 'x']))
    assert.throws(() => standOptions(['--only', 'Z']))
  })

  it('runs a scenario with what it needs first', () => {
    assert.deepEqual(scenariosToRun(['I']), ['S', 'A', 'K', 'E', 'F', 'H', 'I'])
    assert.deepEqual(scenariosToRun(['M']), ['S', 'A', 'M'])
    assert.deepEqual(scenariosToRun(['L']), ['S', 'A', 'K', 'E', 'L'])
    assert.deepEqual(scenariosToRun(['P']), ['S', 'A', 'P'])
    assert.deepEqual(scenariosToRun(['W']), ['S', 'A', 'K', 'E', 'F', 'H', 'I', 'W'])
  })

  it('builds under names of its own', () => {
    assert.equal(PROJECTS_BUILD.own, 'infra/dev/projects-verify/')
    assert.deepEqual(Object.keys(BUILT_IMAGES), ['sandbox', 'gateway', 'guard'])
    for (const image of Object.values(BUILT_IMAGES))
      assert.match(image.tag, /^raditi-projects-verify\//)
    assert.equal(names.containers.forwarder, 'raditi-projects-verify-0123abcd-forwarder')
  })

  it('gives core the git of projects and no browser', () => {
    const core = projectAppEnvironment('core', context)
    assert.equal(core.BROWSER_WORKER_URL, undefined)
    assert.equal(core.GIT_MIRROR_DIR, '/tmp/run/mirrors')
    assert.equal(core.GIT_ALLOW_LOOPBACK, '1')
    assert.equal(core.GIT_CA_FILE, '/tmp/run/ca.pem')
    assert.equal(core.RADITI_FAKE_GITLAB_COM_URL, 'https://localhost:41012')
    assert.equal(core.REPO_CONFIRM_SECRET, 'confirm-secret-of-the-stand')
    assert.equal(core.SANDBOX_DEPLOYMENT, 'projects-verify-0123abcd')
    assert.equal(core.NODE_ENV, 'production')
    // Hooks of GitLab projects are made for an https APP_URL only; web keeps its own address.
    assert.match(core.APP_URL, /^https:\/\/[^/]+$/)
    assert.equal(core.GITHUB_APP_ID, '4242')
    assert.equal(core.GITHUB_APP_PRIVATE_KEY_FILE, '/tmp/run/github-app.pem')
    assert.equal(core.RADITI_FAKE_GITHUB_API_URL, 'https://localhost:41013')
    assert.equal(core.GITHUB_APP_CLIENT_SECRET, undefined)
    const mcp = projectAppEnvironment('mcp', context)
    assert.equal(mcp.BROWSER_WORKER_URL, undefined)
    assert.equal(mcp.GIT_CA_FILE, undefined)
  })

  it('gives the git worker its volume only, and web the fake with its CA', () => {
    const worker = gitWorkerEnvironment(context)
    assert.deepEqual(Object.keys(worker).sort(), [
      'APP_ENV',
      'GIT_ALLOW_LOOPBACK',
      'GIT_CA_FILE',
      'GIT_MIRROR_DIR',
      'HOME',
      'NODE_ENV',
      'NO_COLOR',
      'PATH',
      'TMPDIR',
    ])
    const web = projectWebEnvironment(context)
    assert.equal(web.BROWSER_STREAM_PUBLIC_URL, undefined)
    assert.equal(web.GIT_CA_FILE, undefined)
    assert.equal(web.NODE_EXTRA_CA_CERTS, '/tmp/run/ca.pem')
    assert.equal(web.GITLAB_OAUTH_CLIENT_SECRET, 'client-secret')
    assert.equal(web.APP_URL, 'http://127.0.0.1:41004')
    assert.equal(web.GITHUB_APP_SLUG, 'raditi-stand')
    assert.equal(web.GITHUB_APP_WEBHOOK_SECRET, 'gh-webhook-secret')
    assert.equal(web.RADITI_FAKE_GITHUB_WEB_URL, 'https://localhost:41013')
    assert.equal(web.RADITI_FAKE_GITHUB_API_URL, 'https://localhost:41013')
    assert.equal(web.GITHUB_APP_PRIVATE_KEY_FILE, undefined)
  })

  it('forwards 443 of loopback only, read-only, without capabilities', () => {
    const args = forwarderArgs({ names, image: 'b@sha256:2', fakePort: 41012 })
    assert.ok(args.includes('127.0.0.1:443:8443') && args.includes('[::1]:443:8443'))
    assert.ok(!args.some((arg) => /^0\.0\.0\.0|^443:/.test(arg)))
    assert.ok(args.includes('--read-only') && args.includes('ALL'))
    assert.ok(args.at(-1).includes('41012'))
    assert.ok(args.at(-1).includes("'host.docker.internal'") && !args.includes('--add-host'))
    assert.throws(() => forwarderArgs({ names, image: 'x', fakePort: 80 }))
  })

  const linux = hostOf({
    operatingSystem: 'Ubuntu 24.04.3 LTS',
    bridgeGateway: '172.17.0.1',
    hostGateway: '172.17.0.1',
  })
  const vm = hostOf({
    operatingSystem: 'Ubuntu 24.04.4 LTS',
    bridgeGateway: '172.17.0.1',
    hostGateway: '192.168.5.2',
  })

  it('forwards on Linux and in a VM with no more privilege, to the relay of the fake', () => {
    for (const host of [linux, vm]) {
      const args = forwarderArgs({ names, image: 'b@sha256:2', fakePort: 41012, host })
      // The same container as on Docker Desktop: default bridge, loopback, read-only, no capability.
      assert.ok(args.includes('127.0.0.1:443:8443') && args.includes('[::1]:443:8443'))
      assert.ok(args.includes('--read-only') && args.includes('ALL'))
      assert.ok(!args.some((arg) => /^--network|^--cap-add|^--privileged|^--user/.test(arg)))
    }
    const onLinux = forwarderArgs({ names, image: 'b@sha256:2', fakePort: 41012, host: linux })
    assert.equal(onLinux[onLinux.indexOf('--add-host') + 1], 'host.docker.internal:host-gateway')
    assert.ok(onLinux.at(-1).includes("net.connect(41012, 'host.docker.internal')"))
    const inVm = forwarderArgs({ names, image: 'b@sha256:2', fakePort: 41012, host: vm })
    assert.ok(!inVm.includes('--add-host'))
    assert.ok(inVm.at(-1).includes("net.connect(41012, '172.17.0.1')"))
  })

  it('relays llm, mcp and the fake GitLab off Docker Desktop, and probes them from the sandbox', () => {
    assert.deepEqual(
      projectRelays(linux, context.ports).map((relay) => [relay.role, relay.listen, relay.port]),
      [
        ['llm', '172.17.0.1', 41007],
        ['mcp', '172.17.0.1', 41006],
        ['gitlab', '172.17.0.1', 41012],
      ],
    )
    const desktop = hostOf({
      operatingSystem: 'Docker Desktop',
      bridgeGateway: '172.17.0.1',
      hostGateway: '192.168.65.254',
    })
    assert.deepEqual(projectRelays(desktop, context.ports), [])
    // Every address the host has for containers, at every port the stand opens.
    assert.deepEqual(hostProbes(vm, context.ports), [
      '192.168.5.2:41007',
      '192.168.5.2:41006',
      '192.168.5.2:41012',
      '172.17.0.1:41007',
      '172.17.0.1:41006',
      '172.17.0.1:41012',
    ])
    assert.equal(hostProbes(linux, context.ports).length, 3)
    assert.equal(hostProbes(desktop, context.ports).length, 6)
    assert.deepEqual(
      probeAnswers(
        'push=128\nprobe sandbox-gw:8080=0\nprobe 172.17.0.1:41007=124\nprobe 172.17.0.1:41006=1\n',
      ),
      { 'sandbox-gw:8080': '0', '172.17.0.1:41007': '124', '172.17.0.1:41006': '1' },
    )
  })

  it('runs the sandbox of a turn under the runtime of the run, at the host of the run', () => {
    const core = projectAppEnvironment('core', { ...context, host: vm, runtime: 'runsc' })
    assert.equal(core.SANDBOX_RUNTIME, 'runsc')
    assert.equal(core.SANDBOX_LLM_UPSTREAM, 'http://172.17.0.1:41007')
    assert.equal(projectAppEnvironment('core', context).SANDBOX_RUNTIME, 'runc')
    assert.equal(
      projectAppEnvironment('mcp', { ...context, host: vm }).MCP_ALLOWED_HOSTS,
      'host.docker.internal,172.17.0.1',
    )
  })

  it('tells the kernel of gVisor from the kernel of a machine', () => {
    assert.equal(gvisorKernel('4.19.0-gvisor'), true)
    assert.equal(gvisorKernel('4.4.0'), true)
    for (const release of ['6.8.0-117-generic', '7.0.14-linuxkit', undefined])
      assert.equal(gvisorKernel(release), false, release)
  })

  it('reads the remote ports of a process from the TCP tables of Linux', () => {
    const table = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:A1B2 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0000000000000000 100 0 0 10 0',
      '   1: 0100007F:C3D4 0100007F:1538 01 00000000:00000000 00:00000000 00000000  1000        0 222 1 0000000000000000 20 4 30 10 -1',
      '   2: 0100007F:C3D5 0100007F:18EB 01 00000000:00000000 00:00000000 00000000  1000        0 333 1 0000000000000000 20 4 30 10 -1',
    ].join('\n')
    const v6 = [
      '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000000000000000000001000000:E000 00000000000000000000000001000000:0050 01 00000000:00000000 00:00000000 00000000  1000        0 444 1 0000000000000000 20 4 30 10 -1',
    ].join('\n')
    // The listening socket (111) has no remote port; 333 is another process's.
    assert.deepEqual(procRemotePorts([table, v6], new Set(['111', '222', '444'])), ['5432', '80'])
  })

  it('finds a leaked secret by its name, never a short one', () => {
    assert.deepEqual(leakedIn('a glpat-1234567 b', { token: 'glpat-1234567', short: 'ab' }), [
      'token',
    ])
  })

  it('writes a PDF whose cross-reference table points at its objects', () => {
    const pdf = textPdf('Price list 42').toString('latin1')
    const start = Number(/startxref\n(\d+)/.exec(pdf)[1])
    assert.ok(pdf.slice(start).startsWith('xref'))
    const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]))
    offsets.forEach((offset, index) =>
      assert.ok(pdf.slice(offset).startsWith(`${index + 1} 0 obj`)),
    )
  })
})
