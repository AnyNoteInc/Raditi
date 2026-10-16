// Point 7 of G1 — configuration questions:
//   deny       a denied tool call with and without experimental.continue_loop_on_deny; a call of a tool
//              that is not declared at all
//   inbox      external_directory for /workspace/inbox (attachments live outside the work tree)
//   slash      a prompt that begins with `/` (and `-`), through stdin
//   compaction the request the CLI makes when the context fills: its form and its model
//   thinking   whether a model option in the configuration puts `thinking` into the request body
import {
  AGENTS_MARKER,
  USAGE,
  config,
  newTokens,
  resultStep,
  save,
  sha256,
  summariseRecords,
  textStep,
  toolStep,
} from './lib.mjs'

const bash = (command) => ({ name: 'bash', arguments: { command, description: 'stand step' } })
const read = (filePath) => ({ name: 'read', arguments: { filePath } })

export async function run(
  stand,
  name,
  { change, steps, prompt = 'Client request: do the stand steps', files, args },
) {
  const id = `p7-${name}`
  const tokens = newTokens()
  await stand.scenario(id, {
    llmKeySha256: sha256(tokens.llm),
    mcpTokenSha256: sha256(tokens.mcp),
    steps,
    cap: 12,
  })
  const cli = await stand.cli(id)
  await cli.stage({
    configText: JSON.stringify(config(id, change), null, 2),
    agentsMd: `${AGENTS_MARKER}\n`,
    secrets: tokens,
    files,
  })
  const turn = await cli.turn({ prompt, needles: tokens, args, timeoutS: 120 })
  const records = await stand.records(id)
  save(stand, id, 'records.json', records)
  await cli.remove()
  const llm = records.records.filter((record) => record.kind === 'llm')
  return {
    run: name,
    exit: turn.exit,
    wallS: Math.round(turn.wallMs / 100) / 10,
    requests: summariseRecords(records).llmRequests,
    capped: summariseRecords(records).capped,
    events: turn.eventCounts,
    stepReasons: turn.steps.map((step) => step.reason),
    tools: turn.tools.map(
      (tool) =>
        `${tool.tool}(${JSON.stringify(tool.input).slice(0, 70)}) ${tool.status}: ${tool.output.replace(/\s+/g, ' ').slice(0, 150)}`,
    ),
    finalText: turn.texts.at(-1)?.slice(0, 80),
    errors: turn.errors,
    nonJsonStdout: turn.nonJsonStdout.slice(0, 5),
    stderr: turn.stderrHead.slice(0, 400),
    llm: llm.map((record) => ({
      n: record.n,
      model: record.request.summary.model,
      max_tokens: record.request.summary.max_tokens,
      thinking: record.request.summary.thinking,
      reasoning_effort: record.request.summary.reasoning_effort,
      fields: record.request.summary.fields,
      tools: record.request.summary.tools?.length ?? 0,
      systemHead: record.request.summary.systemHead.slice(0, 90),
      systemChars: record.request.summary.systemChars,
      messages: record.request.summary.messages,
      lastUser:
        typeof record.request.summary.lastUser === 'string'
          ? record.request.summary.lastUser.slice(0, 300)
          : record.request.summary.lastUser,
    })),
    hits: [...turn.outputHits, ...turn.left.hits],
  }
}

const denyRule = (flag) => (draft) => {
  draft.permission.bash = { '*': 'allow', 'echo denied-marker*': 'deny' }
  if (flag) draft.experimental = { continue_loop_on_deny: true }
  else delete draft.experimental
}
const askRule = (flag) => (draft) => {
  draft.permission.bash = { '*': 'allow', 'echo denied-marker*': 'ask' }
  if (flag) draft.experimental = { continue_loop_on_deny: true }
  else delete draft.experimental
}
// The command touches nothing outside the work tree, so only the rule under test can stop it.
const deniedThenResult = [toolStep([bash('echo denied-marker')]), resultStep()]
export const inboxSteps = [
  toolStep([read('/workspace/inbox/brief.txt')]),
  toolStep([read('/etc/hostname')]),
  toolStep([bash('cat /workspace/inbox/brief.txt')]),
  toolStep([bash('cat /etc/hostname')]),
  toolStep([{ name: 'glob', arguments: { pattern: '*.txt', path: '/workspace/inbox' } }]),
  toolStep([read('/workspace/inbox/sub/deep.txt')]),
  toolStep([
    {
      name: 'write',
      arguments: { content: 'changed by the agent\n', filePath: '/workspace/inbox/brief.txt' },
    },
  ]),
  resultStep(),
]
export const inboxFiles = {
  '/workspace/inbox/brief.txt': 'INBOX-BRIEF-MARKER-3306\n',
  '/workspace/inbox/sub/deep.txt': 'INBOX-DEEP-MARKER-7710\n',
}
const bigUsage = {
  ...USAGE,
  prompt_tokens: 989_000,
  completion_tokens: 1_000,
  total_tokens: 990_000,
}

export async function p7(stand) {
  const out = { deny: [], inbox: [], slash: [], compaction: [], thinking: [] }
  out.deny.push(
    await run(stand, 'deny-without-flag', { change: denyRule(false), steps: deniedThenResult }),
  )
  out.deny.push(
    await run(stand, 'deny-with-flag', { change: denyRule(true), steps: deniedThenResult }),
  )
  // Control: the same call under an `ask` rule — a headless run rejects the request itself.
  out.deny.push(
    await run(stand, 'ask-without-flag', { change: askRule(false), steps: deniedThenResult }),
  )
  out.deny.push(
    await run(stand, 'ask-with-flag', { change: askRule(true), steps: deniedThenResult }),
  )
  out.deny.push(
    await run(stand, 'undeclared-tool', {
      steps: [
        toolStep([
          { name: 'webfetch', arguments: { url: 'http://sandbox-gw:8080/x', format: 'text' } },
        ]),
        resultStep(),
      ],
    }),
  )
  out.deny.push(
    await run(stand, 'undeclared-tool-without-flag', {
      change: (draft) => void delete draft.experimental,
      steps: [
        toolStep([
          { name: 'webfetch', arguments: { url: 'http://sandbox-gw:8080/x', format: 'text' } },
        ]),
        resultStep(),
      ],
    }),
  )

  out.inbox.push(await run(stand, 'inbox-plain-deny', { steps: inboxSteps, files: inboxFiles }))
  out.inbox.push(
    await run(stand, 'inbox-allowed', {
      change: (draft) =>
        void (draft.permission.external_directory = { '*': 'deny', '/workspace/inbox/*': 'allow' }),
      steps: inboxSteps,
      files: inboxFiles,
    }),
  )
  out.inbox.push(
    await run(stand, 'inbox-allowed-dir-form', {
      change: (draft) =>
        void (draft.permission.external_directory = {
          '*': 'deny',
          '/workspace/inbox': 'allow',
          '/workspace/inbox/**': 'allow',
        }),
      steps: inboxSteps,
      files: inboxFiles,
    }),
  )

  for (const [name, prompt] of [
    ['slash-init', '/init'],
    ['slash-compact', '/compact'],
    ['slash-path', '/workspace/inbox/brief.txt — что в этом файле?'],
    ['slash-unknown', '/нет-такой-команды сделайте что-нибудь'],
    ['dash', '-'],
    ['dash-dash', '--help'],
  ])
    out.slash.push(await run(stand, name, { steps: [resultStep()], prompt }))

  // The model reports a context that is almost full; a second model id shows which one the summary uses.
  const twoModels = (draft) => {
    draft.provider.raditi.models['glm-small'] = {
      ...draft.provider.raditi.models['glm-5.3'],
      name: 'small',
    }
    draft.small_model = 'raditi/glm-small'
  }
  const compactionSteps = [
    toolStep([bash('echo step-one')], { usage: bigUsage }),
    textStep('SUMMARY-MARKER-9917: the stand conversation so far.'),
    resultStep(),
  ]
  out.compaction.push(
    await run(stand, 'compaction-auto', { change: twoModels, steps: compactionSteps }),
  )
  out.compaction.push(
    await run(stand, 'compaction-off', {
      change: (draft) => {
        twoModels(draft)
        draft.compaction = { auto: false }
      },
      steps: [toolStep([bash('echo step-one')], { usage: bigUsage }), resultStep()],
    }),
  )

  out.thinking.push(await run(stand, 'thinking-default', { steps: [resultStep()] }))
  out.thinking.push(
    await run(stand, 'thinking-model-option', {
      change: (draft) =>
        void (draft.provider.raditi.models['glm-5.3'].options = {
          thinking: { type: 'enabled', clear_thinking: false },
        }),
      steps: [resultStep()],
    }),
  )
  return out
}
