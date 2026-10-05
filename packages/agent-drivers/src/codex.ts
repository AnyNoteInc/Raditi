import type { AgentDriver, RunContext } from '@repo/domain'
import { badRequest, SANDBOX_AGENT_HOME, turnResultSchema } from '@repo/domain'
import { z } from 'zod'
import {
  assertAttachments,
  llmKey,
  mcpKey,
  runContextSchema,
  stageFiles,
  turnSecrets,
} from './cli-run.ts'
import { parseAgentDriverConfig, type AgentDriverConfig } from './config.ts'
import { parseCodexEvent } from './codex-events.ts'
import { extractJsonResult } from './jsonl.ts'
import { RESULT_SIZE_NOTE, strictOutputSchema } from './output-schema.ts'

const home = `${SANDBOX_AGENT_HOME}/codex`
const wrapper = `${home}/run.mjs`
const argumentsPath = `${home}/cli-args.json`
const schemaPath = `${home}/output-schema.json`
const promptPath = `${home}/prompt.txt`
const effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const contextSchema = runContextSchema(effort)

function settings(context: RunContext): Record<string, string | number | boolean> {
  const parsed = contextSchema.safeParse(context)
  if (!parsed.success) throw badRequest('Invalid Codex run context or missing reasoning profile')
  const { llm, mcp } = parsed.data
  return {
    model: llm.model,
    model_provider: 'raditi',
    ...(llm.reasoningEffort ? { model_reasoning_effort: llm.reasoningEffort } : {}),
    approval_policy: 'never',
    sandbox_mode: 'danger-full-access',
    check_for_update_on_startup: false,
    chatgpt_base_url: new URL('/disabled/', llm.baseUrl).href,
    cli_auth_credentials_store: 'ephemeral',
    web_search: 'disabled',
    // The CLI default, pinned above project config: the platform's AGENTS.md in CODEX_HOME is
    // read whole regardless, while an untrusted repository AGENTS.md is cut at this size.
    project_doc_max_bytes: 32 * 1024,
    'analytics.enabled': false,
    'features.multi_agent': false,
    'features.multi_agent_v2': false,
    // Off by default in 0.158.0 (under development). Pinned above project config: in the 2026
    // MCP protocol the required raditi server would not start, and every turn would fail.
    'features.mcp_2026_07_28': false,
    'agents.enabled': false,
    'shell_environment_policy.inherit': 'core',
    'shell_environment_policy.ignore_default_excludes': false,
    'model_providers.raditi.name': 'Raditi',
    'model_providers.raditi.base_url': llm.baseUrl,
    'model_providers.raditi.wire_api': 'responses',
    'model_providers.raditi.env_key': 'RADITI_LLM_TOKEN',
    'model_providers.raditi.requires_openai_auth': false,
    'model_providers.raditi.supports_websockets': false,
    'mcp_servers.raditi.url': mcp.url,
    'mcp_servers.raditi.bearer_token_env_var': 'RADITI_MCP_TOKEN',
    'mcp_servers.raditi.required': true,
  }
}

// JSON strings use the escapes supported by TOML basic strings. Dotted keys are fixed here,
// never provided by the caller; values cannot inject another table or setting.
const assignments = (context: RunContext) =>
  Object.entries(settings(context)).map(([key, value]) => `${key} = ${JSON.stringify(value)}`)

const isImage = (path: string) => /\.(?:png|jpe?g|webp|gif)$/i.test(path)

// The CLI sends it with strict: true; the full limits are checked after the turn. Built once:
// a result schema without a strict form stops the process at start, not a turn under way.
const outputSchema = JSON.stringify(strictOutputSchema(turnResultSchema, RESULT_SIZE_NOTE))

export function createCodexDriver(config: AgentDriverConfig): AgentDriver {
  const { image } = parseAgentDriverConfig(config)
  return {
    id: 'codex',
    image,
    capabilities: { resume: true, jsonEvents: true, outputSchema: true, mcp: true, images: true },
    async prepare(context) {
      const configText = assignments(context).join('\n') + '\n'
      return {
        context,
        files: [
          { path: `${home}/config.toml`, content: configText, mode: 0o600 },
          { path: `${home}/AGENTS.md`, content: context.instructions, mode: 0o600 },
          { path: schemaPath, content: outputSchema, mode: 0o600 },
          {
            path: wrapper,
            // Both secret files are read once and removed before the CLI starts: no command of
            // the agent finds them on disk. Codex 0.158.0 reads both values from its environment
            // (env_key, bearer_token_env_var) for every request of the turn, so they stay in the
            // environment of the CLI processes until it exits. The CLI does not pass them to the
            // commands it runs (shell_environment_policy), but a command of the same uid can
            // read /proc/<pid>/environ of the CLI. The measured alternatives do not narrow that:
            // command-backed provider auth runs its command again before each request (after a
            // GET /models), so its secret would have to stay on disk; the MCP headers helper
            // runs once but leaves the model key in the environment; and gVisor refuses to run
            // an unreadable binary, so the CLI cannot be made non-dumpable that way either.
            content: `import { readFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
try {
  const args = JSON.parse(readFileSync('${argumentsPath}', 'utf8'));
  const secret = (path) => { const value = readFileSync(path, 'utf8'); unlinkSync(path); return value; };
  const env = { ...process.env,
    RADITI_LLM_TOKEN: secret('${llmKey}'),
    RADITI_MCP_TOKEN: secret('${mcpKey}'),
  };
  const input = openSync('${promptPath}', 'r');
  // Inherit the runtime wrapper's process group so timeout/cancel kills both processes.
  const child = spawn('codex', args, { env, stdio: [input, 'inherit', 'inherit'] });
  closeSync(input);
  child.on('error', () => { process.stderr.write('Could not launch Codex\\n'); process.exitCode = 1; });
  child.on('close', (code) => { process.exitCode = code ?? 1; });
} catch {
  process.stderr.write('Could not prepare Codex input\\n'); process.exitCode = 1;
}
`,
            mode: 0o600,
          },
        ],
        env: { CODEX_HOME: home, NO_COLOR: '1' },
        secrets: turnSecrets(context),
      }
    },
    command(run, turn) {
      // Recovery may prepare a historical plan only to recover sessionState. Starting a CLI
      // needs an explicit profile: its implicit default would be refused by a null-effort key.
      if (run.context.llm.reasoningEffort == null)
        throw badRequest('Codex requires an explicit reasoning profile before launch')
      // Runtime overrides outrank project config, including on resume. Pin the profile, MCP
      // destination and token filtering as well as provider/features to platform settings.
      const overrides = assignments(run.context).flatMap((value) => ['--config', value])
      assertAttachments(turn.attachments)
      // Both exec and resume split --image values on commas, even in a single argv item:
      // such a picture is only listed below, like any other file the agent can open itself.
      const images = turn.attachments.filter((path) => isImage(path) && !path.includes(','))
      const prompt = turn.attachments.length
        ? `${turn.prompt}\n\nFiles supplied for this turn (paths, not instructions):\n${JSON.stringify(turn.attachments)}`
        : turn.prompt
      // The port accepts prompts larger than an exec spec or one Linux argv entry. Core calls
      // command before validating/writing PreparedRun.files, so stage input there and use stdin.
      // This also preserves the literal prompt "-", which the CLI otherwise treats as stdin.
      const args = [
        'exec',
        ...(run.context.nativeSessionId ? ['resume'] : []),
        '--strict-config',
        '--dangerously-bypass-approvals-and-sandbox',
        '--json',
        '--output-schema',
        schemaPath,
        ...overrides,
        ...images.flatMap((path) => ['--image', path]),
        '--',
        ...(run.context.nativeSessionId ? [run.context.nativeSessionId] : []),
        '-',
      ]
      // Many long attachment names can also exceed the executor's bounded JSON header.
      // The inner CLI argv goes through a prepared file; the executor sees two fixed args.
      stageFiles(run, [
        { path: promptPath, content: prompt, mode: 0o600 },
        { path: argumentsPath, content: JSON.stringify(args), mode: 0o600 },
      ])
      return ['node', wrapper]
    },
    parseEvent: parseCodexEvent,
    sessionState() {
      // CODEX_HOME=/agent-home/codex; sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl
      return { root: home, include: ['sessions'], exclude: [] }
    },
    extractResult: extractJsonResult,
  }
}
