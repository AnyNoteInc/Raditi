// Point 1 of G1, the crash: SIGSEGV to the CLI while a request hangs, with the sink as the only resolver.
// Does the Bun runtime report the crash anywhere, and which variable switches that off (point 5)?
// The reporter of Bun is a detached `curl`; the wrapper kills the CLI's process group when the CLI ends, so
// the runs are made both with and without that kill. The first run proves that the sink sees `curl`.
import { newTokens, sleep } from './lib.mjs'
import { scenario, sinkOf, staged } from './p1.mjs'

const KILL =
  'for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = opencode ] && kill -SEGV ${p#/proc/} && echo killed ${p#/proc/}; done'

async function sinkSeesCurl(stand) {
  const mark = (await stand.sink()).length
  const cli = await stand.cli('p1-crash-sink-control')
  const curl = await cli.exec([
    'sh',
    '-c',
    'curl -sS -m 5 -o /dev/null -w "%{http_code}" http://sink-control.test/x; echo " curl-exit=$?"',
  ])
  const sink = sinkOf(await stand.sink(), mark, cli.facts.ip)
  await cli.remove()
  return {
    curl: curl.stdout.trim(),
    sink: sink.map((item) => `${item.kind} ${item.name ?? item.host}`),
  }
}

async function crash(stand, variant, env, group) {
  const name = `p1-crash-${variant}`
  const tokens = newTokens()
  await stand.scenario(
    name,
    scenario(tokens, [{ kind: 'sse', label: 'hang', end: 'hang', events: [] }]),
  )
  const mark = (await stand.sink()).length
  const cli = await stand.cli(name)
  await cli.stage(staged(name, tokens))
  const turning = cli.turn({
    prompt: 'Client request: wait',
    env,
    needles: tokens,
    timeoutS: 90,
    group,
    inspect: false,
  })
  let seen = 0
  for (let attempt = 0; attempt < 150 && !seen; attempt += 1) {
    await sleep(200)
    seen = (await stand.records(name)).llm
  }
  const kill = await cli.exec(['sh', '-c', KILL])
  const turn = await turning
  // Time for a detached reporter to resolve a name and connect.
  await sleep(8_000)
  const sink = sinkOf(await stand.sink(), mark, cli.facts.ip)
  await cli.remove()
  const stderr = turn.stderrHead + turn.stderrTail
  return {
    variant,
    env,
    group,
    requestSeen: seen > 0,
    kill: kill.stdout.trim(),
    exit: turn.exit,
    signal: turn.wrapper.signal,
    panic: /panic[^\n]*/.exec(stderr)?.[0],
    advice: /To send a redacted crash report[^\n]*\n[^\n]*/.exec(stderr)?.[0],
    sink: sink.map((item) => `${item.kind} ${item.name ?? item.sni ?? item.host ?? item.target}`),
    outputHits: turn.outputHits,
  }
}

export async function p1crash(stand) {
  const out = { sinkSeesCurl: await sinkSeesCurl(stand), runs: [] }
  out.runs.push(await crash(stand, 'default', {}, 'kill'))
  out.runs.push(await crash(stand, 'default-keep-group', {}, 'keep'))
  out.runs.push(
    await crash(stand, 'enabled-keep-group', { BUN_ENABLE_CRASH_REPORTING: '1' }, 'keep'),
  )
  out.runs.push(
    await crash(stand, 'enabled-kill-group', { BUN_ENABLE_CRASH_REPORTING: '1' }, 'kill'),
  )
  out.runs.push(
    await crash(
      stand,
      'enabled-do-not-track',
      { BUN_ENABLE_CRASH_REPORTING: '1', DO_NOT_TRACK: '1' },
      'keep',
    ),
  )
  out.runs.push(
    await crash(
      stand,
      'forced-url-keep-group',
      { BUN_CRASH_REPORT_URL: 'http://crash-report-control.test' },
      'keep',
    ),
  )
  out.runs.push(
    await crash(
      stand,
      'forced-url-disabled',
      { BUN_CRASH_REPORT_URL: 'http://crash-report-control.test', BUN_ENABLE_CRASH_REPORTING: '0' },
      'keep',
    ),
  )
  out.runs.push(await crash(stand, 'disabled', { BUN_ENABLE_CRASH_REPORTING: '0' }, 'keep'))
  return out
}
