// Point 3 of G1 — the hostile database: between two turns the session row gets other permissions, another
// agent, another model and another directory, and rows appear in `permission`, `credential` and the account
// tables. Does the next request still carry the profile's model, the platform's agent prompt, no forbidden
// tool and the turn key? And do the two counter-measures hold: export + import, or a reset by the wrapper?
import {
  AGENTS_MARKER,
  AGENT_MARKER,
  HARD_ENV,
  HOME,
  MODEL,
  config,
  newTokens,
  pool,
  resultStep,
  save,
  sha256,
  summariseRecords,
  toolStep,
} from './lib.mjs'

// A key-shaped value, put together here so that no key-like literal sits in the repository.
const PLANTED = `sk-rdt-${'planted0'.repeat(6)}`
const CLI_SESSION_PERMISSION = [
  { permission: 'question', pattern: '*', action: 'deny' },
  { permission: 'plan_enter', pattern: '*', action: 'deny' },
  { permission: 'plan_exit', pattern: '*', action: 'deny' },
]
const allow = (permission) => ({ permission, pattern: '*', action: 'allow' })
const ROW_ALLOW = [
  allow('webfetch'),
  allow('websearch'),
  allow('task'),
  allow('skill'),
  allow('external_directory'),
  allow('question'),
]
const ROW_ASK = [...ROW_ALLOW, { permission: 'bash', pattern: '*', action: 'ask' }]
const SAVED = ['webfetch', 'task', 'external_directory', 'bash', 'read', 'websearch'].map(
  (action) => ({ action, resource: '*' }),
)
const CREDENTIALS = ['raditi', 'zai-coding-plan', 'opencode', 'openai'].map((integration) => ({
  integration,
  key: PLANTED,
}))
const ACCOUNTS = { url: 'http://account-control.test', token: PLANTED }
const NORMAL = {
  permission: CLI_SESSION_PERMISSION,
  agent: 'raditi',
  model: { id: MODEL, providerID: 'raditi', variant: 'default' },
  directory: '/workspace/repo',
}

/** name → what is done to the restored database before the second turn. */
const VARIANTS = {
  clean: {},
  'row-permission-allow': { row: { permission: ROW_ALLOW } },
  'row-permission-ask': { row: { permission: ROW_ASK } },
  'row-agent': { row: { agent: 'build' } },
  'row-model-unknown': {
    row: { model: { id: 'glm-planted', providerID: 'raditi', variant: 'max' } },
  },
  'row-model-other-provider': {
    row: { model: { id: 'glm-4.5', providerID: 'zai-coding-plan', variant: 'max' } },
  },
  'row-directory': { row: { directory: '/' }, worktree: '/' },
  'saved-permissions': { saved: SAVED },
  credentials: { credentials: CREDENTIALS, accounts: ACCOUNTS },
  // A trigger that puts the planted permissions back after every update of the session row.
  trigger: { row: { permission: ROW_ALLOW }, trigger: ROW_ALLOW },
  everything: {
    row: {
      permission: ROW_ALLOW,
      agent: 'build',
      model: { id: 'glm-planted', providerID: 'raditi', variant: 'max' },
      directory: '/',
    },
    worktree: '/',
    saved: SAVED,
    credentials: CREDENTIALS,
    accounts: ACCOUNTS,
  },
}
const EVERYTHING = VARIANTS.everything
/** A configuration for `opencode export` and `import`: no provider, no MCP, no reference to a secret. */
const IO_CONFIG = {
  autoupdate: false,
  share: 'disabled',
  snapshot: false,
  lsp: false,
  formatter: false,
  plugin: [],
  enabled_providers: [],
}
/** The trusted rewrite of an export: of `info` only what names and dates the session, the rest set anew. */
function filterScript() {
  const set = JSON.stringify({
    permission: NORMAL.permission,
    agent: NORMAL.agent,
    model: NORMAL.model,
    directory: NORMAL.directory,
    path: '',
  })
  return `const fs=require("fs");const j=JSON.parse(fs.readFileSync("/tmp/export.json","utf8"));const keep=["id","slug","projectID","title","version","summary","cost","tokens","time"];j.info=Object.assign(Object.fromEntries(keep.filter((k)=>k in j.info).map((k)=>[k,j.info[k]])),${set});fs.writeFileSync("/tmp/export.json",JSON.stringify(j))`
}
const stage = (run, tokens) => ({
  configText: JSON.stringify(config(run), null, 2),
  agentsMd: `${AGENTS_MARKER}\nWork only inside /workspace/repo.\n`,
  secrets: tokens,
})
const secondSteps = (run) => [
  toolStep([{ name: 'read', arguments: { filePath: '/etc/hostname' } }]),
  toolStep([
    {
      name: 'webfetch',
      arguments: { url: `http://sandbox-gw:8080/s/${run}/webfetch-probe`, format: 'text' },
    },
  ]),
  toolStep([
    { name: 'bash', arguments: { command: 'echo bash-ran; pwd', description: 'stand step' } },
  ]),
  resultStep(),
]

async function second(stand, name, tar, sessionId, prepare) {
  const run = `p3-${name}`
  const tokens = newTokens()
  await stand.scenario(run, {
    llmKeySha256: sha256(tokens.llm),
    mcpTokenSha256: sha256(tokens.mcp),
    otherSha256: { planted: sha256(PLANTED) },
    steps: secondSteps(run),
  })
  const mark = (await stand.sink()).length
  const cli = await stand.cli(run)
  await cli.stage(stage(run, tokens))
  await cli.restoreSession(tar)
  const prepared = await prepare(cli, tokens)
  // The tampered directory makes the CLI hang after its last step: a short limit is enough to show it.
  const turn = await cli.turn({
    label: 'second',
    prompt: 'Client request: do the stand steps',
    args: ['--session', sessionId],
    needles: tokens,
    timeoutS: 45,
  })
  const records = await stand.records(run)
  save(stand, run, 'records.json', records)
  const sink = (await stand.sink())
    .slice(mark)
    .filter((item) => item.from === cli.facts.ip || item.from === `::ffff:${cli.facts.ip}`)
  await cli.remove()
  const first = records.records.find((record) => record.kind === 'llm')
  const summary = summariseRecords(records)
  const row = turn.left?.db?.sessions?.find((item) => item.id === sessionId)
  return {
    variant: name,
    prepared,
    exit: turn.exit,
    sameSession: turn.sessionId === sessionId,
    requests: summary.llmRequests,
    credentialKinds: summary.credentialKinds,
    models: summary.models,
    firstRequest: first
      ? {
          model: first.request.summary.model,
          agentPromptIsThePlatforms: first.request.summary.systemHead.startsWith(AGENT_MARKER),
          systemHead: first.request.summary.systemHead.slice(0, 70),
          workingDirectory: /Working directory: (\S+)/.exec(
            first.request.body.messages?.[0]?.content ?? '',
          )?.[1],
          instructionsPresent: JSON.stringify(first.request.body).includes(AGENTS_MARKER),
          forbiddenToolsDeclared: first.request.summary.tools.filter((tool) =>
            ['webfetch', 'websearch', 'task', 'skill', 'question'].includes(tool),
          ),
          tools: first.request.summary.tools.length,
          history: first.request.summary.messages.length,
        }
      : null,
    stepReasons: turn.steps.map((step) => step.reason),
    tools: turn.tools.map(
      (tool) => `${tool.tool} ${tool.status}: ${tool.output.replace(/\s+/g, ' ').slice(0, 110)}`,
    ),
    finalText: turn.texts.at(-1)?.slice(0, 50) ?? null,
    errors: turn.errors.map((error) => ({
      name: error?.name,
      message: String(error?.data?.message ?? '').slice(0, 200),
    })),
    stderr: turn.stderrHead.slice(0, 300),
    webfetchReachedTheStand: summary.other,
    sink: sink.map((item) => `${item.kind} ${item.name ?? item.sni ?? item.host}`),
    sessionRowAfter: row
      ? {
          agent: row.agent,
          model: row.model,
          permission: row.permission?.slice(0, 160),
          directory: row.directory,
        }
      : null,
    tablesAfter: Object.fromEntries(
      ['permission', 'credential', 'account', 'control_account', 'session_share'].map((table) => [
        table,
        turn.left?.db?.tables?.[table],
      ]),
    ),
    hits: [...turn.outputHits, ...(turn.left?.hits ?? [])],
  }
}

export async function p3(stand) {
  // The first turn, untouched: its two session files are the starting point of every variant.
  const tokens = newTokens()
  await stand.scenario('p3-first', {
    llmKeySha256: sha256(tokens.llm),
    mcpTokenSha256: sha256(tokens.mcp),
    steps: [
      toolStep([
        { name: 'bash', arguments: { command: 'echo first-turn', description: 'stand step' } },
      ]),
      resultStep(),
    ],
  })
  const cli = await stand.cli('p3-first')
  await cli.stage(stage('p3-first', tokens))
  const first = await cli.turn({
    label: 'first',
    prompt: 'Client request: first turn',
    needles: tokens,
  })
  const tar = await cli.saveSession()
  await cli.remove()
  const sessionId = first.sessionId
  const tamper = (change) => (target) =>
    target.node('tamper-db.mjs', { session: sessionId, ...change })

  const tasks = Object.entries(VARIANTS).map(
    ([name, change]) =>
      () =>
        second(
          stand,
          name,
          tar,
          sessionId,
          Object.keys(change).length ? tamper(change) : async () => 'nothing',
        ),
  )
  // Counter-measure A: the wrapper resets the row and empties the tables before the CLI starts.
  tasks.push(() =>
    second(stand, 'everything-then-reset', tar, sessionId, async (target) => {
      await tamper(EVERYTHING)(target)
      return target.node('tamper-db.mjs', { session: sessionId, normalise: NORMAL })
    }),
  )
  tasks.push(() =>
    second(stand, 'trigger-then-naive-reset', tar, sessionId, async (target) => {
      await tamper(VARIANTS.trigger)(target)
      return target.node('tamper-db.mjs', {
        session: sessionId,
        normalise: { ...NORMAL, naive: true },
      })
    }),
  )
  tasks.push(() =>
    second(stand, 'trigger-then-reset', tar, sessionId, async (target) => {
      await tamper(VARIANTS.trigger)(target)
      return target.node('tamper-db.mjs', { session: sessionId, normalise: NORMAL })
    }),
  )
  // The plan's fallback: `opencode export` in the tampered home, `opencode import` into an empty one. With
  // `filter` the exported file passes a trusted rewrite of `info` in between (counter-measure B).
  const exportImport = (change, filter) => async (target, turnTokens) => {
    await tamper(change)(target)
    const exported = await target.turn({
      label: 'export',
      command: ['sh', '-c', `opencode export ${sessionId} > /tmp/export.json`],
      inspect: false,
      timeoutS: 60,
    })
    const describe =
      'const j=JSON.parse(require("fs").readFileSync("/tmp/export.json","utf8")); console.log(JSON.stringify({bytes:require("fs").statSync("/tmp/export.json").size,infoKeys:Object.keys(j.info),agent:j.info.agent,model:j.info.model,permission:j.info.permission,directory:j.info.directory,messages:j.messages.length,partTypes:[...new Set(j.messages.flatMap((m)=>m.parts.map((p)=>p.type)))]}))'
    const before = JSON.parse((await target.exec(['node', '-e', describe])).stdout)
    if (filter) {
      await target.exec(['node', '-e', filterScript()])
    }
    // An empty home: only the configuration and the export file survive.
    await target.exec(['sh', '-c', `rm -rf ${HOME}/.local ${HOME}/.cache`])
    await target.stage({ secrets: turnTokens, repo: false })
    const imported = await target.turn({
      label: 'import',
      command: ['opencode', 'import', '/tmp/export.json'],
      inspect: false,
      timeoutS: 60,
    })
    await target.stage({ secrets: turnTokens, repo: false })
    return {
      exportExit: exported.exit,
      exportMs: exported.wallMs,
      exported: before,
      filtered: Boolean(filter),
      importExit: imported.exit,
      importMs: imported.wallMs,
      importOut: (imported.nonJsonStdout.join(' ') + imported.stderrHead).slice(0, 120),
    }
  }
  tasks.push(() =>
    second(
      stand,
      'permission-then-export-import',
      tar,
      sessionId,
      exportImport(VARIANTS['row-permission-allow'], false),
    ),
  )
  tasks.push(() =>
    second(stand, 'everything-then-export-import', tar, sessionId, exportImport(EVERYTHING, false)),
  )
  tasks.push(() =>
    second(
      stand,
      'everything-then-export-filter-import',
      tar,
      sessionId,
      exportImport(EVERYTHING, true),
    ),
  )
  tasks.push(() =>
    second(
      stand,
      'trigger-then-export-filter-import',
      tar,
      sessionId,
      exportImport(VARIANTS.trigger, true),
    ),
  )
  // The same counter-measure the way the driver would run it: export and import see neither key. They
  // run without the wrapper, with a configuration directory of their own that names no secret file.
  tasks.push(() =>
    second(
      stand,
      'everything-then-export-filter-import-without-keys',
      tar,
      sessionId,
      async (target, turnTokens) => {
        await tamper(EVERYTHING)(target)
        const io = '/agent-home/io-config'
        const env = Object.entries({ ...HARD_ENV, XDG_CONFIG_HOME: io }).flatMap(
          ([name, value]) => ['-e', `${name}=${value}`],
        )
        const plain = (script) =>
          target.exec(['sh', '-c', script], {
            execFlags: ['-w', '/workspace/repo', ...env],
            timeoutMs: 90_000,
          })
        await target.exec([
          'sh',
          '-c',
          `rm -f /run/raditi/secrets/*; mkdir -p ${io}/opencode && printf '%s' '${JSON.stringify(IO_CONFIG)}' > ${io}/opencode/opencode.json && chmod 555 ${io}/opencode`,
        ])
        const exported = await plain(`opencode export ${sessionId} > /tmp/export.json`)
        await target.exec(['node', '-e', filterScript()])
        await target.exec(['sh', '-c', `rm -rf ${HOME}/.local ${HOME}/.cache`])
        const imported = await plain('opencode import /tmp/export.json')
        await target.stage({ secrets: turnTokens, repo: false })
        return {
          exportExit: exported.code,
          exportMs: exported.ms,
          exportStderr: exported.stderr.slice(0, 80),
          importExit: imported.code,
          importMs: imported.ms,
          importOut: (imported.stdout + imported.stderr).slice(0, 80),
          secretsPresentDuringBoth: false,
        }
      },
    ),
  )
  const variants = await pool(tasks, Number(process.env.SPIKE_PARALLEL ?? 3))
  return {
    first: { exit: first.exit, sessionId: 'ses_…', sessionTarBytes: tar.length },
    planted: 'a key-shaped value the fake knows by hash',
    variants,
  }
}
