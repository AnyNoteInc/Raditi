// Point 6 of G1 — the CLI's own MCP connection fails: the stub accepts the wrapper's `initialize` and
// refuses the CLI's. What does the CLI print, log and send, and does the turn still run?
import {
  AGENTS_MARKER,
  config,
  newTokens,
  pool,
  resultStep,
  save,
  sha256,
  summariseRecords,
  toolStep,
} from './lib.mjs'

const WARN_LOG = ['--print-logs', '--log-level', 'WARN']
const CASES = {
  // Control: both connections succeed.
  ok: { mcp: {}, wrapperCheck: true, args: WARN_LOG },
  'refused-401': {
    mcp: { failInitialize: { from: 2, how: 401 } },
    wrapperCheck: true,
    args: WARN_LOG,
  },
  'refused-500': {
    mcp: { failInitialize: { from: 2, how: 500 } },
    wrapperCheck: true,
    args: WARN_LOG,
  },
  'refused-rpc-error': {
    mcp: { failInitialize: { from: 2, how: 'rpc-error' } },
    wrapperCheck: true,
    args: WARN_LOG,
  },
  'refused-destroy': {
    mcp: { failInitialize: { from: 2, how: 'destroy' } },
    wrapperCheck: true,
    args: WARN_LOG,
  },
  'refused-hang': {
    mcp: { failInitialize: { from: 2, how: 'hang' } },
    wrapperCheck: true,
    timeout: 5000,
    args: WARN_LOG,
  },
  // A dead server: nothing listens on the port.
  'dead-port': { mcp: {}, wrapperCheck: false, url: 'http://sandbox-gw:9/mcp', args: WARN_LOG },
  // The same refusal without any flag (what the log file keeps) and with the whole log on stderr.
  'refused-401-no-flags': { mcp: { failInitialize: { from: 2, how: 401 } }, wrapperCheck: true },
  'refused-401-print-logs-info': {
    mcp: { failInitialize: { from: 2, how: 401 } },
    wrapperCheck: true,
    args: ['--print-logs'],
  },
  // The scripted model calls the MCP tool that was never declared.
  'refused-401-model-calls-tool': {
    mcp: { failInitialize: { from: 2, how: 401 } },
    wrapperCheck: true,
    callTool: true,
    args: WARN_LOG,
  },
}

async function one(stand, name, { mcp, wrapperCheck, url, timeout, args = [], callTool }) {
  const run = `p6-${name}`
  const tokens = newTokens()
  const steps = callTool
    ? [toolStep([{ name: 'raditi_site_info', arguments: {} }]), resultStep()]
    : [resultStep()]
  await stand.scenario(run, {
    llmKeySha256: sha256(tokens.llm),
    mcpTokenSha256: sha256(tokens.mcp),
    steps,
    mcp,
  })
  const cli = await stand.cli(run)
  const value = config(run, (draft) => {
    if (url) draft.mcp.raditi.url = url
    if (timeout) draft.mcp.raditi.timeout = timeout
  })
  await cli.stage({
    configText: JSON.stringify(value, null, 2),
    agentsMd: `${AGENTS_MARKER}\n`,
    secrets: tokens,
  })
  const turn = await cli.turn({
    prompt: 'Client request: say ok',
    needles: tokens,
    args,
    timeoutS: 120,
    mcpCheck: wrapperCheck ? `http://sandbox-gw:8080/s/${run}/mcp` : undefined,
  })
  const records = await stand.records(run)
  save(stand, run, 'records.json', records)
  const log = (
    await cli.exec(['sh', '-c', 'cat /agent-home/opencode/.local/share/opencode/log/*.log'])
  ).stdout
  await cli.remove()
  const requests = summariseRecords(records)
  const first = records.records.find((record) => record.kind === 'llm')
  const clean = (line) =>
    line
      .replace(/^timestamp=\S+ /, '')
      .replace(/run=[0-9a-f]+ /, '')
      .slice(0, 330)
  const stderrLines = (turn.stderrHead + turn.stderrTail).split('\n').filter(Boolean)
  const logLines = log.split('\n').filter(Boolean)
  return {
    case: name,
    exit: turn.exit,
    wallS: Math.round(turn.wallMs / 100) / 10,
    wrapperCheck: turn.wrapper.mcpCheck,
    firstRequestMs: requests.firstRequestMs,
    llmRequests: requests.llmRequests,
    mcpRequests: requests.mcp,
    raditiToolsDeclared:
      first?.request.summary.tools?.filter((tool) => tool.startsWith('raditi_')) ?? null,
    events: turn.eventCounts,
    stepReasons: turn.steps.map((step) => step.reason),
    tools: turn.tools.map((tool) => `${tool.tool}:${tool.status}:${tool.output.slice(0, 160)}`),
    finalText: turn.texts.at(-1)?.slice(0, 60),
    errors: turn.errors,
    nonJsonStdout: turn.nonJsonStdout,
    stderrLines: turn.stderrLines,
    stderrWarnings: stderrLines.filter((line) => /level=(WARN|ERROR)/.test(line)).map(clean),
    stderrOther: stderrLines.filter((line) => !/level=/.test(line)).slice(0, 4),
    logFileLines: logLines.length,
    logFileWarnings: logLines.filter((line) => /level=(WARN|ERROR)/.test(line)).map(clean),
    logFileLast: clean(logLines.at(-1) ?? ''),
    hits: [...turn.outputHits, ...turn.left.hits],
  }
}

export async function p6(stand) {
  const names = Object.keys(CASES)
  return {
    cases: await pool(
      names.map((name) => () => one(stand, name, CASES[name])),
      Number(process.env.SPIKE_PARALLEL ?? 3),
    ),
  }
}
