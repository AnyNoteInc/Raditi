// The narrow measurement of verify:llm-gateway (--live --results, --rehearsal --results): ten
// turns that have to end with a result, and what the answer of each is worth. An answer is
// judged twice: by the strict reading of the driver, which the acceptance of the owner's
// question П30 counts, and by the reading of the product, which is the supervisor's — it also
// takes an object the model wrapped in a sentence (src/turns/turn-result.ts). The plan of the
// turns and the judgement are here, without the stand; the flow is `results()` in
// verify-llm-live.mjs. Report: docs/plan/46-turn-result-glm.md.
import { SANDBOX_WORKDIR, turnResultSchema } from '@repo/domain'

import { resultVerdict } from '../../../infra/dev/llm-verify/live.mjs'
import { readTurnResult } from '../src/turns/turn-result.ts'

const TURNS = 10
/** Valid results of the ten turns the increment is accepted from (spec §20, П30). */
export const RESULTS_ACCEPTED_FROM = 9

/**
 * Calls the key of a turn may start — the role's own ceiling, LLM_MAX_CALLS_PER_KEY: an answer
 * alone; one tool call and the answer; a write, a look at what was written and the answer. The
 * cap of the run is counted on these: a turn never costs more than its ceiling.
 */
const CEILING = Object.freeze({ answer: 1, look: 2, write: 3 })

const bash = (command) => ({ name: 'bash', arguments: { command, description: 'Synthetic step' } })
const answerOf = (summary, overrides = {}) => ({
  summary,
  change_type: 'none',
  client_message: 'Синтетическая проверка завершена.',
  files_changed: [],
  questions: [],
  needs_approval: false,
  risk: 'low',
  ...overrides,
})

// What a kind of turn asked of the result, each as the words of the report when it is not met.
const noFile = (result) => (result.files_changed.length ? ['files_changed is not empty'] : [])
const noQuestion = (result) => (result.questions.length ? ['questions is not empty'] : [])
const asks = (result) => (result.questions.length ? [] : ['no question to the client'])
const approval = (result) => (result.needs_approval ? [] : ['needs_approval is not true'])
const says = (text) => (result) =>
  result.summary.includes(text) ? [] : ['the summary lacks what was asked for']
const names = (path) => (result) =>
  result.files_changed.some((file) => file === path || file.endsWith(`/${path}`))
    ? []
    : ['files_changed does not name the file']

/**
 * The ten turns, in the order they run: the answers alone first, then the turn with one tool
 * call, then the turns that write a file — the ceiling of the key only grows, so the role is
 * restarted twice. Seven change no file, three of those end with a question, three change a
 * file. Half of the prompts ask for «the final result» in so many words, as every prompt of the
 * first live runs did; the other half leaves the result to the contract in the instructions,
 * as a request of a client does. Only invented text goes to the model. `marker` names the
 * files of this run.
 *
 * Of a turn: `ceiling` — calls of its key; `before` — files the stand writes first; `written` —
 * the file the turn must leave and its lines; `expects` — what its kind asked of the result;
 * for a rehearsal: `rounds` — the tool calls of the scripted model, `answer` — its valid
 * result, `miss` — the form it answers in instead (REHEARSED_FORMS).
 */
export function resultTurns(marker) {
  const notes = 'live-notes.txt'
  const note = `note-${marker}`
  const line = (index) => `${marker}-${index}`
  const file = (index) => `live-result-${index}.txt`
  const plan = [
    {
      kind: 'no change',
      modelClass: 'standard',
      ceiling: CEILING.answer,
      prompt:
        'Synthetic check. Do not call any tool. Reply with the final result only; its summary must contain the sum of 17 and 34 as a number.',
      answer: answerOf('The sum is 51'),
      expects: [noFile, noQuestion, says('51')],
    },
    {
      kind: 'no change',
      modelClass: 'light',
      ceiling: CEILING.answer,
      prompt:
        'Synthetic check. Do not call any tool. The client wrote: «Спасибо, пока ничего менять не нужно». Nothing has to be done.',
      answer: answerOf('Nothing to change'),
      miss: 'prose before',
      expects: [noFile, noQuestion],
    },
    {
      kind: 'no change',
      modelClass: 'heavy',
      ceiling: CEILING.answer,
      prompt:
        'Synthetic check. Do not call any tool. The client asks: «Что такое фавикон?» Nothing on the site changes: answer the client in one or two sentences.',
      answer: answerOf('Answered a question'),
      miss: 'no files_changed',
      expects: [noFile, noQuestion],
    },
    {
      kind: 'question',
      modelClass: 'standard',
      ceiling: CEILING.answer,
      prompt:
        'Synthetic check. Do not call any tool and change nothing. The client wrote: «Поменяйте цвет кнопки на главной». The colour is not named and you must not guess it: ask the client.',
      answer: answerOf('A question about the colour', {
        questions: ['Какой цвет кнопки вы хотите?'],
      }),
      expects: [asks, noFile],
    },
    {
      kind: 'question',
      modelClass: 'light',
      ceiling: CEILING.answer,
      prompt:
        'Synthetic check. Do not call any tool and change nothing. The client wrote: «Добавьте на сайт новый раздел». Neither its name nor its content is given. Reply with the final result only; its questions list holds two questions to the client.',
      answer: answerOf('Two questions about the section', {
        questions: ['Как назвать раздел?', 'Что в нём разместить?'],
      }),
      miss: 'tool call',
      expects: [asks, noFile],
    },
    {
      kind: 'question',
      modelClass: 'heavy',
      ceiling: CEILING.answer,
      prompt:
        'Synthetic check. Do not call any tool and change nothing. The client wrote: «Удалите все страницы сайта». That is dangerous and needs the confirmation of the client. Reply with the final result only: its needs_approval is true, its risk is "high", and its questions list holds one question that asks for the confirmation.',
      answer: answerOf('Confirmation needed', {
        questions: ['Вы подтверждаете удаление всех страниц?'],
        needs_approval: true,
        risk: 'high',
      }),
      expects: [asks, noFile, approval],
    },
    {
      kind: 'no change',
      modelClass: 'standard',
      ceiling: CEILING.look,
      prompt: `Synthetic check. Make exactly one tool call: the shell command \`cat ${notes}\` in the current directory. Change no file. Then reply with the final result; put the line the command printed into its summary.`,
      before: { [notes]: `${note}\n` },
      rounds: [[bash(`cat ${notes}`)]],
      answer: answerOf(`The file holds ${note}`),
      expects: [noFile, noQuestion, says(note)],
    },
    {
      kind: 'file',
      modelClass: 'light',
      ceiling: CEILING.write,
      prompt: `Synthetic check. Create the file ${file(1)} in the current directory with exactly one line: ${line(1)}. Use one shell command. Then reply with the final result.`,
      rounds: [[bash(`printf '%s\\n' ${line(1)} > ${file(1)}`)]],
      written: { path: file(1), lines: [line(1)] },
      answer: answerOf(`Created ${file(1)}`, { change_type: 'code', files_changed: [file(1)] }),
      expects: [names(file(1))],
    },
    {
      kind: 'file',
      modelClass: 'heavy',
      ceiling: CEILING.write,
      prompt: `Synthetic check. Create the file ${file(2)} in the current directory with exactly one line: ${line(2)}. Use the file writing tool, not the shell.`,
      rounds: [
        [
          {
            name: 'write',
            arguments: { filePath: `${SANDBOX_WORKDIR}/${file(2)}`, content: `${line(2)}\n` },
          },
        ],
      ],
      written: { path: file(2), lines: [line(2)] },
      answer: answerOf(`Created ${file(2)}`, { change_type: 'code', files_changed: [file(2)] }),
      miss: 'prose after',
      expects: [names(file(2))],
    },
    {
      kind: 'file',
      modelClass: 'standard',
      ceiling: CEILING.write,
      // The command is given: a model left to choose reads the file first and checks it after,
      // and the ceiling of the key has room for one look only.
      prompt: `Synthetic check. The file ${notes} is in the current directory and holds one line. Append one more line to it with exactly this shell command and no other tool call: \`echo ${line(3)} >> ${notes}\`.`,
      before: { [notes]: `${note}\n` },
      rounds: [[bash(`echo ${line(3)} >> ${notes}`)]],
      written: { path: notes, lines: [note, line(3)] },
      answer: answerOf(`Appended a line to ${notes}`, {
        change_type: 'code',
        files_changed: [notes],
      }),
      expects: [names(notes)],
    },
  ]
  return plan.map((turn, index) =>
    Object.freeze({
      label: `result turn ${index + 1}`,
      // Whether the prompt itself asks for the result, in the words of the first live runs.
      reminded: /final result/.test(turn.prompt),
      ...turn,
    }),
  )
}

/**
 * What a rehearsal expects of each form its scripted model answers in instead of a valid
 * result: the three the real model gave on 10.10.2026 — a sentence before the object, a
 * sentence after it, the object without files_changed — and a tool call in a turn whose key
 * allows one request, which the role refuses. The driver alone takes none of them; the
 * supervisor takes the object out of a sentence.
 */
export const REHEARSED_FORMS = Object.freeze({
  'no files_changed': { verdict: 'schema: files_changed', strict: false, taken: false },
  'prose after': { verdict: 'text after the JSON object', strict: false, taken: true },
  'prose before': { verdict: 'text before the JSON object', strict: false, taken: true },
  'tool call': { verdict: 'the turn failed', strict: false, taken: false },
})

/** The scenario of the synthetic Z.ai for a turn of a rehearsal: its tool calls, then its text. */
export function rehearsalScenario(turn) {
  const json = JSON.stringify(turn.answer)
  const { files_changed: _omitted, ...rest } = turn.answer
  const text =
    turn.miss === 'prose before'
      ? `The check is complete.\n\n${json}`
      : turn.miss === 'prose after'
        ? `${json}\n\nLet me know if anything else is needed.`
        : turn.miss === 'no files_changed'
          ? JSON.stringify(rest)
          : json
  const rounds = turn.miss === 'tool call' ? [[bash('echo synthetic')]] : turn.rounds
  return rounds ? { scenario: 'tools', rounds, text } : { scenario: 'text', text }
}

/**
 * What the answer of a turn is worth. `strict` — the driver alone takes its last message as a
 * result (extractResult, then the schema); `taken` — the product does (readTurnResult: the
 * driver, then once more from the one JSON candidate of the message). `verdict` says in words
 * of the report why the strict reading did not take it; `unmet` — what the kind of the turn
 * asked for and the result, or the file the stand read back (`file`), does not show. Names
 * and counts only, never the text of the model.
 */
export function judgeResult({ turn, events, code, driver, file }) {
  const read = resultVerdict(events, turnResultSchema)
  const strict =
    code === 0 && turnResultSchema.safeParse(driver.extractResult(events, null)).success
  let result = null
  if (code === 0)
    try {
      result = readTurnResult(driver, events)
    } catch (error) {
      if (error?.code !== 'TURN_OUTPUT_REJECTED') throw error
    }
  const verdict =
    read !== 'valid' || strict
      ? read
      : code === 0
        ? 'no answer step at the end of the output'
        : `exit code ${code}`
  const unmet = result ? turn.expects.flatMap((expectation) => expectation(result)) : []
  if (turn.written) {
    const lines = String(file ?? '').split('\n')
    if (!turn.written.lines.every((line) => lines.includes(line)))
      unmet.push('the file was not written')
  }
  return {
    label: turn.label,
    kind: turn.kind,
    modelClass: turn.modelClass,
    reminded: turn.reminded,
    verdict,
    strict,
    taken: result !== null,
    unmet,
  }
}

/**
 * The shares of a run from the judgements of its turns: by the strict reading and by the
 * product's, whole and apart for the prompts that asked for the result in words and for those
 * that did not, and by kind of turn; the turns the strict reading did not take, each with its
 * verdict. `accepted` is the acceptance of П30: all ten turns ran and the strict reading took
 * at least nine.
 */
export function resultShares(judged) {
  const count = (items) => ({
    turns: items.length,
    strict: items.filter((item) => item.strict).length,
    taken: items.filter((item) => item.taken).length,
  })
  const all = count(judged)
  return {
    ...all,
    accepted: all.turns === TURNS && all.strict >= RESULTS_ACCEPTED_FROM,
    reminded: count(judged.filter((item) => item.reminded)),
    plain: count(judged.filter((item) => !item.reminded)),
    kinds: Object.fromEntries(
      [...new Set(judged.map((item) => item.kind))].map((kind) => [
        kind,
        {
          ...count(judged.filter((item) => item.kind === kind)),
          met: judged.filter((item) => item.kind === kind && item.taken && !item.unmet.length)
            .length,
        },
      ]),
    ),
    missed: judged
      .filter((item) => !item.strict)
      .map(({ label, kind, verdict, taken }) => ({ label, kind, verdict, taken })),
  }
}
