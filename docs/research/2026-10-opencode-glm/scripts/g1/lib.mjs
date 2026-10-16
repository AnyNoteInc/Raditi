// Host side of the G1 spike: the stand (network, fake provider) and CLI containers under `runc` or `runsc`
// with the limits of the supervisor stand (1 vCPU, 1024 MiB, 128 processes) and the mounts of the product
// sandbox (read-only root, tmpfs /workspace, /agent-home, /tmp and the secrets directory, uid 10001).
// Environment:
//   SPIKE_OUT            directory for raw outputs, absolute and outside any git checkout
//   SPIKE_DOCKER_RUNC    Docker socket for `runc` runs  (unix:///…/docker.sock)
//   SPIKE_DOCKER_RUNSC   Docker socket of the Linux VM that has the `runsc` runtime
//   SPIKE_IMAGE          image built from image/ (default raditi-oc-spike:1.18.34), present in both daemons
// Nothing here reads a key of the plan or calls a provider: the provider is fake.mjs in a container.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNoNeedles, findNeedles } from './needles.mjs'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const IMAGE = process.env.SPIKE_IMAGE ?? 'raditi-oc-spike:1.18.34'
export const SUBNET = '10.213.77.0/24'
export const FAKE_IP = '10.213.77.2'
export const GATEWAY_HOST = 'sandbox-gw'
export const HOME = '/agent-home/opencode'
export const MODEL = 'glm-5.3'
export const LIMITS = [
  '--cpus',
  '1',
  '--memory',
  '1024m',
  '--memory-swap',
  '1024m',
  '--pids-limit',
  '128',
]
const RUNTIMES = {
  runc: { socket: process.env.SPIKE_DOCKER_RUNC, flags: [] },
  runsc: { socket: process.env.SPIKE_DOCKER_RUNSC, flags: ['--runtime', 'runsc'] },
}
/** The switch-offs of the plan's network table; a run may drop or add one. */
export const HARD_ENV = {
  HOME,
  LANG: 'C.UTF-8',
  NO_COLOR: '1',
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  OPENCODE_PURE: '1',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_SHARE: '1',
}

export function outRoot() {
  const out = process.env.SPIKE_OUT
  if (!out || !isAbsolute(out))
    throw new Error('SPIKE_OUT must be an absolute directory outside the repository')
  for (let dir = resolve(out); dir !== dirname(dir); dir = dirname(dir))
    if (existsSync(join(dir, '.git')))
      throw new Error(`SPIKE_OUT is inside the git checkout ${dir}`)
  return out
}
export const sha256 = (value) => createHash('sha256').update(value).digest('hex')
/** Every credential made by this process: what the fake recorded is searched for all of them. */
const issued = {}
/** Synthetic credentials in the product's shape (apps/orchestrator/src/llm/turn-key.ts). */
export function newTokens() {
  const tokens = {
    llm: `sk-rdt-${randomBytes(32).toString('base64url')}`,
    mcp: `mcp_${randomBytes(32).toString('hex')}`,
  }
  const pair = Object.keys(issued).length / 2 + 1
  issued[`llm of pair ${pair}`] = tokens.llm
  issued[`mcp of pair ${pair}`] = tokens.mcp
  return tokens
}

export function run(command, args, { input, env, timeoutMs = 120_000 } = {}) {
  return new Promise((done) => {
    const started = Date.now()
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      done({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        ms: Date.now() - started,
      })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

// ---- provider answers in the shape Z.ai streams them (sample 23) --------------------------------
let chunkCounter = 0
let callCounter = 0
// Ids already in the placeholder form of the repository's sanitiser, so a record needs no rewriting.
const completionId = () =>
  `2026010100000000000000${(chunkCounter += 1).toString(16).padStart(8, '0')}`
export const callId = () =>
  `call_${'0'.repeat(16)}${(callCounter += 1).toString(16).padStart(8, '0')}`
export const USAGE = {
  prompt_tokens: 7105,
  completion_tokens: 94,
  total_tokens: 7199,
  prompt_tokens_details: { cached_tokens: 6784 },
  completion_tokens_details: { reasoning_tokens: 54 },
}
export function chunks({
  reasoning,
  text,
  calls,
  finish,
  usage = USAGE,
  done = true,
  model = MODEL,
}) {
  const id = completionId()
  const base = { id, created: 1767225600, object: 'chat.completion.chunk', model }
  const events = []
  if (reasoning)
    events.push({
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: reasoning } }],
    })
  if (text)
    events.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text } }] })
  for (const [index, call] of (calls ?? []).entries())
    events.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                id: callId(),
                index,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              },
            ],
          },
        },
      ],
    })
  if (finish !== null)
    events.push({
      ...base,
      choices: [
        {
          index: 0,
          finish_reason: finish ?? (calls?.length ? 'tool_calls' : 'stop'),
          delta: { role: 'assistant', content: '' },
        },
      ],
      ...(usage ? { usage } : {}),
    })
  if (done) events.push('[DONE]')
  return events
}
export const toolStep = (calls, extra = {}) => ({
  kind: 'sse',
  label: `tool:${calls.map((call) => call.name).join('+')}`,
  events: chunks({ reasoning: 'Thinking about the next tool.', calls, ...extra }),
})
export const textStep = (text, extra = {}) => ({
  kind: 'sse',
  label: 'text',
  events: chunks({ reasoning: 'Wrapping up.', text, ...extra }),
})
export const RESULT = {
  summary: 'Стендовый ход выполнен.',
  change_type: 'none',
  client_message: 'Готово. Изменений на сайте нет.',
  files_changed: [],
  questions: [],
  needs_approval: false,
  risk: 'low',
}
export const resultStep = (overrides = {}) => textStep(JSON.stringify({ ...RESULT, ...overrides }))

// ---- CLI configuration the way the driver is planned to write it (decisions 2 and 5) -----------
const RESULT_PROMPT = JSON.parse(
  readFileSync(join(HERE, '../../opencode-cli/configs/d-result.json'), 'utf8'),
).agent.raditi.prompt
export const AGENT_MARKER = 'RADITI-AGENT-PROMPT-MARKER-5527'
export const AGENTS_MARKER = 'RADITI-TURN-INSTRUCTIONS-MARKER-8841'
export function config(runId, overrides = {}) {
  const base = `http://${GATEWAY_HOST}:8080/s/${runId}`
  const value = {
    $schema: 'https://opencode.ai/config.json',
    model: `raditi/${MODEL}`,
    small_model: `raditi/${MODEL}`,
    autoupdate: false,
    share: 'disabled',
    snapshot: false,
    lsp: false,
    formatter: false,
    plugin: [],
    enabled_providers: ['raditi'],
    permission: {
      read: 'allow',
      edit: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      bash: 'allow',
      todowrite: 'allow',
      webfetch: 'deny',
      websearch: 'deny',
      task: 'deny',
      skill: 'deny',
      external_directory: 'deny',
      doom_loop: 'deny',
      question: 'deny',
      lsp: 'deny',
      'raditi_*': 'allow',
    },
    provider: {
      raditi: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Raditi gateway',
        options: { baseURL: `${base}/zai/v4`, apiKey: '{file:/run/raditi/secrets/llm}' },
        models: {
          [MODEL]: {
            name: 'GLM-5.3',
            reasoning: true,
            tool_call: true,
            interleaved: { field: 'reasoning_content' },
            limit: { context: 1_000_000, output: 131_072 },
          },
        },
      },
    },
    mcp: {
      raditi: {
        type: 'remote',
        url: `${base}/mcp`,
        enabled: true,
        oauth: false,
        timeout: 20_000,
        headers: { Authorization: 'Bearer {file:/run/raditi/secrets/mcp}' },
      },
    },
    default_agent: 'raditi',
    agent: {
      raditi: {
        mode: 'primary',
        description: 'Raditi website agent (stand)',
        prompt: `${AGENT_MARKER}\n${RESULT_PROMPT}`,
      },
    },
    experimental: { continue_loop_on_deny: true },
  }
  return typeof overrides === 'function' ? (overrides(value) ?? value) : { ...value, ...overrides }
}

// ---- the stand ---------------------------------------------------------------------------------
export class Stand {
  constructor(runtime) {
    const spec = RUNTIMES[runtime]
    if (!spec) throw new Error(`runtime must be runc or runsc, not ${runtime}`)
    if (!spec.socket) throw new Error(`SPIKE_DOCKER_${runtime.toUpperCase()} is not set`)
    this.runtime = runtime
    this.flags = spec.flags
    this.env = { DOCKER_HOST: spec.socket }
    this.network = 'raditi-oc-net'
    this.fake = `raditi-oc-fake-${runtime}`
    this.out = join(outRoot(), runtime)
    mkdirSync(this.out, { recursive: true })
  }
  docker(args, options = {}) {
    return run('docker', args, { ...options, env: this.env })
  }
  async must(args, options) {
    const result = await this.docker(args, options)
    if (result.code !== 0)
      throw new Error(
        `docker ${args.slice(0, 4).join(' ')}… failed (${result.code}): ${result.stderr.slice(0, 600)}`,
      )
    return result
  }
  async up() {
    await this.down()
    await this.must([
      'network',
      'create',
      '--internal',
      '--subnet',
      SUBNET,
      '--label',
      'raditi-oc-spike=1',
      this.network,
    ])
    await this.must([
      'run',
      '-d',
      '--name',
      this.fake,
      '--label',
      'raditi-oc-spike=1',
      '--network',
      this.network,
      '--ip',
      FAKE_IP,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '10001:10001',
      '--sysctl',
      'net.ipv4.ip_unprivileged_port_start=0',
      '-v',
      `${HERE}:/spike:ro`,
      '-e',
      `SINK_IP=${FAKE_IP}`,
      '--entrypoint',
      'node',
      IMAGE,
      '/spike/fake.mjs',
    ])
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const probe = await this.docker(['exec', this.fake, 'node', '/spike/fake.mjs', 'ctl', 'sink'])
      if (probe.code === 0) return
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(
      `the fake did not start: ${(await this.docker(['logs', this.fake])).stderr.slice(0, 800)}`,
    )
  }
  /** Removes only what carries the spike's label or name prefix. */
  async down() {
    const listed = await this.docker(['ps', '-aq', '--filter', 'label=raditi-oc-spike=1'])
    const ids = listed.stdout.split('\n').filter(Boolean)
    if (ids.length) await this.docker(['rm', '-f', '-v', ...ids])
    await this.docker(['network', 'rm', this.network])
  }
  async scenario(runId, scenario) {
    await this.must(['exec', '-i', this.fake, 'node', '/spike/fake.mjs', 'ctl', 'put', runId], {
      input: JSON.stringify(scenario),
    })
  }
  // The fake's records and the sink are what goes to the repository as samples. The fake keeps credentials
  // by hash only; that it holds none in any other place or form is checked here by value, on every read.
  async records(runId) {
    const { stdout } = await this.must([
      'exec',
      this.fake,
      'node',
      '/spike/fake.mjs',
      'ctl',
      'get',
      runId,
    ])
    assertNoNeedles(stdout, issued, `the fake's records of ${runId}`)
    return JSON.parse(stdout)
  }
  async sink() {
    const { stdout } = await this.must([
      'exec',
      this.fake,
      'node',
      '/spike/fake.mjs',
      'ctl',
      'sink',
    ])
    assertNoNeedles(stdout, issued, 'the sink')
    return JSON.parse(stdout)
  }
  /** A CLI container: `tini -- sleep infinity`, everything else by exec, as the sandbox provider does. */
  async cli(name, { dnsSink = true, extra = [], tmp = 'rw,nosuid,nodev' } = {}) {
    const container = `raditi-oc-cli-${this.runtime}-${name}`
    await this.docker(['rm', '-f', '-v', container])
    await this.must([
      'run',
      '-d',
      '--name',
      container,
      '--label',
      'raditi-oc-spike=1',
      ...this.flags,
      '--network',
      this.network,
      '--add-host',
      `${GATEWAY_HOST}:${FAKE_IP}`,
      ...(dnsSink ? ['-v', `${HERE}/resolv.conf:/etc/resolv.conf:ro`] : []),
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '10001:10001',
      ...LIMITS,
      '--tmpfs',
      '/workspace:rw,nosuid,nodev,size=512m,uid=10001,gid=10001,mode=0700',
      '--tmpfs',
      '/agent-home:rw,nosuid,nodev,size=256m,uid=10001,gid=10001,mode=0700',
      '--tmpfs',
      `/tmp:${tmp},size=64m,uid=10001,gid=10001,mode=0700`,
      '--tmpfs',
      '/run/raditi/secrets:rw,noexec,nosuid,nodev,size=64k,uid=10001,gid=10001,mode=0700',
      '-v',
      `${HERE}:/spike:ro`,
      '-w',
      '/workspace',
      '-e',
      'LANG=C.UTF-8',
      '-e',
      'HOME=/agent-home',
      ...extra,
      '--entrypoint',
      'tini',
      IMAGE,
      '--',
      'sleep',
      'infinity',
    ])
    const inspected = JSON.parse((await this.must(['inspect', container])).stdout)[0]
    return new Cli(this, name, container, {
      runtime: inspected.HostConfig.Runtime,
      ip: inspected.NetworkSettings.Networks[this.network]?.IPAddress,
    })
  }
}

export class Cli {
  constructor(stand, name, container, facts) {
    this.stand = stand
    this.name = name
    this.container = container
    this.facts = facts
    this.dir = join(stand.out, name)
    mkdirSync(this.dir, { recursive: true })
  }
  exec(args, options = {}) {
    return this.stand.docker(
      ['exec', '-i', ...(options.execFlags ?? []), this.container, ...args],
      options,
    )
  }
  async node(script, input, options) {
    const result = await this.exec(['node', `/spike/in/${script}`, ...(options?.args ?? [])], {
      input: input === undefined ? '' : JSON.stringify(input),
      ...options,
    })
    if (result.code !== 0)
      throw new Error(`${script} failed (${result.code}): ${result.stderr.slice(0, 800)}`)
    return result.stdout.trim() ? JSON.parse(result.stdout) : undefined
  }
  stage(input) {
    return this.node('stage.mjs', input)
  }
  /**
   * One turn through the wrapper. `label` names the files of this turn in the run's directory;
   * `needles` are searched in what the CLI printed and in what it left on the tmpfs mounts.
   */
  async turn({
    label = 'turn',
    prompt,
    args = [],
    env = {},
    secrets = 'fifo',
    timeoutS = 240,
    command,
    needles = {},
    mcpCheck,
    inspect = true,
    group = 'kill',
  }) {
    const wrapperEnv = Object.entries({ ...HARD_ENV, ...env }).filter(
      ([, value]) => value !== undefined,
    )
    const started = Date.now()
    const result = await this.exec(
      [
        'node',
        '/spike/wrapper.mjs',
        '--secrets',
        secrets,
        '--report',
        `/tmp/wrapper-${label}.json`,
        '--timeout',
        String(timeoutS),
        ...(mcpCheck ? ['--mcp-check', mcpCheck] : []),
        '--group',
        group,
        ...wrapperEnv.flatMap(([name, value]) => ['--env', `${name}=${value}`]),
        '--',
        ...(command ?? [
          'opencode',
          'run',
          '--format',
          'json',
          '--agent',
          'raditi',
          '--title',
          'raditi-turn',
          ...args,
        ]),
      ],
      {
        input: prompt ?? '',
        timeoutMs: (timeoutS + 30) * 1000,
        execFlags: ['-w', '/workspace/repo'],
      },
    )
    const wrapper = await this.exec(['cat', `/tmp/wrapper-${label}.json`])
    const turn = {
      label,
      startedAt: started,
      wallMs: result.ms,
      exit: result.code,
      wrapper:
        wrapper.code === 0 ? JSON.parse(wrapper.stdout) : { missing: wrapper.stderr.slice(0, 200) },
      ...summariseEvents(result.stdout),
      stderrLines: result.stderr.split('\n').filter(Boolean).length,
      stderrHead: result.stderr.slice(0, 1500),
      stderrTail: result.stderr.length > 1500 ? result.stderr.slice(-700) : '',
      outputHits: [
        ...findNeedles(Buffer.from(result.stdout), needles).map((hit) => ({
          ...hit,
          where: 'stdout',
        })),
        ...findNeedles(Buffer.from(result.stderr), needles).map((hit) => ({
          ...hit,
          where: 'stderr',
        })),
      ],
    }
    writeFileSync(join(this.dir, `${label}.stdout.txt`), result.stdout)
    writeFileSync(join(this.dir, `${label}.stderr.txt`), result.stderr)
    const cliLog = await this.exec([
      'sh',
      '-c',
      `cat ${HOME}/.local/share/opencode/log/*.log 2>/dev/null`,
    ])
    writeFileSync(join(this.dir, `${label}.opencode.log`), cliLog.stdout)
    turn.logLines = cliLog.stdout.split('\n').filter(Boolean).length
    turn.logErrors = cliLog.stdout
      .split('\n')
      .filter((line) => /^(ERROR|WARN)/.test(line))
      .map((line) => line.slice(0, 400))
    turn.outputHits.push(
      ...findNeedles(Buffer.from(cliLog.stdout), needles).map((hit) => ({
        ...hit,
        where: 'opencode.log',
      })),
    )
    if (inspect) {
      turn.left = await this.node('inspect.mjs', { needles })
      writeFileSync(join(this.dir, `${label}.left.json`), `${JSON.stringify(turn.left, null, 1)}\n`)
    }
    writeFileSync(join(this.dir, `${label}.turn.json`), `${JSON.stringify(turn, null, 1)}\n`)
    return turn
  }
  /** The two files the P1 code lists as the session state, as a tar stream. */
  async saveSession(files = ['opencode.db', 'opencode.db-wal']) {
    const result = await new Promise((done) => {
      const child = spawn(
        'docker',
        [
          'exec',
          this.container,
          'tar',
          '-C',
          `${HOME}/.local/share/opencode`,
          '-cf',
          '-',
          ...files,
        ],
        { env: { ...process.env, ...this.stand.env }, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      const parts = []
      child.stdout.on('data', (chunk) => parts.push(chunk))
      child.on('close', (code) => done({ code, tar: Buffer.concat(parts) }))
    })
    if (result.code !== 0) throw new Error('saving the session files failed')
    return result.tar
  }
  async restoreSession(tar) {
    await this.exec(['mkdir', '-p', `${HOME}/.local/share/opencode`])
    const result = await new Promise((done) => {
      const child = spawn(
        'docker',
        ['exec', '-i', this.container, 'tar', '-C', `${HOME}/.local/share/opencode`, '-xf', '-'],
        { env: { ...process.env, ...this.stand.env }, stdio: ['pipe', 'ignore', 'pipe'] },
      )
      child.on('close', (code) => done({ code }))
      child.stdin.end(tar)
    })
    if (result.code !== 0) throw new Error('restoring the session files failed')
  }
  remove() {
    return this.stand.docker(['rm', '-f', '-v', this.container])
  }
}

/** What the CLI's JSON events say, in the terms the driver will map them to. */
export function summariseEvents(stdout) {
  const events = []
  const other = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      other.push(line.slice(0, 300))
    }
  }
  const counts = {}
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1
  return {
    sessionId: events.find((event) => event.sessionID)?.sessionID,
    eventCounts: counts,
    steps: events
      .filter((event) => event.type === 'step_finish')
      .map((event) => ({ reason: event.part?.reason, tokens: event.part?.tokens })),
    tools: events
      .filter((event) => event.type === 'tool_use')
      .map((event) => ({
        tool: event.part?.tool,
        status: event.part?.state?.status,
        input: event.part?.state?.input,
        output: String(event.part?.state?.output ?? event.part?.state?.error ?? '').slice(0, 4000),
      })),
    texts: events
      .filter((event) => event.type === 'text')
      .map((event) => String(event.part?.text ?? '').slice(0, 1500)),
    errors: events.filter((event) => event.type === 'error').map((event) => event.error),
    nonJsonStdout: other,
  }
}

/** Requests of a run as the fake saw them: count, gaps between them, what they carried. */
export function summariseRecords(result) {
  const llm = result.records.filter((record) => record.kind === 'llm')
  return {
    llmRequests: llm.length,
    firstRequestMs: llm[0]?.ms,
    gapsMs: llm.slice(1).map((record, index) => record.ms - llm[index].ms),
    credentialKinds: [
      ...new Set(llm.map((record) => record.request.credentialKinds.authorization ?? 'none')),
    ],
    models: [...new Set(llm.map((record) => record.request.summary?.model))],
    statuses: llm.map((record) => record.response?.status),
    capped: llm.some((record) => record.response?.capped),
    mcp: result.records
      .filter((record) => record.kind === 'mcp')
      .map(
        (record) =>
          `${record.request.method}${record.rpc ? ` ${record.rpc}` : ''}${record.call ? ` ${record.call.name}` : ''} → ${record.response?.status ?? record.response?.failed}`,
      ),
    other: result.records
      .filter((record) => record.kind === 'other')
      .map((record) => `${record.request.method} ${record.request.path}`),
  }
}

export function save(stand, name, file, value) {
  const dir = join(stand.out, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, file),
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 1)}\n`,
  )
}
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Runs `tasks` (functions returning promises) at most `limit` at a time, results in order. */
export async function pool(tasks, limit) {
  const results = new Array(tasks.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const index = next
        next += 1
        results[index] = await tasks[index]().catch((error) => ({
          failed: String(error?.message ?? error),
        }))
      }
    }),
  )
  return results
}
