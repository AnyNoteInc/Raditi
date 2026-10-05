// Point 2 of G1 — one-shot keys on a full turn: five model requests with two MCP calls, then a continuation
// in a new container with new keys. A command of the model looks for the keys in its environment, in
// /proc/<pid>/environ, in the secrets directory and in the memory of the other processes; after each turn
// the files the CLI left are searched for both values in every form. Controls: the same turn with the keys
// in plain files and in the environment (the checks must find them there), and a CLI that ends without
// reading the pipes (the wrapper must end with it).
import {
  AGENTS_MARKER,
  config,
  newTokens,
  resultStep,
  save,
  sha256,
  summariseRecords,
  toolStep,
} from './lib.mjs'

const SENSITIVE_TABLES = [
  'credential',
  'account',
  'account_state',
  'control_account',
  'permission',
  'session_share',
]
const checkCall = (labels) => ({
  name: 'bash',
  arguments: {
    command: `node /spike/in/toolcheck.mjs ${Object.entries(labels)
      .map(([label, value]) => `${label}=${sha256(value)}`)
      .join(' ')}`,
    description: 'look for credentials',
    timeout: 60_000,
  },
})
const scenario = (tokens, steps) => ({
  llmKeySha256: sha256(tokens.llm),
  mcpTokenSha256: sha256(tokens.mcp),
  steps,
})
const stage = (runId, tokens, change) => ({
  configText: JSON.stringify(config(runId, change), null, 2),
  agentsMd: `${AGENTS_MARKER}\nWork only inside /workspace/repo.\n`,
  secrets: tokens,
})

function digest(turn, records) {
  const check = turn.tools.find((tool) => tool.tool === 'bash')
  let seen
  try {
    seen = JSON.parse(check?.output ?? '')
  } catch {
    seen = { unparsed: check?.output?.slice(0, 600), status: check?.status }
  }
  const tables = turn.left?.db?.tables ?? {}
  return {
    exit: turn.exit,
    wallMs: turn.wallMs,
    wrapper: turn.wrapper,
    steps: turn.steps.map((step) => step.reason),
    tools: turn.tools.map((tool) => `${tool.tool}:${tool.status}`),
    finalText: turn.texts.at(-1)?.slice(0, 120),
    errors: turn.errors,
    stderr: turn.stderrHead.slice(0, 500),
    requests: summariseRecords(records),
    seenByTheModel: seen.processes
      ? {
          ownEnvNames: seen.own.envNames,
          ownEnvHolds: seen.own.envHolds,
          processes: seen.processes.map((item) => ({
            comm: item.comm,
            self: item.self || undefined,
            threads: item.threads,
            rssMiB: Math.round(item.rssKb / 1024),
            peakMiB: Math.round(item.peakKb / 1024),
            cmdlineHolds: item.cmdlineHolds,
            environ: item.environ.readable
              ? { names: item.environ.names, holds: item.environ.holds }
              : item.environ.error,
            memory: item.memory,
          })),
          secretsDir: seen.secretsDir,
          budget: seen.budget,
          ptraceScope: seen.ptraceScope,
        }
      : seen,
    outputHits: turn.outputHits,
    fileHits: turn.left?.hits,
    sensitiveTables: Object.fromEntries(SENSITIVE_TABLES.map((table) => [table, tables[table]])),
    files: turn.left?.files.map(
      (file) => `${file.path} ${file.size}${file.type === 'file' ? '' : ` (${file.type})`}`,
    ),
  }
}

async function fullTurn(stand, name, { secrets, change }) {
  const first = newTokens()
  await stand.scenario(
    name,
    scenario(first, [
      toolStep([checkCall(first)]),
      toolStep([{ name: 'raditi_site_info', arguments: {} }]),
      toolStep([{ name: 'raditi_wp_rest', arguments: { method: 'GET', path: '/wp/v2/pages/7' } }]),
      toolStep([
        {
          name: 'write',
          arguments: { content: 'written by the turn\n', filePath: '/workspace/repo/hello.txt' },
        },
      ]),
      resultStep({ change_type: 'code', files_changed: ['hello.txt'] }),
    ]),
  )
  const cli = await stand.cli(name)
  await cli.stage(stage(name, first, change))
  const turn = await cli.turn({
    label: 'first',
    prompt: 'Client request: look at the site and create hello.txt',
    secrets,
    needles: first,
  })
  const records = await stand.records(name)
  save(stand, name, 'first.records.json', records)
  const out = { first: digest(turn, records) }
  if (secrets !== 'fifo') {
    await cli.remove()
    return out
  }
  const tar = await cli.saveSession()
  await cli.remove()

  // Continuation: a new container, the two session files, new keys, and the wrapper's own MCP check.
  const second = newTokens()
  const all = { ...second, oldLlm: first.llm, oldMcp: first.mcp }
  await stand.scenario(
    `${name}-next`,
    scenario(second, [
      toolStep([checkCall(all)]),
      toolStep([{ name: 'raditi_site_info', arguments: {} }]),
      resultStep(),
    ]),
  )
  const next = await stand.cli(`${name}-next`)
  await next.stage(stage(`${name}-next`, second, change))
  await next.restoreSession(tar)
  const resumed = await next.turn({
    label: 'second',
    prompt: 'Client request: look at the site again',
    args: ['--session', turn.sessionId],
    secrets,
    needles: all,
    mcpCheck: `http://sandbox-gw:8080/s/${name}-next/mcp`,
  })
  const nextRecords = await stand.records(`${name}-next`)
  save(stand, `${name}-next`, 'second.records.json', nextRecords)
  out.second = {
    sameSession: resumed.sessionId === turn.sessionId,
    ...digest(resumed, nextRecords),
  }
  await next.remove()
  return out
}

/** A CLI that ends before it has read a pipe: how long does the wrapper live, and what stays? */
async function unread(stand, name, { change, command, configText }) {
  const tokens = newTokens()
  await stand.scenario(name, scenario(tokens, [resultStep()]))
  const cli = await stand.cli(name)
  await cli.stage({ ...stage(name, tokens, change), ...(configText ? { configText } : {}) })
  const turn = await cli.turn({
    prompt: 'Client request: say ok',
    needles: tokens,
    command,
    timeoutS: 60,
  })
  const records = await stand.records(name)
  await cli.remove()
  return {
    exit: turn.exit,
    wrapper: turn.wrapper,
    wallMs: turn.wallMs,
    stdoutEvents: turn.eventCounts,
    nonJsonStdout: turn.nonJsonStdout,
    stderr: turn.stderrHead.slice(0, 500),
    requests: summariseRecords(records).llmRequests,
    secretsDirAfter: turn.left.files
      .filter((file) => file.path.startsWith('/run/raditi/'))
      .map((file) => `${file.path} (${file.type})`),
    hits: [...turn.outputHits, ...turn.left.hits],
  }
}

export async function p2(stand) {
  const out = {}
  out.fifo = await fullTurn(stand, 'p2-fifo', { secrets: 'fifo' })
  out.controlPlainFiles = await fullTurn(stand, 'p2-plain', { secrets: 'plain' })
  out.controlEnvironment = await fullTurn(stand, 'p2-env', {
    secrets: 'env',
    change: (value) => {
      value.provider.raditi.options.apiKey = '{env:RADITI_LLM_KEY}'
      value.mcp.raditi.headers.Authorization = 'Bearer {env:RADITI_MCP_TOKEN}'
    },
  })
  out.unreadBrokenJson = await unread(stand, 'p2-broken-json', {
    configText: '{ "model": "raditi/glm-5.3", ',
  })
  out.unreadMissingFile = await unread(stand, 'p2-missing-file', {
    change: (value) => {
      value.provider.raditi.options.headers = { 'x-stand': '{file:/run/raditi/secrets/absent}' }
    },
  })
  out.unreadNotACli = await unread(stand, 'p2-not-a-cli', {
    command: ['sh', '-c', 'sleep 1; exit 3'],
  })
  return out
}
