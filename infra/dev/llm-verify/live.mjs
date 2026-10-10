// The live mode of the stands: the same path as the synthetic one — sandbox → sandbox-gw → role
// llm → provider — with the real provider at its end (GLM on api.z.ai, reached by the role
// itself, without an egress node). What a live run needs beyond a synthetic one is here: when it
// refuses to start, how the plan key is held, how many requests it may send, what the stand can
// still see of an exchange it no longer scripts, what depends on the model and what does not,
// and the search for the key at the end of a run and after a failure.
// Commands and limits: infra/dev/llm-verify/README.md, «Живой режим».
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { isAbsolute, join, relative, sep } from 'node:path'
import { clearInterval, setInterval } from 'node:timers'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'

const repository = fileURLToPath(new URL('../../../', import.meta.url))

/** The one address a live run may reach outside this machine. */
export const PROVIDER = Object.freeze({ host: 'api.z.ai', port: 443 })

/**
 * Provider requests (generations and quota probes together) and minutes a live run may take.
 * The request cap is held by live-guard.mjs in every process that can reach the provider.
 */
export const LIVE_LIMITS = Object.freeze({
  gateway: Object.freeze({ requests: 20, minutes: 10 }),
  content: Object.freeze({ requests: 30, minutes: 20 }),
  measure: Object.freeze({ requests: 40, minutes: 20 }),
})
/** Above these a run does not start: the checks must not take the plan's last capacity. */
const WINDOW_START_LIMITS = Object.freeze({ '5h': 50, week: 80 })
/** Percentage points of the five-hour window one run may take. */
export const WINDOW_GROWTH_LIMIT = 5

/** A reason not to start that is safe to print: it names variables, never their values. */
export class LiveRefusal extends Error {
  refusal = true
}

/**
 * The options of a stand. `--live` is the real provider, `--rehearsal` the same flow on the
 * synthetic one; `--measure`, with either, is the measurement of the gateway stand;
 * `--keep=<directory>` writes the exchanges the stand observed, for sanitize-samples.mjs.
 */
export function standMode(argv, { stand }) {
  const mode = { live: false, measure: false, rehearsal: false, noBuild: false, keep: null }
  const refuse = (option) => new Error(`Unsupported option: ${option}`)
  const seen = new Set()
  for (const arg of argv) {
    // pnpm passes the separator on.
    if (arg === '--') continue
    const [name, value] = arg.startsWith('--keep=') ? ['--keep', arg.slice(7)] : [arg]
    if (seen.has(name)) throw refuse(name)
    seen.add(name)
    if (name === '--no-build') mode.noBuild = true
    else if (name === '--live') mode.live = true
    else if (name === '--rehearsal') mode.rehearsal = true
    else if (name === '--measure' && stand === 'gateway') mode.measure = true
    else if (name === '--keep' && isAbsolute(value) && outsideRepository(value)) mode.keep = value
    else throw refuse(name)
  }
  if (mode.live && mode.rehearsal) throw refuse('--live with --rehearsal')
  if (mode.measure && !mode.live && !mode.rehearsal) throw refuse('--measure without --live')
  if (mode.keep && !mode.live && !mode.rehearsal) throw refuse('--keep without --live')
  return mode
}

function outsideRepository(path) {
  const inside = relative(repository, path)
  return inside.startsWith('..') || isAbsolute(inside)
}

const SWITCHES = [
  /^LLM_BACKEND_URL_/,
  /^LLM_AUTH_URL_/,
  /^LLM_EGRESS_/,
  /^LLM_UPSTREAM_CA_FILE$/,
  /^NODE_TLS_REJECT_UNAUTHORIZED$/,
  /^NODE_USE_SYSTEM_CA$/,
  /^NODE_EXTRA_CA_CERTS$/,
  /^NODE_USE_ENV_PROXY$/,
  /^SSL_CERT_FILE$/,
  /^SSL_CERT_DIR$/,
]
const CA_FLAG = /(?:^|\s|["'])--use-(?:system|openssl|bundled)-ca(?:=|\s|["']|$)/

/**
 * Why the live mode does not start in this environment, or null. The roles of the stand get an
 * environment of their own and none of these would reach them; a run started with one of them
 * was meant for something else than the real provider on the product's path.
 */
export function liveStartRefusal(env) {
  const set = (name) => typeof env[name] === 'string' && env[name].trim() !== ''
  if (set('CI')) return 'CI is set: the live mode never runs in CI'
  for (const name of Object.keys(env).sort())
    if (set(name) && SWITCHES.some((pattern) => pattern.test(name)))
      return `${name} is set: the live mode takes no address override, proxy or CA switch`
  if (CA_FLAG.test(env.NODE_OPTIONS ?? ''))
    return 'NODE_OPTIONS names a CA flag: the live mode takes no CA switch'
  return null
}

const KEY_NAME = 'ZAI_API_KEY'
const KEY_SHAPE = /^[\x21-\x7e]{16,8192}$/

/**
 * Takes the plan key out of the environment: read once, deleted at once, so that no process
 * the stand starts later can inherit it. The holder gives the value in one form only — the line
 * `subscriptions:login` reads on its input — and answers whether given bytes hold it. Nothing
 * that prints the holder prints the value.
 */
export function takePlanKey(env) {
  const raw = env[KEY_NAME]
  delete env[KEY_NAME]
  if (typeof raw !== 'string' || raw.trim() === '')
    throw new LiveRefusal(`${KEY_NAME} is not set in the environment of the stand`)
  const value = raw.trim()
  if (!KEY_SHAPE.test(value))
    throw new LiveRefusal(`${KEY_NAME} is not one line of 16 or more printable characters`)
  const needles = secretNeedles(value)
  const holder = {}
  Object.defineProperties(holder, {
    input: { value: () => `${value}\n` },
    foundIn: { value: (bytes) => holdsAny(bytes, needles) },
    needles: { value: () => needles },
    toString: { value: () => '[plan key]' },
    toJSON: { value: () => '[plan key]' },
    [inspect.custom]: { value: () => '[plan key]' },
  })
  return Object.freeze(holder)
}

/** The value as bytes, and as a log or a header dump would encode it. */
function secretNeedles(value) {
  const forms = new Set([value, encodeURIComponent(value)])
  for (const text of [value, `Bearer ${value}`]) {
    forms.add(Buffer.from(text).toString('hex'))
    // base64 of a longer text holds the value at one of three alignments: the middle of each,
    // without the characters the neighbours change, finds it at any.
    for (let lead = 0; lead < 3; lead++) {
      const encoded = Buffer.from(`${'x'.repeat(lead)}${text}`).toString('base64')
      const start = Math.ceil((lead * 4) / 3)
      const core = encoded.slice(start + (lead ? 1 : 0), encoded.length - 4)
      if (core.length >= 16) forms.add(core)
    }
    forms.add(Buffer.from(text).toString('base64').replace(/=+$/, ''))
  }
  return [...forms].map((form) => Buffer.from(form))
}

const holdsAny = (bytes, needles) => {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes))
  return needles.some((needle) => buffer.includes(needle))
}

const windowsByName = (limitWindows) =>
  Array.isArray(limitWindows)
    ? Object.fromEntries(limitWindows.map((window) => [window?.name, window]))
    : {}
const known = (window) =>
  window !== undefined && typeof window.usedPct === 'number' && Number.isFinite(window.usedPct)

/**
 * Why a run does not start on the windows the role's quota probe stored for the account
 * (`subscription_accounts.limit_windows`), or null.
 */
export function windowStartRefusal(limitWindows) {
  const windows = windowsByName(limitWindows)
  if (!known(windows['5h']) || !known(windows.week))
    return 'the windows of the account are not known: the quota probe stored no snapshot'
  if (windows['5h'].usedPct > WINDOW_START_LIMITS['5h'])
    return `the five-hour window is used above ${WINDOW_START_LIMITS['5h']} %`
  if (windows.week.usedPct > WINDOW_START_LIMITS.week)
    return `the week window is used above ${WINDOW_START_LIMITS.week} %`
  return null
}

/**
 * Percentage points the five-hour window grew by between two snapshots. A window that ended in
 * between, or that nobody had started, counts whole: all it holds now is at most this run's.
 */
export function windowGrowth(before, after) {
  if (!known(before ?? undefined) || !known(after ?? undefined))
    throw new Error('The five-hour window is not known')
  const moment = (window) => (window.resetsAt ? new Date(window.resetsAt).getTime() : null)
  const [from, to] = [moment(before), moment(after)]
  // The provider names the reset of one window with a jitter of milliseconds.
  const same = from !== null && to !== null && Math.abs(from - to) < 60_000
  return same ? after.usedPct - before.usedPct : after.usedPct
}

/**
 * What is wrong with the configuration of the stand's role llm, by profile; empty when nothing.
 *   synthetic — never a real provider: a local mTLS proxy, or every origin the role may reach
 *     itself pointed at a loopback fake; either way the stand's synthetic CA and nothing else;
 *   live — the real provider as production reaches it: the product's own production list
 *     (`productionEgress`, egressConfigFromEnv(…, 'production') — no upstream CA, no address
 *     override, no TLS or CA switch of Node), held on the configuration the stand hands the role
 *     and on the real environment and arguments of the process, the direct path, and the
 *     request guard loaded into the process.
 * The problems name variables, never values.
 */
export function roleProfileProblems({
  profile,
  egress,
  directOrigins = [],
  env = {},
  processEnv = {},
  execArgv = [],
  guarded = false,
  productionEgress,
}) {
  if (profile === 'synthetic') {
    const local = (url) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    const fakes = directOrigins.every((origin) => egress.backendOrigins.has(origin))
    return egress.upstreamCaFile && (egress.proxyUrl ? local(egress.proxyUrl) : fakes)
      ? []
      : [
          'A local mTLS proxy or loopback provider fakes, and an explicit synthetic upstream CA required',
        ]
  }
  if (profile !== 'live') throw new Error('Unknown profile of the role llm')
  const problems = []
  for (const [place, values] of [
    ['configuration', env],
    ['process environment', processEnv],
  ]) {
    try {
      productionEgress(values)
    } catch (error) {
      problems.push(`${place}: ${error.message}`)
    }
    if (values.NODE_EXTRA_CA_CERTS?.trim())
      problems.push(`${place}: NODE_EXTRA_CA_CERTS: forbidden on the live path`)
  }
  if (CA_FLAG.test(execArgv.join(' '))) problems.push('process arguments: a provider CA flag')
  if (egress.proxyUrl !== null)
    problems.push('an egress proxy is configured: the live path is the direct one')
  if (egress.upstreamCaFile !== null) problems.push('LLM_UPSTREAM_CA_FILE: an upstream CA is set')
  if (egress.backendOrigins.size) problems.push('an address override of a provider is set')
  // A live role never runs without the hard cap on its provider connections.
  if (!guarded) problems.push('the request guard of the live run is not loaded (live-guard.mjs)')
  return problems
}

/**
 * The services of compose.yml a live stack starts, by name: PostgreSQL, OpenBao, sandbox-gw and
 * what the stand still needs locally — the synthetic MCP of the gateway stand, or the S3 of the
 * content stand, whose MCP is the real role. Neither the synthetic providers nor the stand's
 * egress proxy: nothing on this machine may answer in the name of the provider.
 */
export function liveServices({ content }) {
  return ['postgres', 'vault', 'sandbox-gw', content ? 's3' : 'synthetic-mcp']
}

/** The `--import` address of live-guard.mjs for a process of the run. */
export function guardImport({ ledger, cap, provider }) {
  assert.ok(typeof ledger === 'string' && isAbsolute(ledger), 'An absolute ledger file is required')
  assert.ok(Number.isInteger(cap) && cap >= 0, 'The cap is a count of provider requests')
  assert.match(provider?.host ?? '', /^[a-z0-9.-]+$/, 'Invalid provider host')
  assert.ok(Number.isInteger(provider.port) && provider.port > 0 && provider.port < 65_536)
  const url = new URL('./live-guard.mjs', import.meta.url)
  url.searchParams.set('ledger', ledger)
  url.searchParams.set('cap', String(cap))
  url.searchParams.set('host', provider.host)
  url.searchParams.set('port', String(provider.port))
  return url.href
}

/**
 * What the guards of a run wrote: provider connections let through (`entries`, with the time of
 * each), those refused over the cap, and the hosts other than the provider somebody tried.
 */
export function readLedger(file) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const ledger = { requests: 0, refused: 0, foreign: [], entries: [] }
  for (const line of text.split('\n')) {
    const [kind, pid, at, , target] = line.split(' ')
    if (kind === 'c') {
      ledger.requests += 1
      ledger.entries.push({ at: Number(at), pid: Number(pid) })
    } else if (kind === 'r') ledger.refused += 1
    else if (kind === 'f') ledger.foreign.push(target)
  }
  return ledger
}

/**
 * The stand's own count over the same ledger. Before a step it asks whether the step can be
 * afforded in its worst case, with `reserve` requests kept for what must still follow (the last
 * quota reading); after a step it asks whether a guard had to refuse anything.
 */
export function createBudget({ cap, ledger, reserve = 0 }) {
  assert.ok(Number.isInteger(cap) && cap > 0 && Number.isInteger(reserve) && reserve >= 0)
  assert.ok(reserve < cap, 'The reserve leaves nothing to spend')
  const state = () => {
    const { requests: used, refused, foreign } = readLedger(ledger)
    return { cap, used, refused, foreign, remaining: Math.max(0, cap - used) }
  }
  const covers = (worst) => worst <= state().remaining - reserve
  return {
    state,
    /** Whether the worst case of a step fits; for a step the run can do without. */
    covers,
    /** Fails before `what` starts when its worst case does not fit. */
    afford(worst, what) {
      if (covers(worst)) return
      const { used } = state()
      throw new Error(
        `The request budget of the run does not cover ${what}: ${used} of ${cap} sent, ${reserve} reserved, ${worst} needed`,
      )
    },
    /** Fails when a guard refused a connection: something tried to pass the cap or the host. */
    assertHeld() {
      const { refused, foreign, used } = state()
      if (foreign.length)
        throw new Error(`A process of the run tried another host than the provider: ${foreign[0]}`)
      if (refused)
        throw new Error(
          `The run reached its cap of ${cap} provider requests: ${used} sent, ${refused} refused`,
        )
    },
  }
}

/**
 * Watches the ledger while a turn runs: `stop` is called once, as soon as a guard has refused a
 * connection — over the cap or to another host. The guard has already kept the request on this
 * machine; this ends the turn at once instead of when the CLI gives up repeating. `end` stops
 * the watch.
 */
export function watchLedger(budget, stop, everyMs = 500) {
  let tripped = false
  const timer = setInterval(() => {
    const { refused, foreign } = budget.state()
    if (!refused && !foreign.length) return
    tripped = true
    clearInterval(timer)
    stop()
  }, everyMs)
  return { tripped: () => tripped, end: () => clearInterval(timer) }
}

/**
 * An outcome of a live run that depends on the model — the result is valid, the file is
 * written, the tool is called — and the attempts it gets. It goes to the report as a share and
 * never fails the run: what fails a run is what the platform owes, checked inside `once` in
 * every attempt, and the stand's own count of requests.
 *   first()   — the first attempt. Every kind of turn runs once, so the budget must cover it:
 *               a run that cannot afford it fails before the turn starts.
 *   retries() — further attempts, up to `attempts` in all, while the outcome is missed and the
 *               budget covers the worst case of one more; a retry it does not cover ends them.
 * `once(attempt)` runs one turn and answers `{ok, …}`; `worst` is the most provider requests
 * one attempt can send (the ceiling of its turn key).
 */
export function createOutcome({ label, attempts, worst, budget, once }) {
  let made = 0
  let last = null
  let ended = null
  const attempt = async () => {
    made += 1
    last = await once(made)
    if (last.ok) ended = 'reached'
    else if (made >= attempts) ended = 'attempts'
  }
  return {
    async first() {
      assert.equal(made, 0, 'The first attempt was already made')
      budget.afford(worst, `${label}, attempt 1`)
      await attempt()
    },
    async retries() {
      assert.ok(made > 0, 'Retries follow the first attempt')
      while (ended === null) {
        if (budget.covers(worst)) await attempt()
        else ended = 'budget'
      }
    },
    /** `ended`: reached, attempts (all of them used) or budget; null while more may follow. */
    share: () => ({ label, reached: last?.ok === true, attempts: made, ended }),
    /** What the last attempt answered. */
    last: () => last,
  }
}

const BLOCK = 4 * 1024 * 1024

/** Whether a file holds a needle, read in blocks that overlap by the longest needle. */
function fileHolds(path, needles) {
  const overlap = Math.max(...needles.map((needle) => needle.length)) - 1
  const buffer = Buffer.alloc(BLOCK + overlap)
  const descriptor = openSync(path, 'r')
  try {
    let kept = 0
    for (;;) {
      const read = readSync(descriptor, buffer, kept, BLOCK, null)
      if (read === 0) return false
      const filled = buffer.subarray(0, kept + read)
      if (needles.some((needle) => filled.includes(needle))) return true
      kept = Math.min(overlap, filled.length)
      filled.copy(buffer, 0, filled.length - kept)
    }
  } finally {
    closeSync(descriptor)
  }
}

async function filesUnder(root) {
  const files = []
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      // Regular files alone: a link leads out of what the stand owns, and a named pipe (the
      // driver hands a turn its secrets through them) would never end.
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  if (!(await lstat(root)).isDirectory()) throw new Error('Not a directory')
  await walk(root)
  return files
}

/**
 * The places that hold the secret of `holder` (takePlanKey). A place is `{name, text}`,
 * `{name, texts}`, `{name, streams}` or `{name, directory}`; text is a string or bytes, a
 * directory is searched file by file, binary files included. `streams` is output kept as it was
 * read, a list of chunks for each pipe of a process: a read ends anywhere, so the chunks of one
 * pipe are searched as one text. The search runs in this process alone: the value goes to no
 * other process, argument or file. A place that cannot be read fails the search — an answer
 * «not found» is given only for what was read whole. The result names places, never the value.
 */
export async function searchPlaces(holder, places) {
  const needles = holder.needles()
  const found = []
  for (const place of places) {
    try {
      if (place.directory !== undefined) {
        for (const file of await filesUnder(place.directory))
          if (fileHolds(file, needles))
            found.push(`${place.name}: ${relative(place.directory, file).split(sep).join('/')}`)
      } else {
        const texts =
          place.streams?.map((chunks) =>
            Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
          ) ??
          place.texts ??
          (place.text === undefined ? null : [place.text])
        if (texts === null) throw new Error('Nothing to search')
        if (texts.some((text) => holdsAny(text, needles))) found.push(place.name)
      }
    } catch (error) {
      throw new Error(`The search could not read ${place.name}: ${error.code ?? 'unreadable'}`)
    }
  }
  return found
}

/**
 * The search a run that failed or was interrupted still makes before its cleanup, over what it
 * holds by then. Unlike searchPlaces it goes on past a place it cannot read — such a run may
 * already be removing its files — and names that place as unread instead of failing.
 */
export async function searchWhatIsLeft(holder, places) {
  const found = []
  const unread = []
  for (const place of places) {
    try {
      found.push(...(await searchPlaces(holder, [place])))
    } catch {
      unread.push(place.name)
    }
  }
  return { found, unread }
}

/**
 * The first line of a failure, for the output of a live run, or null when nothing of it may be
 * printed. The whole text of the failure is tested for the key before anything is cut from it:
 * a cut can leave a part of the value that the test of the whole value no longer finds.
 */
export function failureLine(error, holder) {
  if (!(error instanceof Error)) return null
  if (holder.foundIn(String(error.stack ?? '')) || holder.foundIn(String(error.message ?? '')))
    return null
  const line = String(error.message ?? '')
    .split('\n')[0]
    .slice(0, 400)
  return line === '' ? null : line
}

/**
 * The JSON object a command of the operator answered with, or a failure in fixed words. Nothing
 * the command printed enters the message, not even cut short: the output of a command that was
 * handed the plan key is kept for the search and never quoted.
 */
export function commandAnswer({ code, stdout }, what) {
  if (code !== 0) throw new Error(`${what} failed with exit code ${code}`)
  let answer = null
  try {
    answer = JSON.parse(stdout)
  } catch {
    /* The parser quotes what it read: its message is not passed on. */
  }
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer))
    throw new Error(`${what} did not answer with a JSON object`)
  return answer
}

/**
 * Whether the bytes of a stream hold a needle of each given set, read as they come with the
 * same overlap as a file. The stand reads the files of the sandbox this way (a tar stream out
 * of the container): the secret stays in this process and never enters the sandbox it is
 * searched in.
 */
export function createStreamSearch(needleSets) {
  const sets = needleSets.map((needles) => needles.map((needle) => Buffer.from(needle)))
  const overlap = Math.max(...sets.flat().map((needle) => needle.length)) - 1
  const found = sets.map(() => false)
  let kept = Buffer.alloc(0)
  return {
    push(chunk) {
      const filled = Buffer.concat([kept, chunk])
      for (const [index, needles] of sets.entries())
        found[index] ||= needles.some((needle) => filled.includes(needle))
      kept = filled.subarray(Math.max(0, filled.length - overlap))
    },
    found: () => found.slice(),
  }
}

const MAX_EXCHANGES = 400
const MAX_EXCHANGE_BYTES = 4 * 1024 * 1024

/**
 * One hop in front of the role llm, where sandbox-gw sends: the stand's only look at an
 * exchange it does not script. It passes every byte on as it comes and keeps, for each request,
 * the body the CLI sent, the answer the sandbox received, the status and the times. It keeps no
 * header but the content type — so no turn key — and nothing of the provider's side: what the
 * role sends on, with the plan key, is behind it.
 */
export async function startLlmObserver({ listenHost, port, upstream }) {
  const target = new URL(upstream)
  const exchanges = []
  const sockets = new Set()
  const server = createServer((req, res) => {
    const startedAt = Date.now()
    const record = {
      at: new Date(startedAt).toISOString(),
      method: req.method,
      path: req.url,
      status: null,
      contentType: null,
      requestBody: '',
      responseText: '',
      firstByteMs: null,
      ms: null,
      truncated: false,
    }
    if (exchanges.length < MAX_EXCHANGES) exchanges.push(record)
    const kept = { request: [], response: [], bytes: 0 }
    const keep = (list) => (chunk) => {
      kept.bytes += chunk.length
      if (kept.bytes > MAX_EXCHANGE_BYTES) record.truncated = true
      else list.push(chunk)
    }
    const finish = () => {
      record.ms ??= Date.now() - startedAt
      record.requestBody = Buffer.concat(kept.request).toString()
      record.responseText = Buffer.concat(kept.response).toString()
    }
    const forward = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        // As sandbox-gw sent it, under the name the role listens on.
        headers: { ...req.headers, host: target.host },
        agent: false,
      },
      (answer) => {
        record.status = answer.statusCode
        record.contentType = String(answer.headers['content-type'] ?? '').split(';')[0] || null
        res.writeHead(answer.statusCode, answer.rawHeaders)
        res.flushHeaders()
        answer.on('data', (chunk) => {
          record.firstByteMs ??= Date.now() - startedAt
          keep(kept.response)(chunk)
          res.write(chunk)
        })
        answer.on('end', () => {
          finish()
          res.end()
        })
        answer.on('error', () => {
          finish()
          res.destroy()
        })
      },
    )
    forward.on('error', () => {
      finish()
      if (res.headersSent) res.destroy()
      else {
        record.status = 502
        res.writeHead(502, { 'content-type': 'text/plain' }).end('The role llm did not answer')
      }
    })
    req.on('data', (chunk) => {
      keep(kept.request)(chunk)
      forward.write(chunk)
    })
    req.on('end', () => forward.end())
    // The sandbox went away: the role must see that, as it would without the hop.
    res.on('close', () => {
      if (!res.writableEnded) forward.destroy()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, listenHost, resolve)
  })
  return {
    port: server.address().port,
    /** The exchanges so far, oldest first; the records are the observer's own, do not change them. */
    exchanges: () => exchanges.slice(),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

/**
 * Writes the exchanges an observer kept into `directory`, a file each, in the form
 * sanitize-samples.mjs reads — unless the key is in what would be written: then nothing is
 * written at all. The texts are searched in this process first, as they were observed and as
 * they would lie in the files, so that nothing is kept that was not searched.
 */
export async function keepExchanges(holder, directory, exchanges) {
  const files = exchanges.map((exchange, index) => {
    let body
    try {
      body = JSON.parse(exchange.requestBody)
    } catch {
      body = exchange.requestBody
    }
    const text = `${JSON.stringify(
      {
        at: exchange.at,
        request: {
          method: exchange.method,
          path: exchange.path,
          headers: { 'content-type': 'application/json' },
          body,
        },
        response: {
          status: exchange.status,
          headers: exchange.contentType ? { 'content-type': exchange.contentType } : {},
          elapsedMs: exchange.ms,
          firstByteMs: exchange.firstByteMs,
          sse: exchange.responseText,
        },
      },
      null,
      2,
    )}\n`
    return {
      name: `${String(index + 1).padStart(2, '0')}-llm-post_chat_completions.json`,
      text,
      observed: [exchange.requestBody, exchange.responseText],
    }
  })
  const held = await searchPlaces(holder, [
    { name: 'exchanges', texts: files.flatMap((file) => [file.text, ...file.observed]) },
  ])
  if (held.length) return { written: 0, held: true }
  if (files.length) await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const file of files) await writeFile(join(directory, file.name), file.text, { mode: 0o600 })
  return { written: files.length, held: false }
}

/** What a chat completions request of the CLI says, by names and counts; null when unreadable. */
export function chatRequestSummary(requestBody) {
  let body
  try {
    body = JSON.parse(requestBody)
  } catch {
    return null
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const messages = Array.isArray(body.messages) ? body.messages : []
  return {
    model: typeof body.model === 'string' ? body.model : null,
    messages: messages.length,
    declared: (Array.isArray(body.tools) ? body.tools : []).map(
      (tool) => (tool?.function ?? tool)?.name,
    ),
    toolOutputs: messages.filter((message) => message?.role === 'tool').map((m) => m.content),
    // The CLI asks for a compaction of the context with a request that declares no tools.
    compaction: body.tools === undefined,
  }
}

/** The usage of a chat completions answer in the terms of the platform's accounting. */
function usageOf(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const number = (value) => (Number.isFinite(value) ? value : 0)
  const cacheRead = number(raw.prompt_tokens_details?.cached_tokens)
  return {
    inputUncached: Math.max(0, number(raw.prompt_tokens) - cacheRead),
    cacheRead,
    cacheWrite: 0,
    output: number(raw.completion_tokens),
    reasoning: number(raw.completion_tokens_details?.reasoning_tokens),
  }
}

/**
 * The forms of a stream the stand looks for because no scenario of the synthetic Z.ai makes
 * them: a finish `tool_calls` with no call, a `stop` with no text, a stream with no finish
 * reason or no DONE, and text beside a tool call in one answer. A closed list: a form that is
 * not on it is not reported.
 */
export const STREAM_FORMS = Object.freeze([
  'tool_calls_without_calls',
  'stop_with_empty_answer',
  'no_finish_reason',
  'no_done',
  'text_beside_tool_call',
])

/**
 * What a stream the sandbox received looked like: frames, finish reasons, the names of the tools
 * called, how much text and reasoning, the usage, an error object, and which of STREAM_FORMS
 * it shows.
 */
export function streamSummary(responseText) {
  const summary = {
    frames: 0,
    done: false,
    finishReasons: [],
    toolCalls: [],
    contentChars: 0,
    reasoningChars: 0,
    usage: null,
    error: null,
    forms: [],
  }
  let said = false
  for (const line of String(responseText).split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') {
      summary.done = true
      continue
    }
    let frame
    try {
      frame = JSON.parse(data)
    } catch {
      continue
    }
    summary.frames += 1
    if (frame?.error) summary.error = String(frame.error.code ?? frame.error.type ?? 'error')
    if (frame?.usage) summary.usage = usageOf(frame.usage)
    for (const choice of Array.isArray(frame?.choices) ? frame.choices : []) {
      if (typeof choice.finish_reason === 'string') summary.finishReasons.push(choice.finish_reason)
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string') {
        summary.contentChars += delta.content.length
        said ||= delta.content.trim() !== ''
      }
      if (typeof delta.reasoning_content === 'string')
        summary.reasoningChars += delta.reasoning_content.length
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : [])
        if (typeof call?.function?.name === 'string') summary.toolCalls.push(call.function.name)
    }
  }
  const finish = summary.finishReasons.at(-1)
  if (summary.error === null) {
    if (finish === 'tool_calls' && summary.toolCalls.length === 0)
      summary.forms.push('tool_calls_without_calls')
    if (finish === 'stop' && summary.contentChars === 0 && summary.toolCalls.length === 0)
      summary.forms.push('stop_with_empty_answer')
    if (finish === undefined) summary.forms.push('no_finish_reason')
    if (!summary.done) summary.forms.push('no_done')
    if (said && summary.toolCalls.length > 0) summary.forms.push('text_beside_tool_call')
  }
  return summary
}

/**
 * Why the last message of a turn is or is not a result, in words for the report: `valid`, or
 * what kept the drivers' strict reading from taking it — no message, text around the JSON
 * object, or the fields the schema refused. Names of fields only, never the text itself.
 * `schema` is the platform's turnResultSchema; the reading is the one of the drivers
 * (packages/agent-drivers/src/jsonl.ts): the whole message is one JSON object, or one fence.
 */
export function resultVerdict(events, schema) {
  const text = events.findLast((event) => event.type === 'message')?.text
  if (events.some((event) => event.type === 'failed')) return 'the turn failed'
  if (typeof text !== 'string' || text.trim() === '') return 'no final message'
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)
  let raw
  try {
    raw = JSON.parse(fenced?.[1] ?? trimmed)
  } catch {
    const at = trimmed.lastIndexOf('{"')
    if (trimmed.endsWith('}') && at > 0) return 'text before the JSON object'
    return trimmed.startsWith('{') ? 'text after the JSON object' : 'not a JSON object'
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'not a JSON object'
  const parsed = schema.safeParse(raw)
  if (parsed.success) return 'valid'
  const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '(root)')))]
  return `schema: ${fields.sort().join(', ')}`
}

/** The sum of usage records in the terms of the drivers' common `usage` event. */
export function sumUsage(items) {
  const sum = { inputUncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
  for (const item of items) for (const name of Object.keys(sum)) sum[name] += item[name] ?? 0
  return sum
}

/**
 * What the log of the role llm says of the provider's refusals: the adapter's codes for Z.ai
 * and the kinds of signal, each once, in the order they first appear. The role writes them into
 * its `llm_call` line and only for a refusal (apps/orchestrator/src/llm-gateway/server.ts).
 */
export function providerSignals(roleLog) {
  const each = (pattern) => [...new Set([...roleLog.matchAll(pattern)].map((match) => match[1]))]
  return {
    codes: each(/"code":"(zai_[a-z0-9_]+)"/g),
    signals: each(/"signal":"([a-z_]+)"/g),
  }
}
