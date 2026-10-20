/* global URL */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { createOpencodeDriver } from '@repo/agent-drivers'
import { turnResultSchema } from '@repo/domain'

import { LIVE_LIMITS } from '../../../infra/dev/llm-verify/live.mjs'
import {
  judgeResult,
  REHEARSED_FORMS,
  readingShares,
  rehearsalScenario,
  RESULTS_ACCEPTED_FROM,
  resultReadings,
  resultShares,
  resultTurns,
} from './verify-llm-live-results.mjs'

const source = (name) => readFile(new URL(`./${name}`, import.meta.url), 'utf8')
const driver = createOpencodeDriver({ image: `raditi@sha256:${'a'.repeat(64)}` })
const turns = resultTurns('live-result-test')
/** The output of a turn of the pinned CLI that ended with an answer step. */
const answered = (text) => [
  { type: 'started', nativeSessionId: 'ses_test' },
  { type: 'message', text },
  { type: 'completed' },
]
/** What a turn of the plan would be judged as when the model answered `result` and exited 0. */
const judged = (turn, result, file) =>
  judgeResult({ turn, events: answered(JSON.stringify(result)), code: 0, driver, file })

test('ten turns: at least three change nothing, three change a file and two end with a question', () => {
  assert.equal(turns.length, 10)
  const of = (kind) => turns.filter((turn) => turn.kind === kind)
  assert.deepEqual([...new Set(turns.map((turn) => turn.kind))].sort(), [
    'file',
    'no change',
    'question',
  ])
  // The misses of the first live runs were answers without files_changed: turns with no file
  // to name are the larger part, with and without a tool call before the answer.
  assert.ok(of('no change').length >= 3)
  assert.ok(of('no change').some((turn) => turn.ceiling > 1))
  assert.ok(of('file').length >= 3)
  assert.ok(of('question').length >= 2)
  assert.equal(new Set(turns.map((turn) => turn.label)).size, 10)
  assert.equal(new Set(turns.map((turn) => turn.prompt)).size, 10)
  // The three reasoning levels of the product, as in the measurement of G6.
  const classes = (name) => turns.filter((turn) => turn.modelClass === name).length
  assert.deepEqual([classes('standard'), classes('light'), classes('heavy')], [4, 3, 3])
})

test('the worst case of the ten turns fits the cap of the run', () => {
  // The import of the key, the first probe of the role, every turn at the ceiling of its key
  // and the last reading of the quota.
  const worst = 1 + 1 + turns.reduce((sum, turn) => sum + turn.ceiling, 0) + 1
  assert.ok(worst <= LIVE_LIMITS.results.requests, `${worst} requests in the worst case`)
  assert.equal(LIVE_LIMITS.results.requests, 20)
  // A turn that calls no tool is one request, and its key allows no second one.
  for (const turn of turns)
    assert.equal(turn.ceiling === 1, /Do not call any tool/.test(turn.prompt), turn.label)
  // The role is restarted only to raise the ceiling: twice in a run.
  const ceilings = turns.map((turn) => turn.ceiling)
  assert.deepEqual(ceilings, ceilings.toSorted())
  assert.equal(new Set(ceilings).size, 3)
})

test('only invented prompts go to the model, and half of them leave the result to the contract', () => {
  for (const turn of turns) {
    assert.match(turn.prompt, /^Synthetic check\. /, turn.label)
    // No address, no contact, no name of a real site.
    assert.doesNotMatch(turn.prompt, /https?:|@|www\./, turn.label)
    assert.equal(turn.reminded, /final result/.test(turn.prompt), turn.label)
  }
  // Every prompt of the first live runs asked for «the final result» in so many words; a
  // request of a client never does. Both halves hold every kind of turn.
  for (const reminded of [true, false]) {
    const half = turns.filter((turn) => turn.reminded === reminded)
    assert.equal(half.length, 5)
    assert.deepEqual([...new Set(half.map((turn) => turn.kind))].sort(), [
      'file',
      'no change',
      'question',
    ])
  }
  const other = resultTurns('another-marker')
  assert.notEqual(other.at(-1).prompt, turns.at(-1).prompt)
  // The files a turn works on carry the marker of the run, and nothing else changes with it.
  assert.deepEqual(
    other.map((turn) => turn.prompt.replaceAll('another-marker', 'live-result-test')),
    turns.map((turn) => turn.prompt),
  )
})

test('the scripted model of a rehearsal answers every turn, some in the forms the real one gave', () => {
  const scripted = turns.map((turn) => rehearsalScenario(turn))
  for (const [index, scenario] of scripted.entries()) {
    const turn = turns[index]
    assert.ok(['text', 'tools'].includes(scenario.scenario), turn.label)
    // A turn of the scripted model sends as many requests as its key allows at most.
    const requests = scenario.scenario === 'tools' ? scenario.rounds.length + 1 : 1
    assert.ok(turn.miss === 'tool call' || requests <= turn.ceiling, turn.label)
    assert.ok(turnResultSchema.safeParse(turn.answer).success, turn.label)
    assert.deepEqual(
      turn.answer.files_changed,
      turn.kind === 'file' ? [turn.written.path] : [],
      turn.label,
    )
  }
  // The three forms of the live runs of 10.10.2026 and a model that calls a tool where the key
  // of the turn allows one request: each once.
  assert.deepEqual(
    turns.flatMap((turn) => turn.miss ?? []).sort(),
    Object.keys(REHEARSED_FORMS).sort(),
  )
  const texts = Object.fromEntries(
    turns.filter((turn) => turn.miss).map((turn) => [turn.miss, rehearsalScenario(turn).text]),
  )
  assert.match(texts['prose before'], /^[A-Z][^{]+\n\n\{.*\}$/s)
  assert.match(texts['prose after'], /^\{.*\}\n\n[A-Z][^{}]+$/s)
  assert.equal('files_changed' in JSON.parse(texts['no files_changed']), false)
  assert.equal(rehearsalScenario(turns.find((turn) => turn.miss === 'tool call')).scenario, 'tools')
})

test('an answer is judged twice: by the strict reading of the driver and by the reading of the product', () => {
  const verdicts = turns.map((turn) => {
    const scenario = rehearsalScenario(turn)
    // A tool call past the ceiling of the key: the role refuses the next request and the CLI
    // reports a failure.
    const events =
      turn.miss === 'tool call'
        ? [
            { type: 'started', nativeSessionId: 'ses_test' },
            { type: 'tool_call', tool: 'bash', ok: true },
            { type: 'failed', reason: 'synthetic refusal' },
          ]
        : answered(scenario.text)
    return judgeResult({
      turn,
      events,
      code: turn.miss === 'tool call' ? 1 : 0,
      driver,
      file: turn.written ? `${turn.written.lines.join('\n')}\n` : null,
    })
  })
  for (const [index, verdict] of verdicts.entries()) {
    const turn = turns[index]
    const expected = turn.miss
      ? REHEARSED_FORMS[turn.miss]
      : { verdict: 'valid', strict: true, taken: true }
    assert.deepEqual(
      { verdict: verdict.verdict, strict: verdict.strict, taken: verdict.taken },
      expected,
      turn.label,
    )
    assert.deepEqual(verdict.unmet, [], turn.label)
  }
  // What the documents of G6 did not know: the supervisor takes an object the model wrapped in
  // a sentence (apps/core/src/turns/turn-result.ts), the driver alone does not.
  assert.deepEqual(REHEARSED_FORMS, {
    'no files_changed': { verdict: 'schema: files_changed', strict: false, taken: false },
    'prose after': { verdict: 'text after the JSON object', strict: false, taken: true },
    'prose before': { verdict: 'text before the JSON object', strict: false, taken: true },
    'tool call': { verdict: 'the turn failed', strict: false, taken: false },
  })
  const shares = resultShares(verdicts)
  assert.deepEqual(
    { turns: shares.turns, strict: shares.strict, taken: shares.taken, accepted: shares.accepted },
    { turns: 10, strict: 6, taken: 8, accepted: false },
  )
  assert.deepEqual(shares.reminded, { turns: 5, strict: 4, taken: 4 })
  assert.deepEqual(shares.plain, { turns: 5, strict: 2, taken: 4 })
  assert.deepEqual(shares.kinds, {
    'no change': { turns: 4, strict: 2, taken: 3, met: 3 },
    question: { turns: 3, strict: 2, taken: 2, met: 2 },
    file: { turns: 3, strict: 2, taken: 3, met: 3 },
  })
  assert.deepEqual(
    shares.missed.map((item) => `${item.label}: ${item.verdict}${item.taken ? ' (taken)' : ''}`),
    [
      'result turn 2: text before the JSON object (taken)',
      'result turn 3: schema: files_changed',
      'result turn 5: the turn failed',
      'result turn 9: text after the JSON object (taken)',
    ],
  )
  assert.equal(RESULTS_ACCEPTED_FROM, 9)
  const nine = verdicts.map((verdict, index) =>
    index === 2 ? verdict : { ...verdict, verdict: 'valid', strict: true, taken: true },
  )
  assert.equal(resultShares(nine).accepted, true)
  assert.equal(resultShares(nine.slice(1)).accepted, false, 'nine turns are not the ten')
})

test('every live flow reads a result twice the same way: the product decides, the strict reading is told', () => {
  const valid = turns[0].answer
  const json = JSON.stringify(valid)
  const { files_changed: _omitted, ...short } = valid
  const read = (text, code = 0, events = answered(text)) => resultReadings({ driver, events, code })
  const cases = [
    [read(json), { verdict: 'valid', strict: true, taken: true }],
    // The two forms the supervisor takes and the driver alone does not.
    [
      read(`The check is complete.\n\n${json}`),
      { verdict: 'text before the JSON object', strict: false, taken: true },
    ],
    [
      read(`${json}\n\nLet me know if anything else is needed.`),
      { verdict: 'text after the JSON object', strict: false, taken: true },
    ],
    // What neither takes: an object without a key of the contract, a turn that failed, a CLI
    // that exited with an error after a valid answer, an output with no answer step at its end.
    [
      read(JSON.stringify(short)),
      { verdict: 'schema: files_changed', strict: false, taken: false },
    ],
    [
      read(json, 1, [...answered(json), { type: 'failed', reason: 'synthetic refusal' }]),
      { verdict: 'the turn failed', strict: false, taken: false },
    ],
    [read(json, 1), { verdict: 'exit code 1', strict: false, taken: false }],
    [
      read(json, 0, answered(json).slice(0, -1)),
      { verdict: 'no answer step at the end of the output', strict: false, taken: false },
    ],
  ]
  for (const [reading, expected] of cases) {
    const { verdict, strict, taken, result } = reading
    assert.deepEqual({ verdict, strict, taken }, expected)
    // The result a flow goes on with is the product's: the object itself, or nothing.
    assert.deepEqual(result, expected.taken ? valid : null, expected.verdict)
  }
  // The shares of a flow: how many turns the product took, and the strict count beside it.
  assert.deepEqual(readingShares(cases.map(([reading]) => reading)), {
    turns: 7,
    taken: 3,
    strict: 1,
  })
  assert.deepEqual(readingShares([]), { turns: 0, taken: 0, strict: 0 })
  // The narrow measurement judges by the same reading.
  const [judgement] = [
    judgeResult({ turn: turns[0], events: answered(`Done.\n\n${json}`), code: 0, driver }),
  ]
  assert.deepEqual(
    [judgement.verdict, judgement.strict, judgement.taken],
    ['text before the JSON object', false, true],
  )
})

test('no live flow asks the driver alone whether a turn ended with a valid result', async () => {
  const gateway = await source('verify-llm-live.mjs')
  const content = await source('verify-agent-content-live.mjs')
  const turnsOfContent = await source('verify-agent-content-turns.mjs')
  // The outcome «the result is valid» of the acceptances and of the measurement is the
  // product's reading (the supervisor's readTurnResult); the strict one goes to the report.
  for (const [name, text] of [
    ['verify-llm-live.mjs', gateway],
    ['verify-agent-content-live.mjs', content],
  ]) {
    assert.doesNotMatch(text, /turnResultSchema\.safeParse\(outcome\.result\)/, name)
    assert.doesNotMatch(text, /driver\.extractResult\(/, name)
    assert.match(text, /by the strict reading of the driver/, name)
    assert.match(text, /readingShares\(/, name)
  }
  assert.match(gateway, /resultReadings\(\{ driver, events, code: result\.code \}\)/)
  assert.match(turnsOfContent, /resultReadings\(\{ driver, events, code: result\.code \}\)/)
  // The shares still decide nothing: no flow asserts on a count of valid results outside a
  // rehearsal, whose scripted model is certain.
  assert.doesNotMatch(content, /assert\.ok\((edits|results|strictResults) > 0/)
})

test('the reaction of the CLI to a refused body is measured in a rehearsal alone, under the budget of the run', async () => {
  const live = await source('verify-llm-live.mjs')
  // The stand answers in place of the role there: never on the way to the real provider.
  assert.equal([...live.matchAll(/await bodyRefusals\(\)/g)].length, 1)
  assert.match(live, /if \(rehearsal\) await bodyRefusals\(\)/)
  const flow = live.slice(
    live.indexOf('async function bodyRefusals()'),
    live.indexOf("stage = 'the end of the run'"),
  )
  assert.ok(flow.length > 0, 'The measurement of a refused body is missing')
  // Every turn is covered before it starts, held to the ceiling of its key, and owes the
  // platform what every other turn owes.
  assert.match(flow, /await startLlm\(BODY_TURN_CALLS\)/)
  assert.match(flow, /budget\.afford\(BODY_TURN_CALLS, label\)/)
  assert.match(flow, /await invariants\(turn, outcome, \{ ceiling: BODY_TURN_CALLS \}\)/)
  // The refusals are asked of sandbox-gw and of the role themselves, one byte past the limit
  // both hold; no answer of the stand is left for a later turn.
  assert.match(flow, /llmJsonLimits\.bytes \+ 1/)
  assert.match(flow, /observer\.dropAnswers\(\)/)
  // A stable check of what was measured: a CLI that reacts otherwise fails the rehearsal.
  assert.match(flow, /assert\.deepEqual\(\s*measured,/)
})

test('a result is checked against what its kind of turn asked for', () => {
  const [plain] = turns
  const question = turns.find((turn) => turn.kind === 'question')
  const approval = turns.findLast((turn) => turn.kind === 'question')
  const file = turns.find((turn) => turn.kind === 'file')
  assert.deepEqual(judged(plain, plain.answer).unmet, [])
  assert.deepEqual(judged(plain, { ...plain.answer, files_changed: ['x.txt'] }).unmet, [
    'files_changed is not empty',
  ])
  assert.deepEqual(judged(plain, { ...plain.answer, questions: ['Что дальше?'] }).unmet, [
    'questions is not empty',
  ])
  assert.deepEqual(judged(plain, { ...plain.answer, summary: 'No number' }).unmet, [
    'the summary lacks what was asked for',
  ])
  assert.deepEqual(judged(question, { ...question.answer, questions: [] }).unmet, [
    'no question to the client',
  ])
  assert.deepEqual(judged(approval, approval.answer).unmet, [])
  assert.deepEqual(judged(approval, { ...approval.answer, needs_approval: false }).unmet, [
    'needs_approval is not true',
  ])
  const text = `${file.written.lines.join('\n')}\n`
  assert.deepEqual(judged(file, file.answer, text).unmet, [])
  // The model may name the file by its full path.
  assert.deepEqual(
    judged(file, { ...file.answer, files_changed: [`/workspace/repo/${file.written.path}`] }, text)
      .unmet,
    [],
  )
  assert.deepEqual(judged(file, { ...file.answer, files_changed: [] }, text).unmet, [
    'files_changed does not name the file',
  ])
  assert.deepEqual(judged(file, file.answer, '').unmet, ['the file was not written'])
  // Whether the file was written does not wait for a result.
  assert.deepEqual(
    judgeResult({ turn: file, events: answered('Done.'), code: 0, driver, file: '' }),
    {
      label: file.label,
      kind: 'file',
      modelClass: file.modelClass,
      reminded: true,
      verdict: 'not a JSON object',
      strict: false,
      taken: false,
      unmet: ['the file was not written'],
    },
  )
  // An exit code other than 0 is no result, whatever the last message says.
  const failed = judgeResult({
    turn: plain,
    events: answered(JSON.stringify(plain.answer)),
    code: 1,
    driver,
    file: null,
  })
  assert.deepEqual([failed.verdict, failed.strict, failed.taken], ['exit code 1', false, false])
  // The driver takes a result only from an answer step at the end of the output.
  const cut = judgeResult({
    turn: plain,
    events: answered(JSON.stringify(plain.answer)).slice(0, 2),
    code: 0,
    driver,
    file: null,
  })
  assert.deepEqual(
    [cut.verdict, cut.strict, cut.taken],
    ['no answer step at the end of the output', false, false],
  )
})

test('the flow of the stand holds what the platform owes in every turn and reports the model as shares', async () => {
  const live = await source('verify-llm-live.mjs')
  const flow = live.slice(
    live.indexOf('async function results()'),
    live.indexOf('async function measure()'),
  )
  assert.ok(flow.length > 0, 'The flow of results is missing')
  // Every turn is covered by the budget before it starts and held to the ceiling of its key.
  assert.match(flow, /budget\.afford\(item\.ceiling, /)
  assert.match(flow, /await invariants\(turn, outcome, \{ ceiling: item\.ceiling \}\)/)
  // The share is a line of the report: nothing of the model fails the run.
  assert.match(flow, /resultShares\(/)
  assert.doesNotMatch(flow, /assert\.[a-zA-Z]+\([^)]*shares\.accepted/)
  // The rehearsal ends at the cap of the run, as the acceptance does.
  assert.match(flow, /await capOfTheRun\(\)/)
})

test('a run of the ten turns is held to its own cap, not to the cap of another kind of run', async () => {
  const live = await source('verify-llm-live.mjs')
  const flow = live.slice(
    live.indexOf('async function results()'),
    live.indexOf('async function measure()'),
  )
  // The ten turns were counted for 20 provider requests. The limits of a run come from its
  // kind, and nothing else ties --results to the kind: before the first turn the flow checks
  // both, so a run opened under the limits of the measurement (40) stops instead of going on.
  const kind = flow.indexOf("assert.equal(live.kind, 'results')")
  const cap = flow.indexOf('assert.equal(live.limits.requests, LIVE_LIMITS.results.requests)')
  const firstTurn = flow.indexOf('for (const item of resultPlan)')
  assert.ok(kind > 0 && cap > 0, 'The flow of results does not check its kind and its cap')
  assert.ok(firstTurn > Math.max(kind, cap), 'The check comes after the first turn')
  assert.equal(LIVE_LIMITS.results.requests, 20)
  // The rehearsal reaches the cap on purpose: the cap it reached is the cap of its kind.
  const reached = live.slice(
    live.indexOf('async function capOfTheRun()'),
    live.indexOf('async function results()'),
  )
  assert.ok(reached.length > 0, 'The rehearsal of the cap is missing')
  assert.match(reached, /assert\.equal\(state\.used, state\.cap\)/)
  assert.match(reached, /assert\.equal\(state\.cap, live\.limits\.requests\)/)
})
