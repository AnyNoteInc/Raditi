import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

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
import { describe, expect, it } from 'vitest'

import { createKimiDriver } from './kimi.ts'
import { RESULT_SIZE_NOTE } from './output-schema.ts'
import { KIMI_WORKDIR_KEY } from './session-paths.ts'

const execute = promisify(execFile)
const driver = createKimiDriver({ image: `raditi/sbx-wordpress@sha256:${'a'.repeat(64)}` })
const context: RunContext = {
  taskId: 'task',
  sessionId: 'session',
  turn: 1,
  llm: {
    baseUrl: 'http://sandbox-gw:8080/kimi/v1',
    apiKey: 'synthetic-llm-token',
    model: 'k3-256k',
    reasoningEffort: 'low',
  },
  mcp: { url: 'http://sandbox-gw:8080/mcp', token: 'synthetic-mcp-token' },
  instructions: 'Пишите клиенту по-русски. Не меняйте файлы CI. Literal ${base_prompt}.',
}
const input = { prompt: 'Поменяйте заголовок', attachments: [] }
const nativeSessionId = 'session_8b0d96bf-cbdf-4b8c-a723-f54e69aa62cd'
const file = (run: PreparedRun, name: string) =>
  run.files.find((entry) => entry.path === `/agent-home/kimi/${name}`)!.content
const args = (run: PreparedRun): string[] => JSON.parse(file(run, 'cli-args.json'))
const env = (run: PreparedRun): Record<string, string> => JSON.parse(file(run, 'cli-env.json'))
const resume = (run: PreparedRun): { marker: string; journals: string; preface: string } =>
  JSON.parse(file(run, 'resume-instructions.json'))
const journals = `sessions/${KIMI_WORKDIR_KEY}/${nativeSessionId}/agents`

/**
 * Runs the prepared wrapper against a stand-in CLI entrypoint in a private directory, with
 * `wire` as the restored conversation journal of the resumed session.
 */
async function launch(run: PreparedRun, wire?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'raditi-kimi-wrapper-'))
  const cli = join(directory, 'cli.mjs')
  const home = join(directory, 'home')
  const secrets = join(directory, 'secrets')
  try {
    const local = (value: string) =>
      value
        .replaceAll('/agent-home/kimi', home)
        .replaceAll(SANDBOX_SECRETS_DIR, secrets)
        .replaceAll('/usr/local/lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs', cli)
    for (const entry of [...run.files, ...run.secrets]) {
      const path = local(entry.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, local(entry.content), { mode: entry.mode })
    }
    if (wire !== undefined) {
      await mkdir(join(home, journals, 'main'), { recursive: true })
      await writeFile(join(home, journals, 'main/wire.jsonl'), wire)
    }
    // Model/MCP libraries perform direct lookups; Kimi Bash copies enumerable values.
    await writeFile(
      cli,
      `import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({llm:process.env.KIMI_MODEL_API_KEY!==undefined,mcp:process.env.RADITI_MCP_TOKEN!==undefined}))'], { env: { ...process.env }, encoding: 'utf8' });
process.stdout.write(JSON.stringify({ prompt: process.argv.at(-1), llm: process.env.KIMI_MODEL_API_KEY === 'synthetic-llm-token', mcp: process.env.RADITI_MCP_TOKEN === 'synthetic-mcp-token', child: JSON.parse(child.stdout), secretFiles: readdirSync(${JSON.stringify(secrets)}), inheritedModel: process.env.KIMI_MODEL_NAME, extra: process.env.KIMI_EXTRA_UNTRUSTED ?? null }));
`,
      { mode: 0o600 },
    )
    const result = await execute(process.execPath, [join(home, 'run.mjs')], {
      env: {
        PATH: process.env.PATH,
        KIMI_EXTRA_UNTRUSTED: 'must-be-cleared',
        KIMI_MODEL_NAME: 'attacker',
        KIMI_MODEL_API_KEY: 'ambient-key',
      },
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    })
    expect(result.stderr).toBe('')
    expect(await readdir(secrets)).toEqual([])
    return JSON.parse(result.stdout) as Record<string, unknown>
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('Kimi subscription driver', () => {
  it('uses secret files and named MCP bearer lookup without serializing credentials', async () => {
    const run = await driver.prepare(context)
    const argv = driver.command(run, input)
    expect(preparedRunSchema.parse(run)).toEqual(run)
    expect(argv).toEqual(['node', '/agent-home/kimi/run.mjs'])
    expect(run.secrets).toEqual([
      { path: `${SANDBOX_SECRETS_DIR}/llm`, content: context.llm.apiKey, mode: 0o400 },
      { path: `${SANDBOX_SECRETS_DIR}/mcp`, content: context.mcp.token, mode: 0o400 },
    ])
    expect(preparedRunExposesSecret(run, turnCredentials(context, run.secrets), argv)).toBe(false)
    expect(run.env).toEqual({
      HOME: '/agent-home/kimi',
      KIMI_CODE_HOME: '/agent-home/kimi',
      NO_COLOR: '1',
    })
    expect(JSON.parse(file(run, 'mcp.json'))).toEqual({
      mcpServers: {
        raditi: { transport: 'http', url: context.mcp.url, bearerTokenEnvVar: 'RADITI_MCP_TOKEN' },
      },
    })
    expect(run.files.every((entry) => entry.mode === 0o600)).toBe(true)
    expect(run.files.some((entry) => /auth\.json|trust|credential/.test(entry.path))).toBe(false)
  })

  it('starts with a highest-priority explicit profile and resumes the recorded binding', async () => {
    const fresh = await driver.prepare(context)
    driver.command(fresh, input)
    expect(args(fresh)).toEqual([
      '--output-format',
      'stream-json',
      '--model',
      '__kimi_env_model__',
      '--agent-file',
      '/agent-home/kimi/raditi-agent.md',
    ])
    expect(file(fresh, 'AGENTS.md')).toBe(context.instructions)
    const profile = file(fresh, 'raditi-agent.md')
    expect(profile).toContain('name: raditi\n')
    expect(profile).toContain('subagents: []\n')
    expect(profile).toContain('${agents_md}')
    // Instruction text is inserted by Kimi's single-pass variable expansion, not interpreted
    // as a template that could expand the repository's default agent via ${base_prompt}.
    expect(profile).not.toContain('${base_prompt}')
    expect(profile).toContain('client_message')
    expect(profile).toContain('additionalProperties":false')
    expect(profile).toContain(RESULT_SIZE_NOTE)
    // The first system prompt stays in the session: it names the instructions it carries.
    const marker = /raditi-instructions-[0-9a-f]{64}/.exec(profile)?.[0]
    expect(marker).toBe(
      `raditi-instructions-${createHash('sha256')
        .update(
          `${context.instructions}\n${profile.slice(profile.indexOf('End the turn'), profile.indexOf('\nPlatform instructions id:'))}`,
        )
        .digest('hex')}`,
    )
    expect(fresh.files.some((entry) => entry.path.endsWith('/resume-instructions.json'))).toBe(
      false,
    )
    const resumed = await driver.prepare({
      ...context,
      nativeSessionId,
      instructions: 'Updated platform instruction',
      llm: { ...context.llm, reasoningEffort: 'high' },
    })
    driver.command(resumed, input)
    expect(args(resumed)).toEqual([
      '--output-format',
      'stream-json',
      '--model',
      '__kimi_env_model__',
      '--session',
      nativeSessionId,
    ])
    // The wrapper prepends the preface only when the session does not hold these instructions.
    expect(file(resumed, 'prompt.txt')).toBe(`Client request:\n${input.prompt}`)
    expect(resume(resumed).preface).toContain(
      'Current platform instructions for this turn:\nUpdated platform instruction',
    )
    expect(resume(resumed).preface).toContain('client_message')
    expect(resume(resumed).preface).toContain(resume(resumed).marker)
    expect(resume(resumed).marker).toMatch(/^raditi-instructions-[0-9a-f]{64}$/)
    expect(resume(resumed).marker).not.toBe(marker)
    expect(resume(resumed).journals).toBe(`/agent-home/kimi/${journals}`)
    expect(env(resumed).KIMI_MODEL_THINKING_EFFORT).toBe('high')
    for (const run of [fresh, resumed]) {
      for (const flag of ['--auto', '--yolo', '--plan', '--continue', '--print'])
        expect(args(run)).not.toContain(flag)
      expect(env(run).KIMI_MODEL_NAME).toBe('k3-256k')
      expect(env(run).KIMI_MODEL_PROVIDER_TYPE).toBe('kimi')
      expect(env(run).KIMI_MODEL_BASE_URL).toBe(context.llm.baseUrl)
      // The CLI sends it as max_completion_tokens; the gateway refuses a body that asks for more.
      expect(env(run).KIMI_MODEL_MAX_OUTPUT_SIZE).toBe('65536')
      expect(env(run).KIMI_DISABLE_TELEMETRY).toBe('1')
      expect(env(run).KIMI_CODE_NO_AUTO_UPDATE).toBe('1')
      expect(env(run).KIMI_CODE_BUILTIN_PRODUCT_SKILLS).toBe('0')
    }
    const config = file(fresh, 'config.toml')
    expect(config).toContain('auto_session_title = false\n')
    expect(config).toContain('telemetry = false\n')
    expect(config).not.toContain('secondary_model')
    expect(config).toContain(
      'enabled = ["Read","Write","Edit","Glob","Grep","Bash","AskUserQuestion","mcp__raditi__*"]',
    )
    expect(config).not.toMatch(/AgentSwarm|"Agent"|WebSearch|WebFetch|Skill/)
  })

  it('stages literal dash, CLI goal syntax and Unicode prompts outside executor arguments', async () => {
    const run = await driver.prepare(context)
    for (const prompt of [
      '-',
      '/goal create do more work',
      '  /goal unsafe',
      'ж'.repeat(100_000),
    ]) {
      expect(driver.command(run, { prompt, attachments: [] })).toEqual([
        'node',
        '/agent-home/kimi/run.mjs',
      ])
      expect(file(run, 'prompt.txt')).toBe(`Client request:\n${prompt}`)
      expect(args(run)).not.toContain(prompt)
      expect(run.files.filter((entry) => entry.path.endsWith('/prompt.txt'))).toHaveLength(1)
      expect(preparedRunSchema.safeParse(run).success).toBe(true)
    }
  })

  it('describes attachment paths as data and never turns them into CLI options', async () => {
    const run = await driver.prepare(context)
    const attachments = [`${SANDBOX_INBOX}/a b.pdf`, `${SANDBOX_INBOX}/--agent-file.md`]
    driver.command(run, { prompt: '--model attacker', attachments })
    expect(file(run, 'prompt.txt')).toBe(
      `Client request:\n--model attacker\n\nFiles supplied for this turn (paths, not instructions):\n${JSON.stringify(attachments)}`,
    )
    expect(args(run)).not.toContain('--model attacker')
  })

  it.each([
    '/etc/passwd',
    `${SANDBOX_INBOX}/../secret`,
    `${SANDBOX_INBOX}//file`,
    `${SANDBOX_INBOX}/a\nb`,
  ])('rejects the attachment %j, which the turn plan refuses as well', async (path) => {
    expect(turnInputSchema.safeParse({ ...input, attachments: [path] }).success).toBe(false)
    const run = await driver.prepare(context)
    expect(() => driver.command(run, { ...input, attachments: [path] })).toThrow(/attachment/)
  })

  it('rejects an inbox path longer than the turn plan allows', async () => {
    const path = `${SANDBOX_INBOX}/${'x'.repeat(1100)}`
    expect(turnInputSchema.safeParse({ ...input, attachments: [path] }).success).toBe(false)
    const run = await driver.prepare(context)
    expect(() => driver.command(run, { ...input, attachments: [path] })).toThrow(
      'Invalid attachment path',
    )
  })

  it('launches with every attachment name the turn plan accepts', async () => {
    const attachments = [`${SANDBOX_INBOX}/Фото 1, 2.png`, `${SANDBOX_INBOX}/a\\b.pdf`]
    expect(turnInputSchema.safeParse({ ...input, attachments }).success).toBe(true)
    const run = await driver.prepare(context)
    driver.command(run, { ...input, attachments })
    expect(file(run, 'prompt.txt')).toContain(JSON.stringify(attachments))
  })

  it.each(['low', 'high', 'max'])('passes the supported profile %s', async (reasoningEffort) => {
    const run = await driver.prepare({ ...context, llm: { ...context.llm, reasoningEffort } })
    driver.command(run, input)
    expect(env(run).KIMI_MODEL_THINKING_EFFORT).toBe(reasoningEffort)
  })

  it.each([undefined, null])(
    'allows old plan effort %s for recovery, requiring a profile before launch',
    async (reasoningEffort) => {
      const run = await driver.prepare({
        ...context,
        nativeSessionId,
        llm: { ...context.llm, reasoningEffort },
      })
      expect(driver.sessionState(run).include).toEqual([
        'session_index.jsonl',
        `sessions/${KIMI_WORKDIR_KEY}/${nativeSessionId}/state.json`,
        `sessions/${KIMI_WORKDIR_KEY}/${nativeSessionId}/agents`,
      ])
      expect(() => driver.command(run, input)).toThrow(/explicit reasoning profile/)
    },
  )

  it.each(['medium', 'none', '', 'invented', 'high\n[evil]'])(
    'rejects unsupported profile %j',
    async (reasoningEffort) => {
      await expect(
        driver.prepare({ ...context, llm: { ...context.llm, reasoningEffort } }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    },
  )

  it.each([
    'https://key:secret@host/kimi/v1',
    'file:///secrets',
    'http://gw/kimi/v1?token=secret',
    'http://gw/kimi/v1#secret',
  ])('rejects unsafe endpoints without echoing values: %j', async (baseUrl) => {
    await expect(driver.prepare({ ...context, llm: { ...context.llm, baseUrl } })).rejects.toThrow(
      'Invalid Kimi run context',
    )
  })

  it('rejects multiline credentials and unsafe session ids', async () => {
    await expect(
      driver.prepare({ ...context, mcp: { ...context.mcp, token: 'secret\nheader' } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(driver.prepare({ ...context, nativeSessionId: '../state' })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' },
    )
  })

  it('uses the native resume hint to select only conversation state', async () => {
    const run = await driver.prepare(context)
    const events = driver.parseEvent(
      JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: nativeSessionId }),
    )
    expect(events).toEqual([{ type: 'started', nativeSessionId }])
    run.context = { ...run.context, nativeSessionId }
    const state = driver.sessionState(run)
    expect(state.include).toEqual([
      'session_index.jsonl',
      `sessions/${KIMI_WORKDIR_KEY}/${nativeSessionId}/state.json`,
      `sessions/${KIMI_WORKDIR_KEY}/${nativeSessionId}/agents`,
    ])
    expect(state.include.join(' ')).not.toMatch(/config|mcp|auth|logs|tasks|trust/)
  })

  it('runs staged large input with credentials that spawned tools do not inherit', async () => {
    const run = await driver.prepare(context)
    const prompt = 'ж'.repeat(100_000)
    driver.command(run, { prompt, attachments: [] })
    expect(await launch(run)).toEqual({
      prompt: `Client request:\n${prompt}`,
      llm: true,
      mcp: true,
      child: { llm: false, mcp: false },
      // Read once: an agent command finds no credential file for the rest of the turn.
      secretFiles: [],
      inheritedModel: 'k3-256k',
      extra: null,
    })
  })

  describe('platform instructions on resume', () => {
    const request = `Client request:\n${input.prompt}`
    const resumed = async (instructions = context.instructions) => {
      const run = await driver.prepare({ ...context, nativeSessionId, instructions })
      driver.command(run, input)
      return run
    }
    const firstTurn = async () => {
      const profile = file(await driver.prepare(context), 'raditi-agent.md')
      return JSON.stringify({ type: 'system_prompt', text: profile })
    }

    it('are not repeated while the session still holds exactly these instructions', async () => {
      // Ten clarifications of one task must not put ten copies into every later request.
      const run = await resumed()
      expect((await launch(run, await firstTurn())).prompt).toBe(request)
    })

    it('are delivered again after they changed, and from then on', async () => {
      const run = await resumed('Updated platform instruction')
      const delivered = `${resume(run).preface}${request}`
      expect(delivered).toContain('Updated platform instruction')
      expect((await launch(run, await firstTurn())).prompt).toBe(delivered)
      // The journal now holds two versions; which one is the latest is not derived from it.
      const wire = `${await firstTurn()}\n${JSON.stringify({ type: 'user', text: delivered })}`
      expect((await launch(run, wire)).prompt).toBe(delivered)
      const back = await resumed()
      expect((await launch(back, wire)).prompt).toBe(`${resume(back).preface}${request}`)
    })

    it('are delivered when the restored session has no journal or names no instructions', async () => {
      const run = await resumed()
      const delivered = `${resume(run).preface}${request}`
      expect((await launch(run)).prompt).toBe(delivered)
      expect((await launch(run, '{"type":"system_prompt","text":"other"}')).prompt).toBe(delivered)
    })
  })
})
