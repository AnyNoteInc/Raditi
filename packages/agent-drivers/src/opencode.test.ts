import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

import {
  preparedRunExposesSecret,
  preparedRunSchema,
  SANDBOX_INBOX,
  SANDBOX_SECRETS_DIR,
  turnCredentials,
  turnInputSchema,
  type PreparedRun,
  type RunContext,
} from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createOpencodeDriver } from './opencode.ts'
import { RESULT_CONTRACT } from './output-schema.ts'

const driver = createOpencodeDriver({ image: `raditi/sbx-wordpress@sha256:${'a'.repeat(64)}` })
const context: RunContext = {
  taskId: 'task',
  sessionId: 'session',
  turn: 1,
  llm: {
    baseUrl: 'http://sandbox-gw:8080/zai/v4',
    apiKey: 'synthetic-llm-token',
    model: 'glm-5.3',
    reasoningEffort: 'high',
  },
  mcp: { url: 'http://sandbox-gw:8080/mcp', token: 'synthetic-mcp-token' },
  instructions:
    'Пишите клиенту по-русски. Не меняйте файлы CI. Literal {env:HOME} and {file:/etc/passwd}.',
}
const input = { prompt: 'Поменяйте заголовок', attachments: [] }
const nativeSessionId = 'ses_00000000000000000000000001'
const home = '/agent-home/opencode'
const file = (run: PreparedRun, name: string) =>
  run.files.find((entry) => entry.path === `${home}/${name}`)!.content
const args = (run: PreparedRun): string[] => JSON.parse(file(run, 'cli-args.json'))
/** The parts of the CLI configuration the tests read by name. */
interface CliConfig {
  model: string
  small_model: string
  default_agent: string
  enabled_providers: string[]
  provider: unknown
  mcp: unknown
  agent: Record<string, { mode: string; prompt: string }>
  permission: Record<string, unknown> & { external_directory: Record<string, string> }
}
const config = (run: PreparedRun) =>
  JSON.parse(file(run, '.config/opencode/opencode.json')) as CliConfig
/** A JSON-RPC request as the stand-in MCP endpoint reads it. */
interface RpcRequest {
  id?: number
  method?: string
  params: { protocolVersion?: string }
}
type McpAnswer = (
  request: IncomingMessage,
  body: RpcRequest,
) => { status: number; type?: string; body: string }
const substitutions = (text: string) => [...text.matchAll(/\{(?:env|file):[^}]*\}/g)].map(String)

describe('OpenCode driver: prepared files and argv', () => {
  it('keeps both credentials in tmpfs files that the configuration names as one-shot files', async () => {
    const run = await driver.prepare(context)
    const argv = driver.command(run, input)
    expect(preparedRunSchema.parse(run)).toEqual(run)
    expect(argv).toEqual(['node', `${home}/run.mjs`])
    expect(run.secrets).toEqual([
      { path: `${SANDBOX_SECRETS_DIR}/llm`, content: context.llm.apiKey, mode: 0o400 },
      { path: `${SANDBOX_SECRETS_DIR}/mcp`, content: context.mcp.token, mode: 0o400 },
    ])
    expect(preparedRunExposesSecret(run, turnCredentials(context, run.secrets), argv)).toBe(false)
    expect(run.env).toEqual({ HOME: home, NO_COLOR: '1' })
    expect(run.files.every((entry) => entry.mode === 0o600)).toBe(true)
    expect(run.files.every((entry) => entry.path.startsWith(`${home}/`))).toBe(true)
    expect(run.files.some((entry) => /auth\.json|credential/.test(entry.path))).toBe(false)
    expect(run.files.map((entry) => entry.path.slice(home.length + 1)).sort()).toEqual([
      '.config/opencode/AGENTS.md',
      '.config/opencode/opencode.json',
      'cli-args.json',
      'io-config/opencode/opencode.json',
      'prompt.txt',
      'run.mjs',
    ])
    // The only references the CLI substitutes: each names a file the wrapper turns into a pipe.
    expect(substitutions(file(run, '.config/opencode/opencode.json')).sort()).toEqual([
      `{file:${SANDBOX_SECRETS_DIR}/llm}`,
      `{file:${SANDBOX_SECRETS_DIR}/mcp}`,
    ])
    for (const entry of run.files)
      if (!entry.path.endsWith('/opencode/opencode.json') && !entry.path.endsWith('AGENTS.md'))
        expect(substitutions(entry.content), entry.path).toEqual([])
  })

  it('pins the provider, the model, the MCP server and the agent of the platform', async () => {
    const value = config(await driver.prepare(context))
    expect(value.model).toBe('raditi/glm-5.3')
    expect(value.small_model).toBe('raditi/glm-5.3')
    expect(value.default_agent).toBe('raditi')
    expect(value.enabled_providers).toEqual(['raditi'])
    expect(value.provider).toEqual({
      raditi: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Raditi',
        options: { baseURL: context.llm.baseUrl, apiKey: `{file:${SANDBOX_SECRETS_DIR}/llm}` },
        models: {
          'glm-5.3': {
            name: 'glm-5.3',
            reasoning: true,
            tool_call: true,
            interleaved: { field: 'reasoning_content' },
            limit: { context: 1_000_000, output: 131_072 },
          },
        },
      },
    })
    expect(value.mcp).toEqual({
      raditi: {
        type: 'remote',
        url: context.mcp.url,
        enabled: true,
        oauth: false,
        timeout: 60_000,
        headers: { Authorization: `Bearer {file:${SANDBOX_SECRETS_DIR}/mcp}` },
      },
    })
    expect(value.agent.raditi!.mode).toBe('primary')
    expect(value.agent.raditi!.prompt).toContain(RESULT_CONTRACT)
    expect(value.agent.raditi!.prompt).toContain(`${home}/.config/opencode/AGENTS.md`)
    expect(Object.keys(value.agent)).toEqual(['raditi'])
  })

  it('switches off what would reach the network and allows or denies every tool outright', async () => {
    const value = config(await driver.prepare(context))
    expect(value).toMatchObject({
      autoupdate: false,
      share: 'disabled',
      snapshot: false,
      lsp: false,
      formatter: false,
      plugin: [],
      experimental: { continue_loop_on_deny: true },
    })
    expect(value.permission).toEqual({
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
      question: 'deny',
      lsp: 'deny',
      doom_loop: 'deny',
      external_directory: { '*': 'deny', [`${SANDBOX_INBOX}/*`]: 'allow' },
      'raditi_*': 'allow',
    })
    // The last matching rule wins: the inbox exception must come after the general denial.
    expect(Object.keys(value.permission.external_directory)).toEqual(['*', `${SANDBOX_INBOX}/*`])
    // An `ask` rule is rejected automatically in `run` mode and may end the turn with exit 0.
    const leaves = (node: unknown): unknown[] =>
      node !== null && typeof node === 'object' ? Object.values(node).flatMap(leaves) : [node]
    expect(leaves(value.permission).every((rule) => rule === 'allow' || rule === 'deny')).toBe(true)
    expect(leaves(value)).not.toContain('ask')
    // The reasoning level belongs to the gateway (the profile of the turn key), not to the CLI.
    const text = file(await driver.prepare(context), '.config/opencode/opencode.json')
    expect(text).not.toMatch(/reasoning_effort|variant|thinking|"high"/)
  })

  it('gives the platform MCP server the one name its events parser takes off a tool', async () => {
    const value = config(await driver.prepare(context))
    const servers = Object.keys(value.mcp as Record<string, unknown>)
    expect(servers).toHaveLength(1)
    const [server] = servers
    // The CLI rewrites every other character of a server name before it prefixes a tool with it.
    expect(server).toMatch(/^[A-Za-z0-9-]+$/)
    expect(value.permission[`${server}_*`]).toBe('allow')
    const row = (tool: string) =>
      JSON.stringify({
        type: 'tool_use',
        part: { type: 'tool', tool, state: { status: 'completed', input: {} } },
      })
    expect(driver.parseEvent(row(`${server}_site_info`))).toEqual([
      { type: 'tool_call', tool: 'site_info', ok: true },
    ])
    expect(driver.parseEvent(row(`${server}site_info`))).toEqual([
      { type: 'tool_call', tool: `${server}site_info`, ok: true },
    ])
  })

  it('gives export and import a configuration with no provider, no MCP server and no secret', async () => {
    const run = await driver.prepare({ ...context, nativeSessionId })
    const text = file(run, 'io-config/opencode/opencode.json')
    expect(JSON.parse(text)).toEqual({
      autoupdate: false,
      share: 'disabled',
      snapshot: false,
      lsp: false,
      formatter: false,
      plugin: [],
      enabled_providers: [],
    })
    expect(substitutions(text)).toEqual([])
    expect(text).not.toContain('sandbox-gw')
  })

  it('keeps the instructions of the turn in their own file, outside the substituted text', async () => {
    const run = await driver.prepare(context)
    expect(file(run, '.config/opencode/AGENTS.md')).toBe(context.instructions)
    const text = file(run, '.config/opencode/opencode.json')
    expect(text).not.toContain('{env:HOME}')
    expect(text).not.toContain('/etc/passwd')
    expect(text).not.toContain('Не меняйте файлы CI')
  })

  it.each([
    ['the model', { llm: { ...context.llm, model: 'glm-{env:HOME}' } }],
    ['the model', { llm: { ...context.llm, model: '{file:/run/raditi/secrets/mcp}' } }],
    ['the model', { llm: { ...context.llm, model: 'glm}' } }],
    ['the gateway address', { llm: { ...context.llm, baseUrl: 'http://sandbox-gw:8080/{env:X}' } }],
    ['the MCP address', { mcp: { ...context.mcp, url: 'http://sandbox-gw:8080/{file:/x}' } }],
  ])(
    'refuses a brace in %s: the CLI substitutes references in its configuration',
    async (_, part) => {
      await expect(driver.prepare({ ...context, ...part })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
    },
  )

  it('starts a session with the platform agent and resumes the recorded one', async () => {
    const fresh = await driver.prepare(context)
    driver.command(fresh, input)
    const base = [
      'run',
      '--format',
      'json',
      '--agent',
      'raditi',
      '--model',
      'raditi/glm-5.3',
      '--title',
      'raditi-turn',
      '--print-logs',
      '--log-level',
      'WARN',
    ]
    expect(args(fresh)).toEqual(base)
    const resumed = await driver.prepare({
      ...context,
      nativeSessionId,
      instructions: 'Updated platform instruction',
      llm: { ...context.llm, reasoningEffort: 'max' },
    })
    driver.command(resumed, input)
    expect(args(resumed)).toEqual([...base, '--session', nativeSessionId])
    // The CLI builds its system prompt from the files again on every request.
    expect(file(resumed, '.config/opencode/AGENTS.md')).toBe('Updated platform instruction')
    for (const run of [fresh, resumed]) {
      for (const flag of ['--variant', '--continue', '-c', '--fork', '--auto', '--dir', '--share'])
        expect(args(run)).not.toContain(flag)
      expect(args(run).join(' ')).not.toMatch(/high|max|low/)
    }
    // The wrapper carries the session over: only a resumed run names it.
    expect(file(fresh, 'run.mjs')).toContain('"session":null')
    expect(file(resumed, 'run.mjs')).toContain(`"session":"${nativeSessionId}"`)
  })

  it('accepts a plan without a reasoning profile but launches only with one', async () => {
    const { reasoningEffort: _effort, ...llm } = context.llm
    for (const profile of [{}, { reasoningEffort: null }]) {
      const run = await driver.prepare({ ...context, llm: { ...llm, ...profile } })
      expect(driver.sessionState(run).include.length).toBeGreaterThan(0)
      expect(() => driver.command(run, input)).toThrow(
        'OpenCode requires an explicit reasoning profile before launch',
      )
    }
    for (const reasoningEffort of ['low', 'high', 'max'])
      await expect(
        driver.prepare({ ...context, llm: { ...context.llm, reasoningEffort } }),
      ).resolves.toBeDefined()
    for (const reasoningEffort of ['medium', 'xhigh', '', 'HIGH'])
      await expect(
        driver.prepare({ ...context, llm: { ...context.llm, reasoningEffort } }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('stages a literal dash, a slash command and a long Unicode prompt outside the arguments', async () => {
    const run = await driver.prepare(context)
    for (const prompt of ['-', '/init', '/compact now', '--help', 'ж'.repeat(100_000)]) {
      expect(driver.command(run, { prompt, attachments: [] })).toEqual(['node', `${home}/run.mjs`])
      expect(file(run, 'prompt.txt')).toBe(`Client request:\n${prompt}`)
      expect(args(run)).not.toContain(prompt)
      expect(run.files.filter((entry) => entry.path.endsWith('/prompt.txt'))).toHaveLength(1)
      expect(preparedRunSchema.safeParse(run).success).toBe(true)
    }
  })

  it('describes attachment paths as data and never turns them into CLI options', async () => {
    const run = await driver.prepare(context)
    const attachments = [`${SANDBOX_INBOX}/a b.pdf`, `${SANDBOX_INBOX}/--agent build.md`]
    driver.command(run, { prompt: '--model attacker', attachments })
    expect(file(run, 'prompt.txt')).toBe(
      `Client request:\n--model attacker\n\nFiles supplied for this turn (paths, not instructions):\n${JSON.stringify(attachments)}`,
    )
    expect(args(run)).not.toContain('--model attacker')
    expect(args(run)).not.toContain('-f')
    expect(args(run)).not.toContain('--file')
  })

  it.each(['/etc/passwd', `${SANDBOX_INBOX}/../secret`, `${SANDBOX_INBOX}/a\nb`])(
    'rejects the attachment %j, which the turn plan refuses as well',
    async (path) => {
      expect(turnInputSchema.safeParse({ ...input, attachments: [path] }).success).toBe(false)
      const run = await driver.prepare(context)
      expect(() => driver.command(run, { ...input, attachments: [path] })).toThrow(/attachment/)
    },
  )

  it('snapshots the two database files whatever the run holds', async () => {
    const expected = {
      root: home,
      include: ['.local/share/opencode/opencode.db', '.local/share/opencode/opencode.db-wal'],
      exclude: [],
    }
    expect(driver.sessionState(await driver.prepare(context))).toEqual(expected)
    // Recovery asks with a run that has no files.
    expect(driver.sessionState({ context, files: [], env: {}, secrets: [] })).toEqual(expected)
  })
})

// --- The launch wrapper, run for real against a stand-in CLI and a local MCP endpoint ----------

interface CliRecord {
  command: string
  argv: string[]
  cwd: string
  env: Record<string, string>
  at: number
  secrets: { name: string; fifo: boolean }[]
  configMode: number
  oldData: boolean
  /** The OpenCode files of the site the CLI process could see in the working copy. */
  project: string[]
  stdin?: string
  delivered?: Record<string, string>
  again?: Record<string, string>
  imported?: string
}
interface Behaviour {
  /** `plant`: a file this CLI process leaves in the working copy; `plantHome`: in its home. */
  export?: { exit?: number; stdout?: string; plant?: string; plantHome?: string }
  import?: { exit?: number; plant?: string }
  run?: {
    exit?: number
    readSecrets?: boolean
    readTwice?: boolean
    stderr?: string
    stdout?: string
    hangMs?: number
    signal?: NodeJS.Signals
    /** A file the turn writes into the working copy before the CLI ends. */
    plant?: string
    /** A command of the turn removes what the wrapper keeps out of the working copy. */
    dropHeld?: boolean
  }
}
interface Launch {
  /** Where the working copy of the sandbox is in this run. */
  repo: string
  code: number | null
  stdout: string
  stderr: string
  ms: number
  records: CliRecord[]
  left: {
    secrets: string[]
    home: string[]
    configMode: number
    exportFile: boolean
    /** The working copy and the directory above it, after the wrapper ended. */
    repo: string[]
    aboveRepo: string[]
  }
}
const PROJECT_FILES = ['.opencode', 'opencode.json', 'opencode.jsonc']

const WARN_LINE =
  'timestamp=2026-10-05T07:39:41.603Z level=WARN run=8ece3ed8 message="server unavailable" key=raditi type=remote status=failed\n'

// Every launch starts real processes, and a loaded macOS at times takes about three seconds to
// start the stand-in CLI: a test with two launches then outlives the default five seconds.
describe('OpenCode driver: the launch wrapper', { timeout: 30_000 }, () => {
  let server: Server
  let mcpUrl: string
  /** How the stand-in MCP endpoint answers `initialize`; each test sets it. */
  let mcpAnswer: McpAnswer
  const mcpRequests: { at: number; authorization?: string; method?: string; body: RpcRequest }[] =
    []
  const accept: McpAnswer = (_, body) => ({
    status: 200,
    type: 'application/json',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      result: { protocolVersion: body.params.protocolVersion, capabilities: {}, serverInfo: {} },
    }),
  })

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || 'null') as RpcRequest
        mcpRequests.push({
          at: Date.now(),
          authorization: request.headers.authorization,
          method: body?.method,
          body,
        })
        const answer = mcpAnswer(request, body)
        response
          .writeHead(answer.status, answer.type ? { 'content-type': answer.type } : {})
          .end(answer.body)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    mcpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  /**
   * Writes the prepared run into a private directory, with the sandbox paths moved there and a
   * stand-in for the CLI binary, and runs the wrapper the way the sandbox does: `node run.mjs`
   * in the working copy, with an environment the CLI must not inherit.
   */
  async function launch(
    turn: { session?: string; prompt?: string } = {},
    behaviour: Behaviour = {},
    before?: (paths: { home: string; secrets: string; repo: string }) => Promise<void>,
  ): Promise<Launch> {
    mcpRequests.length = 0
    const run = await driver.prepare({
      ...context,
      mcp: { ...context.mcp, url: mcpUrl },
      ...(turn.session ? { nativeSessionId: turn.session } : {}),
    })
    driver.command(run, { prompt: turn.prompt ?? input.prompt, attachments: [] })
    const directory = await mkdtemp(join(tmpdir(), 'raditi-opencode-wrapper-'))
    const paths = {
      home: join(directory, 'home'),
      secrets: join(directory, 'secrets'),
      repo: join(directory, 'repo'),
      cli: join(directory, 'opencode'),
    }
    try {
      const local = (value: string) =>
        value
          .replaceAll(home, paths.home)
          .replaceAll(SANDBOX_SECRETS_DIR, paths.secrets)
          .replaceAll('/usr/local/bin/opencode', paths.cli)
          .replaceAll('/workspace/repo', paths.repo)
          // The directory above the working copy, where the wrapper names it by itself.
          .replaceAll('"/workspace"', JSON.stringify(directory))
      await mkdir(paths.repo, { recursive: true })
      for (const entry of [...run.files, ...run.secrets]) {
        const path = local(entry.path)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, local(entry.content), { mode: entry.mode })
      }
      await before?.(paths)
      await writeFile(join(directory, 'behaviour.json'), JSON.stringify(behaviour))
      // The stand-in reads the configuration the way the CLI does: each {file:…} reference once.
      await writeFile(
        paths.cli,
        `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const behaviour = JSON.parse(fs.readFileSync(${JSON.stringify(join(directory, 'behaviour.json'))}, 'utf8'));
const [command, ...rest] = process.argv.slice(2);
const configHome = process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME, '.config');
const record = {
  command, argv: process.argv.slice(2), cwd: process.cwd(), env: { ...process.env }, at: Date.now(),
  secrets: fs.readdirSync(${JSON.stringify(paths.secrets)}).map((name) => ({ name, fifo: fs.statSync(path.join(${JSON.stringify(paths.secrets)}, name)).isFIFO() })),
  configMode: fs.statSync(path.join(configHome, 'opencode')).mode & 0o777,
  oldData: fs.existsSync(path.join(process.env.HOME, '.local/share/opencode/old-session')) || fs.existsSync(path.join(process.env.HOME, '.cache/old-cache')),
  project: ${JSON.stringify(PROJECT_FILES)}.filter((name) => fs.existsSync(path.join(process.cwd(), name))),
};
const save = () => fs.appendFileSync(${JSON.stringify(join(directory, 'records.jsonl'))}, JSON.stringify(record) + '\\n');
const step = behaviour[command] ?? {};
if (command !== 'run' && step.plant) fs.writeFileSync(path.join(process.cwd(), step.plant), 'left by ' + command);
if (step.plantHome) { fs.mkdirSync(path.dirname(path.join(process.env.HOME, step.plantHome)), { recursive: true }); fs.writeFileSync(path.join(process.env.HOME, step.plantHome), 'left by ' + command); }
if (command === 'export') { save(); process.stdout.write(step.stdout ?? ''); process.exit(step.exit ?? 0); }
if (command === 'import') { record.imported = fs.readFileSync(rest[0], 'utf8'); fs.mkdirSync(path.join(process.env.HOME, '.local/share/opencode'), { recursive: true }); fs.writeFileSync(path.join(process.env.HOME, '.local/share/opencode/opencode.db'), 'imported'); save(); process.exit(step.exit ?? 0); }
record.stdin = fs.readFileSync(0, 'utf8');
const refs = [...fs.readFileSync(path.join(configHome, 'opencode/opencode.json'), 'utf8').matchAll(/\\{file:([^}]+)\\}/g)].map((match) => match[1]);
const read = () => Object.fromEntries(refs.map((ref) => { try { return [path.basename(ref), fs.readFileSync(ref, 'utf8')]; } catch (error) { return [path.basename(ref), 'ERROR ' + error.code]; } }));
if (step.readSecrets !== false) record.delivered = read();
if (step.readTwice) record.again = read();
save();
if (step.stderr) process.stderr.write(step.stderr);
if (step.stdout) process.stdout.write(step.stdout);
if (step.plant) fs.writeFileSync(path.join(process.cwd(), step.plant), 'written by the turn');
if (step.dropHeld) fs.rmSync(path.join(process.cwd(), '..', '.raditi-opencode-held'), { recursive: true });
const end = () => { if (step.signal) process.kill(process.pid, step.signal); else process.exit(step.exit ?? 0); };
if (step.hangMs) setTimeout(end, step.hangMs); else end();
`,
        { mode: 0o700 },
      )
      const started = Date.now()
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(process.execPath, [join(paths.home, 'run.mjs')], {
            cwd: paths.repo,
            env: {
              PATH: process.env.PATH,
              HOME: '/nonexistent',
              OPENCODE_CONFIG_CONTENT: '{"model":"hostile/model"}',
              OPENCODE_PERMISSION: '{"webfetch":"allow"}',
              BUN_CRASH_REPORT_URL: 'http://crash.invalid',
              BUN_ENABLE_CRASH_REPORTING: '1',
              RADITI_AMBIENT_VALUE: 'must-not-be-inherited',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          let stdout = ''
          let stderr = ''
          child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
          child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
          const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
          child.on('error', reject)
          child.on('close', (code) => {
            clearTimeout(timer)
            resolve({ code, stdout, stderr })
          })
        },
      )
      const records = (await readFile(join(directory, 'records.jsonl'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CliRecord)
      return {
        ...result,
        repo: paths.repo,
        ms: Date.now() - started,
        records,
        left: {
          secrets: await readdir(paths.secrets),
          home: await readdir(paths.home),
          configMode: (await stat(join(paths.home, '.config/opencode'))).mode & 0o777,
          exportFile: (await readdir(paths.home)).some((name) => name.includes('export')),
          repo: (await readdir(paths.repo, { recursive: true })).sort(),
          aboveRepo: (await readdir(directory)).sort(),
        },
      }
    } finally {
      // The wrapper may have left the configuration read-only when it was killed.
      await chmod(join(paths.home, '.config/opencode'), 0o700).catch(() => {})
      await chmod(join(paths.home, 'io-config/opencode'), 0o700).catch(() => {})
      await rm(directory, { recursive: true, force: true })
    }
  }
  const failure = (stdout: string) =>
    stdout
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => driver.parseEvent(line))

  it('hands each credential to the CLI once, through a pipe, in an environment built from scratch', async () => {
    mcpAnswer = accept
    const line = JSON.stringify({ type: 'step_start', sessionID: nativeSessionId })
    const result = await launch({ prompt: '-' }, { run: { stdout: `${line}\n`, readTwice: true } })
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${line}\n`)
    expect(result.records.map((record) => record.command)).toEqual(['run'])
    const [cli] = result.records as [CliRecord]
    expect(cli.argv.slice(0, 5)).toEqual(['run', '--format', 'json', '--agent', 'raditi'])
    expect(cli.argv).not.toContain('--session')
    expect(cli.stdin).toBe('Client request:\n-')
    // Both files were removed before anything started; the CLI found two pipes in their place.
    expect(cli.secrets).toEqual([
      { name: 'llm', fifo: true },
      { name: 'mcp', fifo: true },
    ])
    expect(cli.delivered).toEqual({ llm: context.llm.apiKey, mcp: context.mcp.token })
    // A second read finds nothing: the pipe is gone once its value was taken.
    expect(cli.again).toEqual({ llm: 'ERROR ENOENT', mcp: 'ERROR ENOENT' })
    expect(result.left.secrets).toEqual([])
    // macOS adds a variable of its own to every process it starts.
    expect(
      Object.keys(cli.env)
        .filter((name) => name !== '__CF_USER_TEXT_ENCODING')
        .sort(),
    ).toEqual([
      'BUN_ENABLE_CRASH_REPORTING',
      'HOME',
      'LANG',
      'NO_COLOR',
      'OPENCODE_DISABLE_AUTOUPDATE',
      'OPENCODE_DISABLE_CLAUDE_CODE',
      'OPENCODE_DISABLE_DEFAULT_PLUGINS',
      'OPENCODE_DISABLE_EXTERNAL_SKILLS',
      'OPENCODE_DISABLE_LSP_DOWNLOAD',
      'OPENCODE_DISABLE_MODELS_FETCH',
      'OPENCODE_DISABLE_PROJECT_CONFIG',
      'OPENCODE_DISABLE_SHARE',
      'OPENCODE_PURE',
      'PATH',
    ])
    // Bun uploads a crash report only when asked to; an inherited request must not survive.
    expect(cli.env.BUN_ENABLE_CRASH_REPORTING).toBe('0')
    expect(cli.env.PATH).toBe('/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')
    expect(cli.env.HOME).toMatch(/\/home$/)
    expect(JSON.stringify(cli.env)).not.toMatch(/synthetic-(llm|mcp)-token|hostile|ambient/i)
    // The CLI installs a plugin package into a configuration directory it can write to.
    expect(cli.configMode).toBe(0o555)
    expect(result.left.configMode).toBe(0o700)
    // The wrapper asked the MCP server first, in a process of its own, with the turn's token.
    expect(mcpRequests).toHaveLength(1)
    expect(mcpRequests[0]).toMatchObject({
      authorization: `Bearer ${context.mcp.token}`,
      method: 'initialize',
    })
    expect(mcpRequests[0]!.body.params.protocolVersion).toBe('2025-11-25')
    expect(mcpRequests[0]!.at).toBeLessThanOrEqual(cli.at)
  })

  it('accepts an MCP answer framed as a server-sent event', async () => {
    mcpAnswer = (_, body) => ({
      status: 200,
      type: 'text/event-stream',
      body: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { capabilities: {} } })}\n\n`,
    })
    const result = await launch()
    expect(result.code).toBe(0)
    expect(result.records.map((record) => record.command)).toEqual(['run'])
  })

  it('carries a session over by export, a whitelist rewrite of its row, and import', async () => {
    mcpAnswer = accept
    const messages = [
      { info: { id: 'msg_1', role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
    ]
    const exported = {
      info: {
        id: nativeSessionId,
        slug: 'tidy-orchid',
        projectID: 'a'.repeat(40),
        title: 'raditi-turn',
        version: '1.18.34',
        summary: { additions: 1, deletions: 0, files: 1 },
        cost: 0,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 2 },
        // What a command of the model may have written into the database between two turns.
        permission: [{ permission: 'webfetch', pattern: '*', action: 'allow' }],
        agent: 'build',
        model: { id: 'glm-planted', providerID: 'zai-coding-plan', variant: 'max' },
        directory: '/',
        path: '../..',
        share: { url: 'https://opncd.ai/s/planted' },
        parentID: 'ses_planted',
        workspaceID: 'planted',
        revert: { messageID: 'msg_planted' },
      },
      messages,
      planted: { credential: 'x' },
    }
    const result = await launch(
      { session: nativeSessionId },
      { export: { stdout: JSON.stringify(exported) } },
      async (paths) => {
        // The restored database of the previous turn, and a cache nobody restores.
        await mkdir(join(paths.home, '.local/share/opencode'), { recursive: true })
        await writeFile(join(paths.home, '.local/share/opencode/old-session'), 'restored')
        await mkdir(join(paths.home, '.cache'), { recursive: true })
        await writeFile(join(paths.home, '.cache/old-cache'), 'x')
      },
    )
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(result.records.map((record) => record.command)).toEqual(['export', 'import', 'run'])
    const [exporting, importing, running] = result.records as [CliRecord, CliRecord, CliRecord]
    expect(exporting.argv).toEqual(['export', nativeSessionId])
    expect(exporting.oldData).toBe(true)
    for (const io of [exporting, importing]) {
      // Whatever reads the restored database runs without the credentials and without the
      // configuration that names them.
      expect(io.secrets).toEqual([])
      expect(io.env.XDG_CONFIG_HOME).toMatch(/\/home\/io-config$/)
      expect(io.configMode).toBe(0o555)
      expect(io.env.BUN_ENABLE_CRASH_REPORTING).toBe('0')
      expect(io.cwd).toBe(running.cwd)
    }
    expect(importing.argv[0]).toBe('import')
    // The old database is gone before the import: the CLI of the turn works on one it wrote.
    expect(importing.oldData).toBe(false)
    expect(JSON.parse(importing.imported!)).toEqual({
      info: {
        id: nativeSessionId,
        slug: 'tidy-orchid',
        projectID: 'a'.repeat(40),
        title: 'raditi-turn',
        version: '1.18.34',
        summary: { additions: 1, deletions: 0, files: 1 },
        cost: 0,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 2 },
        permission: [
          { permission: 'question', pattern: '*', action: 'deny' },
          { permission: 'plan_enter', pattern: '*', action: 'deny' },
          { permission: 'plan_exit', pattern: '*', action: 'deny' },
        ],
        agent: 'raditi',
        model: { id: 'glm-5.3', providerID: 'raditi', variant: 'default' },
        directory: result.repo,
        path: '',
      },
      messages,
    })
    expect(running.env.XDG_CONFIG_HOME).toBeUndefined()
    expect(running.argv.slice(-2)).toEqual(['--session', nativeSessionId])
    expect(running.delivered).toEqual({ llm: context.llm.apiKey, mcp: context.mcp.token })
    expect(result.left.exportFile).toBe(false)
    expect(result.left.secrets).toEqual([])
    // Export and import go first: the MCP server is asked only when the session is in place.
    expect(mcpRequests[0]!.at).toBeGreaterThanOrEqual(importing.at)
  })

  it.each([
    ['fails', { export: { exit: 1, stdout: '' } }, 'Could not export the previous session'],
    ['prints no JSON', { export: { stdout: 'Error: no such session' } }, 'not JSON'],
    [
      'returns another session',
      { export: { stdout: JSON.stringify({ info: { id: 'ses_other' }, messages: [] }) } },
      'unexpected shape',
    ],
    [
      'returns no messages',
      { export: { stdout: JSON.stringify({ info: { id: nativeSessionId } }) } },
      'unexpected shape',
    ],
  ])('ends the turn before the CLI starts when the export %s', async (_, behaviour, reason) => {
    mcpAnswer = accept
    const result = await launch({ session: nativeSessionId }, behaviour)
    expect(result.code).toBe(1)
    expect(result.records.map((record) => record.command)).toEqual(['export'])
    expect(failure(result.stdout)).toEqual([
      { type: 'failed', reason: expect.stringContaining(reason) },
    ])
    expect(mcpRequests).toEqual([])
    expect(result.left.secrets).toEqual([])
    expect(result.left.exportFile).toBe(false)
    expect(result.stdout + result.stderr).not.toMatch(/synthetic-(llm|mcp)-token/)
  })

  it('ends the turn when the import fails', async () => {
    mcpAnswer = accept
    const result = await launch(
      { session: nativeSessionId },
      {
        export: { stdout: JSON.stringify({ info: { id: nativeSessionId }, messages: [] }) },
        import: { exit: 1 },
      },
    )
    expect(result.code).toBe(1)
    expect(result.records.map((record) => record.command)).toEqual(['export', 'import'])
    expect(failure(result.stdout)).toEqual([
      { type: 'failed', reason: 'RaditiWrapperError: Could not import the previous session' },
    ])
    expect(result.left.exportFile).toBe(false)
  })

  it.each([
    ['refuses the token', () => ({ status: 401, type: 'application/json', body: '{}' })],
    [
      'answers with a JSON-RPC error',
      (_: IncomingMessage, body: RpcRequest) => ({
        status: 200,
        type: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32000, message: 'no' },
        }),
      }),
    ],
    ['answers with something else', () => ({ status: 200, type: 'text/html', body: '<html>' })],
  ])('never starts the CLI when the MCP server %s', async (_, answer) => {
    mcpAnswer = answer
    const result = await launch()
    expect(result.code).toBe(1)
    expect(result.records).toEqual([])
    expect(failure(result.stdout)).toEqual([
      { type: 'failed', reason: 'RaditiWrapperError: The MCP server did not accept the turn' },
    ])
    expect(result.left.secrets).toEqual([])
  })

  it('stops the CLI and fails the turn when the CLI itself could not connect to the MCP server', async () => {
    mcpAnswer = accept
    const result = await launch({}, { run: { stderr: WARN_LINE, hangMs: 15_000 } })
    expect(result.ms).toBeLessThan(10_000)
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(WARN_LINE)
    expect(failure(result.stdout)).toEqual([
      {
        type: 'failed',
        reason: 'RaditiWrapperError: The CLI could not connect to the MCP server',
      },
    ])
    expect(result.left.secrets).toEqual([])
  })

  it.each([
    WARN_LINE.replace('key=raditi', 'key=other'),
    WARN_LINE.replace('level=WARN', 'level=INFO'),
    'timestamp=2026-10-05T07:39:41.603Z level=WARN run=8ece3ed8 message="slow tool" key=raditi\n',
  ])('lets a turn go on after another log line: %s', async (line) => {
    mcpAnswer = accept
    const result = await launch({}, { run: { stderr: line, exit: 0 } })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(line)
    expect(failure(result.stdout)).toEqual([])
  })

  it('ends with the CLI when it never read a pipe, and leaves no pipe behind', async () => {
    mcpAnswer = accept
    const result = await launch({}, { run: { readSecrets: false, exit: 3 } })
    expect(result.code).toBe(3)
    expect(result.ms).toBeLessThan(10_000)
    expect(result.left.secrets).toEqual([])
    expect(result.left.configMode).toBe(0o700)
  })

  it("keeps the site's own OpenCode files away from every CLI process and puts them back", async () => {
    mcpAnswer = accept
    // The CLI imports .opencode/plugin/*.js of the directory it runs in, whatever its switches.
    const site = async (paths: { repo: string }) => {
      await mkdir(join(paths.repo, '.opencode/plugin'), { recursive: true })
      await writeFile(join(paths.repo, '.opencode/plugin/site.js'), 'throw new Error("ran")')
      await writeFile(join(paths.repo, 'opencode.json'), '{"plugin":["./evil.js"]}')
      await writeFile(join(paths.repo, 'opencode.jsonc'), '// the site has both')
      await writeFile(join(paths.repo, 'index.php'), '<?php')
    }
    const result = await launch(
      { session: nativeSessionId },
      { export: { stdout: JSON.stringify({ info: { id: nativeSessionId }, messages: [] }) } },
      site,
    )
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(result.records.map((record) => record.command)).toEqual(['export', 'import', 'run'])
    for (const record of result.records) expect(record.project).toEqual([])
    expect(result.left.repo).toEqual([
      '.opencode',
      '.opencode/plugin',
      '.opencode/plugin/site.js',
      'index.php',
      'opencode.json',
      'opencode.jsonc',
    ])
    // Nothing of the holding place is left next to the working copy.
    expect(result.left.aboveRepo).toEqual([
      'behaviour.json',
      'home',
      'opencode',
      'records.jsonl',
      'repo',
      'secrets',
    ])
    // The same when the turn ends before the CLI starts.
    mcpAnswer = () => ({ status: 401, body: '' })
    const refused = await launch({}, {}, site)
    expect(refused.code).toBe(1)
    expect(refused.records).toEqual([])
    expect(refused.left.repo).toEqual(result.left.repo)
    expect(refused.left.aboveRepo).toEqual([
      'behaviour.json',
      'home',
      'opencode',
      'repo',
      'secrets',
    ])
  })

  it('fails the turn that wrote an OpenCode file over one the site already has', async () => {
    mcpAnswer = accept
    const result = await launch({}, { run: { plant: 'opencode.json' } }, async (paths) => {
      await writeFile(join(paths.repo, 'opencode.json'), 'the site has one')
    })
    expect(result.code).toBe(1)
    expect(failure(result.stdout)).toEqual([
      {
        type: 'failed',
        reason: 'RaditiWrapperError: The turn wrote an OpenCode file over one the site already has',
      },
    ])
    // A file of that name the site did not have is the turn's own change, like any other.
    const added = await launch({}, { run: { plant: 'opencode.json' } })
    expect(added.code).toBe(0)
    expect(added.left.repo).toEqual(['opencode.json'])
    expect(added.left.aboveRepo).not.toContain('.raditi-opencode-held')
  })

  it('names the directories above the working copy: the CLI may walk up to them', async () => {
    const run = await driver.prepare(context)
    expect(file(run, 'run.mjs')).toContain('"above":["/workspace","/"]')
    expect(file(run, 'run.mjs')).toContain(
      '"projectFiles":[".opencode","opencode.json","opencode.jsonc"]',
    )
  })

  it.each(PROJECT_FILES)(
    'starts no CLI process while %s stands above the working copy',
    async (name) => {
      mcpAnswer = accept
      const result = await launch({ session: nativeSessionId }, {}, async (paths) => {
        await writeFile(join(paths.repo, '..', name), 'nobody puts it here')
        await writeFile(join(paths.repo, 'opencode.json'), 'the site has one')
      })
      expect(result.code).toBe(1)
      expect(result.records).toEqual([])
      expect(failure(result.stdout)).toEqual([
        {
          type: 'failed',
          reason: 'RaditiWrapperError: An OpenCode file is where the CLI would load it',
        },
      ])
      expect(mcpRequests).toEqual([])
      // The site's own file is back, the stray one is nobody's to remove.
      expect(result.left.repo).toEqual(['opencode.json'])
      expect(result.left.aboveRepo).toContain(name)
      expect(result.left.aboveRepo).not.toContain('.raditi-opencode-held')
      expect(result.left.secrets).toEqual([])
    },
  )

  it.each([
    [
      'the export',
      {
        export: {
          stdout: JSON.stringify({ info: { id: nativeSessionId }, messages: [] }),
          plant: '.opencode',
        },
      },
      ['export'],
    ],
    [
      'the import',
      {
        export: { stdout: JSON.stringify({ info: { id: nativeSessionId }, messages: [] }) },
        import: { plant: 'opencode.jsonc' },
      },
      ['export', 'import'],
    ],
  ])(
    'starts no further CLI process once %s left an OpenCode file in the working copy',
    async (_, behaviour, commands) => {
      mcpAnswer = accept
      const result = await launch({ session: nativeSessionId }, behaviour)
      expect(result.code).toBe(1)
      expect(result.records.map((record) => record.command)).toEqual(commands)
      expect(failure(result.stdout)).toEqual([
        {
          type: 'failed',
          reason: 'RaditiWrapperError: An OpenCode file is where the CLI would load it',
        },
      ])
      // The credentials never reached a process: the CLI of the turn was not started.
      expect(mcpRequests).toEqual([])
      expect(result.left.secrets).toEqual([])
      expect(result.left.exportFile).toBe(false)
    },
  )

  it("names the CLI's own places: its home and what the driver wrote into each configuration directory", async () => {
    const run = await driver.prepare(context)
    expect(file(run, 'run.mjs')).toContain(`"absent":["${home}/.opencode"]`)
    expect(file(run, 'run.mjs')).toContain(
      `"only":{"${home}/.config/opencode":["AGENTS.md","opencode.json"],"${home}/io-config/opencode":["opencode.json"]}`,
    )
    // The lists are exactly what the driver itself prepares in those directories.
    for (const [directory, names] of [
      [`${home}/.config/opencode`, ['AGENTS.md', 'opencode.json']],
      [`${home}/io-config/opencode`, ['opencode.json']],
    ] as const)
      expect(
        run.files
          .filter((entry) => dirname(entry.path) === directory)
          .map((entry) => entry.path.slice(directory.length + 1))
          .sort(),
      ).toEqual(names)
  })

  // At start the pinned CLI imports {plugin,plugins,tool,tools}/* of its configuration directory
  // and {tool,tools}/* of ~/.opencode, and reads every other document of the directory.
  it.each([
    '.opencode/tool/planted.js',
    '.config/opencode/plugin/planted.js',
    '.config/opencode/plugins/planted.ts',
    '.config/opencode/tool/planted.js',
    '.config/opencode/opencode.jsonc',
    '.config/opencode/agent/raditi.md',
    'io-config/opencode/plugin/planted.js',
  ])('starts no CLI process while %s is in the home of the CLI', async (planted) => {
    mcpAnswer = accept
    const result = await launch({ session: nativeSessionId }, {}, async (paths) => {
      await mkdir(dirname(join(paths.home, planted)), { recursive: true })
      await writeFile(join(paths.home, planted), 'nobody puts it here')
      await writeFile(join(paths.repo, 'opencode.json'), 'the site has one')
    })
    expect(result.code).toBe(1)
    expect(result.records).toEqual([])
    expect(failure(result.stdout)).toEqual([
      {
        type: 'failed',
        reason: 'RaditiWrapperError: An OpenCode file is where the CLI would load it',
      },
    ])
    expect(mcpRequests).toEqual([])
    expect(result.left.repo).toEqual(['opencode.json'])
    expect(result.left.secrets).toEqual([])
  })

  it('starts no further CLI process once the export left a file in the home of the CLI', async () => {
    mcpAnswer = accept
    const result = await launch(
      { session: nativeSessionId },
      {
        export: {
          stdout: JSON.stringify({ info: { id: nativeSessionId }, messages: [] }),
          plantHome: '.opencode/tool/late.js',
        },
      },
    )
    expect(result.code).toBe(1)
    expect(result.records.map((record) => record.command)).toEqual(['export'])
    expect(failure(result.stdout)).toEqual([
      {
        type: 'failed',
        reason: 'RaditiWrapperError: An OpenCode file is where the CLI would load it',
      },
    ])
    expect(mcpRequests).toEqual([])
    expect(result.left.secrets).toEqual([])
  })

  it('fails the turn whose command removed the files the site had', async () => {
    mcpAnswer = accept
    const result = await launch({}, { run: { dropHeld: true } }, async (paths) => {
      await writeFile(join(paths.repo, 'opencode.json'), 'the site has one')
    })
    // An exit code 0 would let the capture take the working copy without the site's file.
    expect(result.code).toBe(1)
    expect(failure(result.stdout)).toEqual([
      {
        type: 'failed',
        reason: "RaditiWrapperError: Could not put the site's OpenCode files back",
      },
    ])
    expect(result.left.repo).toEqual([])
  })

  it('does not start over files a previous run left hidden', async () => {
    mcpAnswer = accept
    const result = await launch({}, {}, async (paths) => {
      await mkdir(join(paths.repo, '../.raditi-opencode-held'))
    })
    expect(result.code).toBe(1)
    expect(result.records).toEqual([])
    expect(failure(result.stdout)).toEqual([
      { type: 'failed', reason: 'RaditiWrapperError: Could not prepare the turn' },
    ])
    expect(result.left.aboveRepo).toContain('.raditi-opencode-held')
    expect(result.left.secrets).toEqual([])
  })

  it('reports a CLI ended by a signal as a failed process', async () => {
    mcpAnswer = accept
    const result = await launch({}, { run: { signal: 'SIGKILL' } })
    expect(result.code).toBe(137)
    expect(result.left.secrets).toEqual([])
  })
})
