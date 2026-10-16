// Point 1 of G1 — the runtime: does the Bun executable work under the given runtime with the stand's
// limits? `--version`, a turn with tools, a continuation in a new container from the two session files and
// a product-like start without any resolver. The crash runs are p1crash.mjs.
import {
  AGENTS_MARKER,
  HOME,
  config,
  newTokens,
  resultStep,
  save,
  sha256,
  sleep,
  summariseRecords,
  toolStep,
} from './lib.mjs'

export const staged = (runId, tokens) => ({
  configText: JSON.stringify(config(runId), null, 2),
  agentsMd: `${AGENTS_MARKER}\nWork only inside /workspace/repo.\n`,
  secrets: tokens,
})
export const scenario = (tokens, steps, extra = {}) => ({
  llmKeySha256: sha256(tokens.llm),
  mcpTokenSha256: sha256(tokens.mcp),
  steps,
  ...extra,
})

export const sinkOf = (sink, mark, ip) =>
  sink.slice(mark).filter((item) => item.from === ip || item.from === `::ffff:${ip}`)

async function version(stand) {
  const cli = await stand.cli('p1-version')
  const script = `head -c 60 /proc/version; echo; for n in 1 2; do s=$(date +%s%N); HOME=${HOME} opencode --version; c=$?; e=$(date +%s%N); echo "exit=$c ms=$(( (e - s) / 1000000 ))"; done`
  const result = await cli.exec(['sh', '-c', script])
  await cli.remove()
  return {
    runtime: cli.facts.runtime,
    output: result.stdout.trim().split('\n'),
    stderr: result.stderr.slice(0, 300),
  }
}

async function turnAndContinue(stand) {
  const first = newTokens()
  const mark = (await stand.sink()).length
  await stand.scenario(
    'p1-turn',
    scenario(first, [
      toolStep([
        {
          name: 'bash',
          arguments: {
            command: 'echo hello-from-tool; id -u; head -c 40 /proc/version',
            description: 'look around',
          },
        },
        {
          name: 'write',
          arguments: {
            content: 'written by the first turn\n',
            filePath: '/workspace/repo/hello.txt',
          },
        },
      ]),
      resultStep({ change_type: 'code', files_changed: ['hello.txt'] }),
    ]),
  )
  const cli = await stand.cli('p1-turn')
  await cli.stage(staged('p1-turn', first))
  const turn = await cli.turn({
    label: 'first',
    prompt: 'Client request: create hello.txt',
    needles: first,
  })
  const written = (await cli.exec(['cat', '/workspace/repo/hello.txt'])).stdout
  const tar = await cli.saveSession()
  const firstRecords = await stand.records('p1-turn')
  save(stand, 'p1-turn', 'records.json', firstRecords)
  const firstSink = sinkOf(await stand.sink(), mark, cli.facts.ip)
  await cli.remove()

  // A new container: nothing of the first one but the two session files and the work tree's history.
  const second = newTokens()
  const mark2 = (await stand.sink()).length
  await stand.scenario(
    'p1-continue',
    scenario(second, [
      toolStep([
        {
          name: 'bash',
          arguments: { command: 'cat hello.txt 2>&1 | head -2', description: 'check' },
        },
      ]),
      resultStep(),
    ]),
  )
  const next = await stand.cli('p1-continue')
  await next.stage(staged('p1-continue', second))
  await next.restoreSession(tar)
  const resumed = await next.turn({
    label: 'second',
    prompt: 'Client request: what did you do before?',
    args: ['--session', turn.sessionId],
    needles: { ...second, oldLlm: first.llm, oldMcp: first.mcp },
  })
  const records = await stand.records('p1-continue')
  save(stand, 'p1-continue', 'records.json', records)
  const secondSink = sinkOf(await stand.sink(), mark2, next.facts.ip)
  await next.remove()
  const firstRequest = records.records.find((record) => record.kind === 'llm')
  return {
    first: {
      exit: turn.exit,
      wallMs: turn.wallMs,
      wrapper: turn.wrapper,
      steps: turn.steps.map((step) => step.reason),
      tools: turn.tools.map((tool) => `${tool.tool}:${tool.status}`),
      bashOutput: turn.tools.find((tool) => tool.tool === 'bash')?.output,
      written,
      result: turn.texts.at(-1),
      errors: turn.errors,
      stderr: turn.stderrHead,
      requests: summariseRecords(firstRecords),
      sink: firstSink,
      hits: [...turn.outputHits, ...turn.left.hits],
      files: turn.left.files.map((file) => `${file.path} ${file.size}`),
    },
    sessionTarBytes: tar.length,
    second: {
      exit: resumed.exit,
      wallMs: resumed.wallMs,
      sameSession: resumed.sessionId === turn.sessionId,
      steps: resumed.steps.map((step) => step.reason),
      errors: resumed.errors,
      stderr: resumed.stderrHead,
      requests: summariseRecords(records),
      historyInFirstRequest: firstRequest?.request.summary.messages,
      sink: secondSink,
      hits: [...resumed.outputHits, ...resumed.left.hits],
    },
  }
}

/** The product's sandbox has no resolver at all: the gateway name comes from /etc/hosts. */
async function withoutResolver(stand) {
  const tokens = newTokens()
  await stand.scenario('p1-noresolver', scenario(tokens, [resultStep()]))
  const cli = await stand.cli('p1-noresolver', { dnsSink: false })
  await cli.stage(staged('p1-noresolver', tokens))
  const resolv = (await cli.exec(['cat', '/etc/resolv.conf'])).stdout
    .trim()
    .split('\n')
    .filter((line) => !line.startsWith('#'))
  const turn = await cli.turn({ prompt: 'Client request: say ok', needles: tokens })
  const records = await stand.records('p1-noresolver')
  await cli.remove()
  return {
    exit: turn.exit,
    wallMs: turn.wallMs,
    resolv,
    requests: summariseRecords(records),
    errors: turn.errors,
    stderr: turn.stderrHead,
  }
}

/** Bun unpacks a native library into /tmp at start: does the CLI run when /tmp forbids execution? */
async function noexecTmp(stand) {
  const tokens = newTokens()
  await stand.scenario('p1-noexec-tmp', scenario(tokens, [resultStep()]))
  const cli = await stand.cli('p1-noexec-tmp', { tmp: 'rw,noexec,nosuid,nodev' })
  await cli.stage(staged('p1-noexec-tmp', tokens))
  const turn = await cli.turn({ prompt: 'Client request: say ok', needles: tokens, timeoutS: 60 })
  const records = await stand.records('p1-noexec-tmp')
  const tmpFiles = turn.left.files
    .filter((file) => file.path.startsWith('/tmp/') && !file.path.includes('wrapper'))
    .map((file) => `${file.path.replace(/[0-9a-f]{16}/, '<hex>')} ${file.size}`)
  await cli.remove()
  return {
    exit: turn.exit,
    requests: summariseRecords(records).llmRequests,
    events: turn.eventCounts,
    errors: turn.errors,
    stderr: turn.stderrHead.slice(0, 500),
    tmpFiles,
  }
}

/** Memory and processes of the container while a request hangs, then SIGTERM to the wrapper. */
async function footprint(stand) {
  const tokens = newTokens()
  await stand.scenario(
    'p1-footprint',
    scenario(tokens, [{ kind: 'sse', label: 'hang', end: 'hang', events: [] }]),
  )
  const cli = await stand.cli('p1-footprint')
  await cli.stage(staged('p1-footprint', tokens))
  const turning = cli.turn({ prompt: 'Client request: wait', needles: tokens, timeoutS: 90 })
  let seen = 0
  for (let attempt = 0; attempt < 150 && !seen; attempt += 1) {
    await sleep(200)
    seen = (await stand.records('p1-footprint')).llm
  }
  const stats = (
    await stand.docker([
      'stats',
      '--no-stream',
      '--format',
      '{{.MemUsage}} | pids {{.PIDs}} | cpu {{.CPUPerc}}',
      cli.container,
    ])
  ).stdout.trim()
  const processes = (
    await cli.exec([
      'sh',
      '-c',
      'for p in /proc/[0-9]*; do echo "$(cat $p/comm) threads=$(grep Threads $p/status | tr -dc 0-9) rssKb=$(grep VmRSS $p/status | tr -dc 0-9) nproc=$(nproc)"; done',
    ])
  ).stdout
    .trim()
    .split('\n')
    .filter((line) => !/^(sh|cat|grep|tr) /.test(line))
  const termAt = Date.now()
  const term = await cli.exec([
    'sh',
    '-c',
    'for p in /proc/[0-9]*; do [ "$p" != "/proc/$$" ] && [ "$(cat $p/comm 2>/dev/null)" != sh ] && grep -q wrapper.mjs $p/cmdline 2>/dev/null && kill -TERM ${p#/proc/} && echo signalled ${p#/proc/}; done',
  ])
  const turn = await turning
  const left = (
    await cli.exec([
      'sh',
      '-c',
      'for p in /proc/[0-9]*; do cat $p/comm 2>/dev/null; done | grep -v -E "^(sh|cat|sort|uniq|tr|grep)$" | sort | uniq -c | tr "\n" ";"',
    ])
  ).stdout
  await cli.remove()
  return {
    requestSeen: seen > 0,
    stats,
    processes,
    sigterm: term.stdout.trim(),
    endedAfterMs: Date.now() - termAt,
    exit: turn.exit,
    wrapper: { exit: turn.wrapper.exit, signal: turn.wrapper.signal },
    events: turn.eventCounts,
    errors: turn.errors,
    processesLeft: left,
  }
}

export async function p1(stand) {
  return {
    version: await version(stand),
    turns: await turnAndContinue(stand),
    withoutResolver: await withoutResolver(stand),
    noexecTmp: await noexecTmp(stand),
    footprint: await footprint(stand),
  }
}
