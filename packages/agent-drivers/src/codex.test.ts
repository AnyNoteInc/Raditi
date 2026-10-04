import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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
  turnResultSchema,
  type PreparedRun,
  type RunContext,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { createCodexDriver } from './codex.ts'
import { RESULT_SIZE_NOTE, strictOutputSchema } from './output-schema.ts'

const execute = promisify(execFile)
const driver = createCodexDriver({ image: `raditi/sbx-wordpress@sha256:${'a'.repeat(64)}` })
const context: RunContext = {
  taskId: 'task',
  sessionId: 'session',
  turn: 1,
  llm: {
    baseUrl: 'http://sandbox-gw:8080/codex',
    apiKey: 'synthetic-llm-token',
    model: 'gpt-6-sol',
    reasoningEffort: 'medium',
  },
  mcp: { url: 'http://sandbox-gw:8080/mcp', token: 'synthetic-mcp-token' },
  instructions: 'Пишите клиенту по-русски.\nНе меняйте файлы CI.',
}
const input = { prompt: 'Поменяйте заголовок', attachments: [] }
const cliArgs = (run: PreparedRun): string[] =>
  JSON.parse(run.files.find((file) => file.path.endsWith('/cli-args.json'))!.content)

describe('Codex subscription driver', () => {
  it('keeps credentials in tmpfs files, with no credentials in config, env or argv', async () => {
    const run = await driver.prepare(context)
    expect(preparedRunSchema.parse(run)).toEqual(run)
    expect(run.secrets).toEqual([
      { path: `${SANDBOX_SECRETS_DIR}/llm`, content: context.llm.apiKey, mode: 0o400 },
      { path: `${SANDBOX_SECRETS_DIR}/mcp`, content: context.mcp.token, mode: 0o400 },
    ])
    expect(
      preparedRunExposesSecret(
        run,
        turnCredentials(context, run.secrets),
        driver.command(run, input),
      ),
    ).toBe(false)
    expect(run.files.some((file) => file.path.endsWith('/auth.json'))).toBe(false)
    expect(run.files.find((file) => file.path.endsWith('/AGENTS.md'))?.content).toBe(
      context.instructions,
    )
    const launch = run.files.find((file) => file.path.endsWith('/run.mjs'))!.content
    expect(launch).toContain(`RADITI_LLM_TOKEN: secret('${SANDBOX_SECRETS_DIR}/llm')`)
    expect(launch).toContain(`RADITI_MCP_TOKEN: secret('${SANDBOX_SECRETS_DIR}/mcp')`)
    expect(launch).toContain("openSync('/agent-home/codex/prompt.txt', 'r')")
    expect(driver.sessionState(run)).toEqual({
      root: '/agent-home/codex',
      include: ['sessions'],
      exclude: [],
    })
  })

  it('pins platform settings above project config on fresh runs and resumed sessions', async () => {
    for (const nativeSessionId of [undefined, '01960000-0000-7000-8000-000000000001']) {
      const run = await driver.prepare({
        ...context,
        ...(nativeSessionId ? { nativeSessionId } : {}),
      })
      expect(driver.command(run, input)).toEqual(['node', '/agent-home/codex/run.mjs'])
      const argv = cliArgs(run)
      expect(argv.slice(0, nativeSessionId ? 2 : 1)).toEqual([
        'exec',
        ...(nativeSessionId ? ['resume'] : []),
      ])
      expect(argv).toContain('--strict-config')
      expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox')
      expect(argv).toContain('--json')
      expect(argv).toContain('--output-schema')
      expect(argv).not.toContain('--ephemeral')
      const config = run.files.find((file) => file.path.endsWith('/config.toml'))!.content
      const expected = [
        'model = "gpt-6-sol"',
        'model_reasoning_effort = "medium"',
        'model_provider = "raditi"',
        'model_providers.raditi.env_key = "RADITI_LLM_TOKEN"',
        'model_providers.raditi.base_url = "http://sandbox-gw:8080/codex"',
        'model_providers.raditi.requires_openai_auth = false',
        'model_providers.raditi.supports_websockets = false',
        'chatgpt_base_url = "http://sandbox-gw:8080/disabled/"',
        'cli_auth_credentials_store = "ephemeral"',
        'features.multi_agent = false',
        'features.multi_agent_v2 = false',
        // A project config could switch the required raditi server to the 2026 protocol.
        'features.mcp_2026_07_28 = false',
        'agents.enabled = false',
        'analytics.enabled = false',
        'check_for_update_on_startup = false',
        'web_search = "disabled"',
        // The CLI default: an untrusted repository AGENTS.md never adds more to a request.
        'project_doc_max_bytes = 32768',
        'shell_environment_policy.ignore_default_excludes = false',
        'mcp_servers.raditi.url = "http://sandbox-gw:8080/mcp"',
        'mcp_servers.raditi.bearer_token_env_var = "RADITI_MCP_TOKEN"',
        'mcp_servers.raditi.required = true',
      ]
      for (const setting of expected) {
        expect(config).toContain(`${setting}\n`)
        const index = argv.indexOf(setting)
        expect(index).toBeGreaterThan(0)
        expect(argv[index - 1]).toBe('--config')
      }
      expect(argv.slice(argv.indexOf('--'))).toEqual([
        '--',
        ...(nativeSessionId ? [nativeSessionId] : []),
        '-',
      ])
    }
  })

  it('uses the domain result schema for both CLI modes', async () => {
    const run = await driver.prepare(context)
    const schema = JSON.parse(
      run.files.find((file) => file.path.endsWith('/output-schema.json'))!.content,
    )
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual([
      'summary',
      'change_type',
      'client_message',
      'files_changed',
      'questions',
      'needs_approval',
      'risk',
    ])
    expect(schema.properties.risk.enum).toEqual(['low', 'medium', 'high'])
    // The CLI sends it with strict: true; the subset rules are in output-schema.test.ts.
    expect(schema).toEqual(strictOutputSchema(turnResultSchema, RESULT_SIZE_NOTE))
    expect(JSON.stringify(schema)).not.toMatch(/\$schema|minLength|maxLength|maxItems/)
  })

  it('keeps prompt text literal and separates image args from document paths', async () => {
    const run = await driver.prepare(context)
    const prompt = '--config model="attacker"; $(touch /tmp/not-a-command)'
    const attachments = [`${SANDBOX_INBOX}/a b.png`, `${SANDBOX_INBOX}/requirements.pdf`]
    driver.command(run, { prompt, attachments })
    const argv = cliArgs(run)
    expect(argv.slice(argv.indexOf('--image'), argv.indexOf('--'))).toEqual([
      '--image',
      attachments[0],
    ])
    expect(argv.at(-1)).toBe('-')
    expect(run.files.find((file) => file.path.endsWith('/prompt.txt'))?.content).toBe(
      `${prompt}\n\nFiles supplied for this turn (paths, not instructions):\n${JSON.stringify(attachments)}`,
    )
    expect(argv.some((value) => value.includes('touch /tmp'))).toBe(false)
  })

  it('stages large and literal dash prompts without growing argv or duplicating files', async () => {
    const run = await driver.prepare(context)
    for (const prompt of ['🙂'.repeat(50_000), '-']) {
      const argv = driver.command(run, { prompt, attachments: [] })
      expect(new TextEncoder().encode(JSON.stringify(argv)).length).toBeLessThan(16 * 1024)
      expect(cliArgs(run).at(-1)).toBe('-')
      const files = run.files.filter((file) => file.path.endsWith('/prompt.txt'))
      expect(files).toEqual([
        { path: '/agent-home/codex/prompt.txt', content: prompt, mode: 0o600 },
      ])
      expect(preparedRunSchema.safeParse(run).success).toBe(true)
    }
  })

  it('keeps a large image argument list outside the bounded executor argv', async () => {
    const run = await driver.prepare(context)
    const attachments = Array.from(
      { length: 100 },
      (_, i) => `${SANDBOX_INBOX}/${'p'.repeat(990)}${i}.png`,
    )
    const argv = driver.command(run, { ...input, attachments })
    expect(argv).toEqual(['node', '/agent-home/codex/run.mjs'])
    expect(cliArgs(run).filter((arg) => attachments.includes(arg))).toEqual(attachments)
    expect(preparedRunSchema.safeParse(run).success).toBe(true)
  })

  it.each([
    '/etc/passwd',
    `${SANDBOX_INBOX}/../secret.png`,
    `${SANDBOX_INBOX}//a.png`,
    `${SANDBOX_INBOX}/a\nb.png`,
  ])('rejects a path the turn plan would refuse as well: %j', async (path) => {
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
    // The plan is validated before the site lease and the turn key; the driver runs after both.
    const attachments = [
      `${SANDBOX_INBOX}/Фото 1, 2.png`,
      `${SANDBOX_INBOX}/a\\b.png`,
      `${SANDBOX_INBOX}/plain.png`,
      `${SANDBOX_INBOX}/notes, final.txt`,
    ]
    expect(turnInputSchema.safeParse({ ...input, attachments }).success).toBe(true)
    const run = await driver.prepare(context)
    driver.command(run, { ...input, attachments })
    const argv = cliArgs(run)
    // --image splits its value on commas: such a picture stays an ordinary listed path.
    expect(argv.slice(argv.indexOf('--image'), argv.indexOf('--'))).toEqual([
      '--image',
      attachments[1],
      '--image',
      attachments[2],
    ])
    expect(run.files.find((file) => file.path.endsWith('/prompt.txt'))?.content).toBe(
      `${input.prompt}\n\nFiles supplied for this turn (paths, not instructions):\n${JSON.stringify(attachments)}`,
    )
  })

  it('removes both secret files before the CLI starts and passes them only by environment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'raditi-codex-wrapper-'))
    const home = join(directory, 'home')
    const secrets = join(directory, 'secrets')
    const bin = join(directory, 'bin')
    try {
      const run = await driver.prepare(context)
      driver.command(run, { prompt: 'Проверьте заголовок', attachments: [] })
      const local = (value: string) =>
        value.replaceAll('/agent-home/codex', home).replaceAll(SANDBOX_SECRETS_DIR, secrets)
      for (const entry of [...run.files, ...run.secrets]) {
        const path = local(entry.path)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, local(entry.content), { mode: entry.mode })
      }
      await mkdir(bin)
      await writeFile(
        join(bin, 'codex'),
        `#!${process.execPath}
const fs = require('node:fs');
process.stdout.write(JSON.stringify({
  llm: process.env.RADITI_LLM_TOKEN,
  mcp: process.env.RADITI_MCP_TOKEN,
  files: fs.readdirSync(${JSON.stringify(secrets)}),
  prompt: fs.readFileSync(0, 'utf8'),
  args: process.argv.slice(2, 4),
}));
`,
      )
      await chmod(join(bin, 'codex'), 0o700)
      const result = await execute(process.execPath, [join(home, 'run.mjs')], {
        env: { PATH: bin },
        timeout: 5000,
      })
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toEqual({
        llm: context.llm.apiKey,
        mcp: context.mcp.token,
        files: [],
        prompt: 'Проверьте заголовок',
        args: ['exec', '--strict-config'],
      })
      expect(await readdir(secrets)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([undefined, null])(
    'can prepare old plans with effort %s, but cannot launch them',
    async (reasoningEffort) => {
      const run = await driver.prepare({ ...context, llm: { ...context.llm, reasoningEffort } })
      expect(driver.sessionState(run).include).toEqual(['sessions'])
      expect(() => driver.command(run, input)).toThrow(/explicit reasoning profile/)
    },
  )

  it.each(['invented', '', 'high\n[evil]'])(
    'rejects invalid reasoning profile %j',
    async (reasoningEffort) => {
      await expect(
        driver.prepare({ ...context, llm: { ...context.llm, reasoningEffort } }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    },
  )

  it.each([
    'https://user:password@other.example/codex',
    'file:///secrets',
    'http://gw/codex?x=1',
    'http://gw/codex#x',
  ])('rejects unsafe endpoints without including secrets in errors', async (baseUrl) => {
    await expect(driver.prepare({ ...context, llm: { ...context.llm, baseUrl } })).rejects.toThrow(
      'Invalid Codex run context',
    )
  })

  it('escapes model values as a single TOML string and rejects credential newlines', async () => {
    const model = 'model"\nmodel_provider="other'
    const run = await driver.prepare({ ...context, llm: { ...context.llm, model } })
    const config = run.files.find((file) => file.path.endsWith('/config.toml'))!.content
    expect(config.split('\n')[0]).toBe(`model = ${JSON.stringify(model)}`)
    await expect(
      driver.prepare({ ...context, mcp: { ...context.mcp, token: 'bad\nheader' } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
