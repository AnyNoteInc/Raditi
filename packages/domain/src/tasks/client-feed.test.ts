import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { agentDriverIds, agentOutputLimits } from '../ports/agent-driver.ts'
import {
  feedCandidatePayloadSchema,
  feedCancelledBys,
  feedCeilingReasons,
  feedCreditsStates,
  feedCursorSchema,
  feedDecisionKinds,
  feedEventIdSchema,
  feedEventTypes,
  feedLimits,
  feedPayloadBytes,
  feedPayloadSchemas,
  feedQuestionKinds,
  feedQuestionPayloadSchema,
  feedReleaseOutcomes,
  feedReleaseReasons,
  feedRequestKinds,
  feedRequestPayloadSchema,
  feedResultNexts,
  feedResultPayloadSchema,
  feedRowSchema,
  feedRowSchemaWithin,
  feedSiteStates,
  feedStepPayloadSchema,
  feedSteps,
  feedTaskHeadSchema,
  isFeedEventType,
  readFeedRow,
  taskModes,
  taskWaitingReasons,
  type FeedEvent,
  type FeedEventType,
} from './client-feed.ts'
import {
  FEED_FAILURE_FALLBACK,
  feedFailureCodes,
  feedFailureRetry,
  feedFailureText,
} from './client-feed-failures.ts'
import { feedFixtures } from './client-feed-fixtures.ts'
import { feedText } from './client-feed-text.ts'
import { taskStatuses } from './task-status.ts'

const author = '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d8e'
const request = '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d8f'
const marker = '[[raditi:phone:3f2b8c1e-5d4a-4b6c-8e7f-9a0b1c2d3e4f]]'

const first = {
  v: 1,
  kind: 'first',
  text: 'Добавьте блок отзывов',
  authorId: author,
  requestId: request,
}
const answer = { ...first, kind: 'answer', answersEventId: '17' }
const retry = { v: 1, kind: 'retry', authorId: author, requestId: request }
const step = { v: 1, turn: 1, attempt: 1, step: 'work' }
const agentQuestion = {
  v: 1,
  kind: 'agent',
  turn: 1,
  intro: 'Нужно уточнить.',
  questions: [{ text: 'На какой странице?', options: [] }],
}
const ceiling = { v: 1, kind: 'ceiling', turn: 2, reason: 'credits', spent: 5, held: 5, left: 0 }
const result = {
  v: 1,
  turn: 1,
  message: 'Готово: заголовок обновлён.',
  site: 'changed',
  next: 'done',
  filesChanged: null,
  changeType: 'content',
  needsApproval: false,
  risk: 'low',
}
const failure = { v: 1, turn: 1, code: 'timeout', site: 'unchanged', credits: 'returned' }
const cancelled = { v: 1, turn: null, by: 'queue_timeout', site: 'unchanged', credits: null }
const revision = {
  v: 1,
  kind: 'revision',
  text: 'Сделайте кнопку зелёной',
  authorId: author,
  requestId: request,
  candidateRevision: 2,
}
const command = { v: 1, kind: 'command', command: 'release', authorId: author, requestId: request }
const continued = {
  v: 1,
  kind: 'continue',
  authorId: author,
  requestId: request,
  questionEventId: '21',
}
const candidate = {
  v: 1,
  turn: 2,
  revision: 1,
  version: 'v1.4.0',
  bump: 'minor',
  files: { added: 2, modified: 3, deleted: 0 },
  media: 1,
  records: 2,
}
const releaseId = '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d90'
const decision = { v: 1, kind: 'release', authorId: author, revision: 1, version: 'v1.4.0' }
const release = {
  v: 1,
  releaseId,
  version: 'v1.4.0',
  outcome: 'installed',
  reason: null,
  credits: null,
}

const undoId = '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d91'
const undoConfirmed = {
  v: 1,
  stage: 'confirmed',
  undoId,
  releaseId,
  undoneVersion: 'v1.4.0',
  version: 'v1.4.1',
  authorId: author,
}
const undoInstalled = {
  v: 1,
  stage: 'installed',
  undoId,
  releaseId,
  undoneVersion: 'v1.4.0',
  version: 'v1.4.1',
  returnsTo: 'v1.3.0',
  reason: null,
  records: { returned: 2, kept: 1 },
}

const samples: Record<FeedEventType, Record<string, unknown>[]> = {
  'feed.request': [
    first,
    answer,
    retry,
    { ...first, attachments: [author] },
    { ...answer, attachments: [author, request] },
    revision,
    { ...revision, attachments: [author] },
    command,
    { ...command, command: 'cancel' },
    continued,
  ],
  'feed.step': [step],
  'feed.question': [agentQuestion, ceiling],
  'feed.result': [result],
  'feed.failure': [failure],
  'feed.cancelled': [cancelled],
  'feed.candidate': [
    candidate,
    { ...candidate, bump: 'patch', files: { added: 0, modified: 0, deleted: 0 } },
  ],
  'feed.decision': [decision],
  'feed.update': [
    { v: 1, outcome: 'conflict', conflicts: 3 },
    { v: 1, outcome: 'emptied', conflicts: 0 },
  ],
  'feed.release': [
    release,
    { ...release, outcome: 'rolled_back', reason: 'site_check', credits: 'returned' },
    { ...release, outcome: 'refused', reason: 'outdated' },
  ],
  'feed.undo': [
    undoConfirmed,
    undoInstalled,
    { ...undoInstalled, stage: 'rolled_back', reason: 'site_check' },
    { ...undoInstalled, stage: 'refused', reason: 'undo_outdated' },
  ],
}

const accepts = (type: FeedEventType, payload: unknown) =>
  feedRowSchema.safeParse({ type, payload }).success
/** What a row gives the screen: the stored fields without the version. */
const shown = (type: FeedEventType, { v: _v, ...fields }: Record<string, unknown>) => ({
  type,
  ...fields,
})

describe('feed vocabulary', () => {
  it('lists the six types of the design and the four of a release, all under the feed prefix', () => {
    expect(feedEventTypes).toEqual([
      'feed.request',
      'feed.step',
      'feed.question',
      'feed.result',
      'feed.failure',
      'feed.cancelled',
      'feed.candidate',
      'feed.decision',
      'feed.release',
      'feed.update',
      'feed.undo',
    ])
    expect(Object.keys(feedPayloadSchemas)).toEqual([...feedEventTypes])
    expect(isFeedEventType('feed.step')).toBe(true)
    expect(isFeedEventType('turn.output')).toBe(false)
    expect(isFeedEventType('feed.approval')).toBe(false)
  })

  it('keeps the agent text limits equal to the limits of the turn result', () => {
    expect(feedLimits.intro).toBe(agentOutputLimits.clientMessage)
    expect(feedLimits.message).toBe(agentOutputLimits.clientMessage)
    expect(feedLimits.questions).toBe(agentOutputLimits.questions)
    expect(feedLimits.question).toBe(agentOutputLimits.question)
    expect(feedLimits.questionOptions).toBe(agentOutputLimits.questionOptions)
    expect(feedLimits.questionOption).toBe(agentOutputLimits.questionOption)
  })

  it('names no agent shell, CMS or provider (rule 8)', () => {
    const vocabulary = JSON.stringify(z.toJSONSchema(feedRowSchema)).toLowerCase()
    for (const name of [
      ...agentDriverIds,
      'wordpress',
      'bitrix',
      'gitea',
      'github',
      'gitlab',
      'openai',
      'glm',
    ])
      expect(vocabulary).not.toContain(name)
  })
})

describe('round trip', () => {
  it.each(
    feedEventTypes.flatMap((type) => samples[type].map((payload) => [type, payload] as const)),
  )('%s is written and read back unchanged', (type, payload) => {
    const row = feedRowSchema.parse({ type, payload })
    expect(row).toEqual({ type, payload })
    expect(feedPayloadSchemas[type].parse(payload)).toEqual(payload)
    // What was stored went through JSON.
    const stored: unknown = JSON.parse(JSON.stringify(row.payload))
    expect(readFeedRow(type, stored)).toEqual(shown(type, payload))
  })

  it.each(feedFixtures.map((fixture) => [fixture.name, fixture] as const))(
    'frozen sample «%s» is still written and read',
    (_name, fixture) => {
      expect(accepts(fixture.type, fixture.payload)).toBe(true)
      expect(readFeedRow(fixture.type, fixture.payload)).toEqual(
        shown(fixture.type, { ...fixture.payload }),
      )
    },
  )

  it('has a frozen sample of every type', () => {
    expect(new Set(feedFixtures.map((fixture) => fixture.type))).toEqual(new Set(feedEventTypes))
  })
})

describe('free text is allowed in exactly four fields', () => {
  type Node = Record<string, unknown>
  const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null

  /** Paths of string leaves a writer may fill with anything: no enum, const, pattern or format. */
  function freeStrings(node: unknown, path: string, found: Set<string>): Set<string> {
    if (!isNode(node)) return found
    if (
      node.type === 'string' &&
      !('enum' in node) &&
      !('const' in node) &&
      !('pattern' in node) &&
      !('format' in node)
    )
      found.add(path)
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
      const options = node[key]
      if (Array.isArray(options)) for (const option of options) freeStrings(option, path, found)
    }
    if (isNode(node.properties))
      for (const [name, child] of Object.entries(node.properties))
        freeStrings(child, `${path}.${name}`, found)
    if ('items' in node) freeStrings(node.items, `${path}[]`, found)
    if (isNode(node.additionalProperties))
      freeStrings(node.additionalProperties, `${path}{}`, found)
    return found
  }

  it('walks every writing schema and finds no other free string', () => {
    const found = new Set<string>()
    for (const type of feedEventTypes)
      freeStrings(z.toJSONSchema(feedPayloadSchemas[type]), type, found)
    expect([...found].sort()).toEqual([
      'feed.question.intro',
      'feed.question.questions[].options[]',
      'feed.question.questions[].text',
      'feed.request.text',
      'feed.result.message',
    ])
  })

  it('finds no free string in the platform question about credits', () => {
    const platform = feedQuestionPayloadSchema.options[1]
    expect(platform.shape.kind.value).toBe('ceiling')
    expect([...freeStrings(z.toJSONSchema(platform), 'ceiling', new Set())]).toEqual([])
  })

  it('refuses unknown keys in every object of every writing schema', () => {
    function open(node: unknown, path: string, found: string[]): string[] {
      if (!isNode(node)) return found
      if (node.type === 'object' && node.additionalProperties !== false) found.push(path)
      for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
        const options = node[key]
        if (Array.isArray(options)) for (const option of options) open(option, path, found)
      }
      if (isNode(node.properties))
        for (const [name, child] of Object.entries(node.properties))
          open(child, `${path}.${name}`, found)
      if ('items' in node) open(node.items, `${path}[]`, found)
      return found
    }
    // The input side: on the output side a plain z.object() is printed as closed too.
    const loose = z.strictObject({ list: z.array(z.object({ a: z.string() })) })
    expect(open(z.toJSONSchema(loose, { io: 'input' }), 'row', [])).toEqual(['row.list[]'])
    expect(open(z.toJSONSchema(feedRowSchema, { io: 'input' }), 'row', [])).toEqual([])
  })
})

describe('nothing raw reaches the customer', () => {
  const raw: Record<string, unknown> = {
    reason: 'Error: ENOENT /workspace/repo/wp-config.php',
    path: 'wp-content/themes/shop/front-page.php',
    summary: 'Edited front-page.php',
    files_changed: ['a.php'],
    command: 'rm -rf /',
    tool: 'shell',
    text: 'промежуточные слова агента',
    usage: { output: 10 },
    model: 'some-model',
    driver: 'some-shell',
    containerId: 'abc',
    fence: { epoch: 1 },
    rubles: '12.00',
  }

  it.each(
    feedEventTypes.flatMap((type) =>
      samples[type].flatMap((payload) =>
        Object.keys(raw)
          .filter((key) => !(key in payload))
          .map((key) => [type, key, payload] as const),
      ),
    ),
  )('%s refuses the extra key «%s»', (type, key, payload) => {
    expect(accepts(type, { ...payload, [key]: raw[key] })).toBe(false)
    expect(feedPayloadSchemas[type].safeParse({ ...payload, [key]: raw[key] }).success).toBe(false)
  })

  // docs/plan/53, «Попробовать ещё (18.10)».
  it('writes the end a failure moved the dialog to, and reads an unknown one as the old end', () => {
    expect(accepts('feed.failure', { ...failure, next: 'awaiting_approval' })).toBe(true)
    expect(accepts('feed.failure', { ...failure, next: 'failed' })).toBe(true)
    expect(accepts('feed.failure', { ...failure, next: 'done' })).toBe(false)
    expect(readFeedRow('feed.failure', { ...failure, next: 'later' })).toEqual(
      shown('feed.failure', failure),
    )
  })

  it('writes a retry with the failure it answers, never as a command', () => {
    expect(accepts('feed.request', { ...retry, failureEventId: '17' })).toBe(true)
    expect(accepts('feed.request', { ...retry, failureEventId: '017' })).toBe(false)
    expect(accepts('feed.request', { ...retry, kind: 'command', command: 'retry' })).toBe(false)
    expect(accepts('feed.request', { ...retry, kind: 'command', command: 'update' })).toBe(true)
  })

  it('refuses a failure carrying a reason, also in place of the code', () => {
    expect(accepts('feed.failure', { ...failure, reason: 'provider said no' })).toBe(false)
    expect(accepts('feed.failure', { ...failure, code: 'TURN_EXEC_FAILED' })).toBe(false)
    expect(accepts('feed.failure', { ...failure, code: 'provider said no' })).toBe(false)
  })

  it('refuses a platform question with text and an agent question with numbers', () => {
    expect(accepts('feed.question', { ...ceiling, intro: 'Продолжить?' })).toBe(false)
    expect(accepts('feed.question', { ...ceiling, questions: [] })).toBe(false)
    expect(accepts('feed.question', { ...agentQuestion, spent: 1 })).toBe(false)
    expect(accepts('feed.question', { ...agentQuestion, reason: 'step' })).toBe(false)
  })

  it('refuses extra keys inside a question and on the row itself', () => {
    expect(
      accepts('feed.question', {
        ...agentQuestion,
        questions: [{ text: 'Где?', options: [], path: 'index.php' }],
      }),
    ).toBe(false)
    expect(
      feedRowSchema.safeParse({ type: 'feed.step', payload: step, clientVisible: false }).success,
    ).toBe(false)
  })

  it('refuses agent text that did not pass feedText(): markers, invisible and control characters', () => {
    for (const text of [
      `Позвоните ${marker}`,
      'текст\u202Eнаоборот',
      'нуль\u0000',
      'та\tб',
      'а\r\nб',
      // Half of a surrogate pair: jsonb would refuse the row.
      'a\uD800b',
      'обрыв\uD83D',
      // Not NFC.
      '\u0438\u0306',
      'мяг\u00ADкий',
      '\\[\\[raditi:phone:3f2b8c1e-5d4a-4b6c-8e7f-9a0b1c2d3e4f\\]\\]',
      '[[raditi: что-то]]',
    ]) {
      expect(accepts('feed.result', { ...result, message: text })).toBe(false)
      expect(accepts('feed.question', { ...agentQuestion, intro: text })).toBe(false)
      expect(
        accepts('feed.question', { ...agentQuestion, questions: [{ text, options: [] }] }),
      ).toBe(false)
      expect(
        accepts('feed.question', {
          ...agentQuestion,
          questions: [{ text: 'Где?', options: [text] }],
        }),
      ).toBe(false)
    }
    expect(accepts('feed.result', { ...result, message: 'первая строка\nвторая' })).toBe(true)
    expect(accepts('feed.result', { ...result, message: 'смайлик \uD83D\uDE00' })).toBe(true)
  })

  it('takes whatever feedText() returns, also for text it had to compose', () => {
    for (const raw of [
      'e\u200B\u0301',
      '\u0438\u200D\u0306',
      'e\u0007\u0301',
      'обрыв\uD83D',
      `Позвоните ${marker}\u202E.`,
    ]) {
      const text = feedText(raw)
      expect(accepts('feed.result', { ...result, message: text }), JSON.stringify(raw)).toBe(true)
      expect(
        accepts('feed.question', {
          ...agentQuestion,
          intro: text,
          questions: [{ text, options: [text] }],
        }),
      ).toBe(true)
    }
  })

  it('wants something to read in agent text: a blank one is refused and read as «unreadable»', () => {
    for (const blank of ['   ', '\n', ' \n \n', '\u00A0', '\u3000 \u2028']) {
      expect(accepts('feed.result', { ...result, message: blank }), JSON.stringify(blank)).toBe(
        false,
      )
      const question = (text: string, intro = 'Уточните, пожалуйста.', options: string[] = []) => ({
        ...agentQuestion,
        intro,
        questions: [{ text, options }],
      })
      const blankQuestions = [
        question(blank),
        question('Где?', blank),
        question('Где?', 'Да?', [blank]),
      ]
      for (const payload of blankQuestions) {
        expect(accepts('feed.question', payload), JSON.stringify(payload)).toBe(false)
        expect(readFeedRow('feed.question', payload)).toEqual({ type: 'unreadable' })
      }
      expect(readFeedRow('feed.result', { ...result, message: blank })).toEqual({
        type: 'unreadable',
      })
    }
    // Nothing is left to read once feedText() has removed what it removes.
    for (const gone of ['\u200B\u200B', '\u0001', ' \u202E\t', '\uD800 '])
      expect(readFeedRow('feed.result', { ...result, message: gone })).toEqual({
        type: 'unreadable',
      })
    // Spaces around visible text are stored and shown as written.
    expect(accepts('feed.result', { ...result, message: ' Готово.\n' })).toBe(true)
    expect(readFeedRow('feed.result', { ...result, message: ' Готово.\n' })).toMatchObject({
      message: ' Готово.\n',
    })
  })

  it('cleans half of a surrogate pair on reading', () => {
    expect(readFeedRow('feed.result', { ...result, message: 'a\uD800b' })).toMatchObject({
      type: 'feed.result',
      message: 'ab',
    })
    expect(readFeedRow('feed.result', { ...result, message: '\uD800' })).toEqual({
      type: 'unreadable',
    })
  })

  it('hides a marker again on reading, whoever wrote the row', () => {
    const read = readFeedRow('feed.result', { ...result, message: `Позвоните ${marker}\u202E.` })
    expect(read).toMatchObject({ type: 'feed.result', message: 'Позвоните (телефон скрыт).' })
    const question = readFeedRow('feed.question', {
      ...agentQuestion,
      intro: marker,
      questions: [{ text: `Оставить ${marker}?`, options: [marker] }],
    })
    expect(JSON.stringify(question)).not.toContain('raditi')
    expect(question).toMatchObject({ intro: '(телефон скрыт)' })
  })

  it('never returns a key the schema does not name', () => {
    for (const type of feedEventTypes)
      for (const payload of samples[type]) {
        const read = readFeedRow(type, { ...payload, ...raw, ...payload })
        expect(read.type).toBe(type)
        for (const key of Object.keys(raw))
          if (!(key in payload)) expect(read).not.toHaveProperty(key)
        expect(read).not.toHaveProperty('v')
      }
  })
})

describe('feed.request', () => {
  const text = (value: string) => accepts('feed.request', { ...first, text: value })

  it('bounds the text at 4000 characters after trimming', () => {
    expect(text('я'.repeat(4000))).toBe(true)
    expect(text('я'.repeat(4001))).toBe(false)
    expect(text(`  ${'я'.repeat(4000)}\n`)).toBe(true)
    expect(text('я')).toBe(true)
    expect(text('')).toBe(false)
    expect(text(' \n\t ')).toBe(false)
  })

  it('stops at the length: a text over the limit is not read for anything else', () => {
    // NFC over this run of combining marks took seconds when the secret check still ran.
    const marks = `a${'\u0301\u0323'.repeat(64_000)}`
    const started = performance.now()
    for (const long of [marks, `пароль: Qwerty123 ${'я'.repeat(4000)}`, '\u0000'.repeat(4001)]) {
      const parsed = feedRequestPayloadSchema.safeParse({ ...first, text: long })
      expect(parsed.error?.issues.map((issue) => issue.code)).toEqual(['too_big'])
    }
    expect(accepts('feed.request', { ...answer, text: marks })).toBe(false)
    expect(performance.now() - started).toBeLessThan(1000)
    // A text of exactly the limit is still read.
    expect(text(`${'я'.repeat(3990)} Qwerty123`)).toBe(false)
    expect(text(`a${'\u0301\u0323'.repeat(1999)}я`)).toBe(true)
  })

  it('stores the trimmed text', () => {
    expect(feedRequestPayloadSchema.parse({ ...first, text: '  Здравствуйте \n' })).toMatchObject({
      text: 'Здравствуйте',
    })
  })

  it('keeps line breaks and tabs and refuses other control characters', () => {
    expect(text('первая\nвторая\tтретья')).toBe(true)
    expect(text('нуль\u0000внутри')).toBe(false)
    expect(text('возврат\r\nкаретки')).toBe(false)
    expect(text('звонок\u0007')).toBe(false)
    expect(text('удаление\u007F')).toBe(false)
  })

  it('refuses half of a surrogate pair and keeps a whole pair', () => {
    expect(text('a\uDC00b')).toBe(false)
    expect(text('обрыв \uD83D')).toBe(false)
    expect(text('смайлик \uD83D\uDE00')).toBe(true)
    expect(accepts('feed.request', { ...answer, text: '\uD83D' })).toBe(false)
  })

  it('wants at least one visible character and takes invisible ones inside the text', () => {
    expect(text('\u200B')).toBe(false)
    expect(text('\u200B\u202E\u2066')).toBe(false)
    expect(text(' \uFEFF\n\u00AD ')).toBe(false)
    expect(accepts('feed.request', { ...answer, text: '\u200B' })).toBe(false)
    // The customer's words are stored as written.
    expect(feedRequestPayloadSchema.parse({ ...first, text: 'при\u200Bвет' })).toMatchObject({
      text: 'при\u200Bвет',
    })
    expect(text('\uD83D\uDC68\u200D\uD83D\uDC69')).toBe(true)
  })

  it('refuses text that looks like a password or a key, without repeating it', () => {
    for (const secret of [
      'пароль: Qwerty123456',
      'Пароль от админки: Qwerty123',
      'зайдите под admin / Qwerty123',
    ]) {
      expect(text(secret)).toBe(false)
      const refused = feedRowSchema.safeParse({
        type: 'feed.request',
        payload: { ...answer, text: secret },
      })
      expect(refused.success).toBe(false)
      expect(JSON.stringify(refused.error?.issues)).not.toContain('Qwerty')
      expect(refused.error?.issues.map((issue) => issue.message)).toEqual([
        'looks like a password or a key',
      ])
    }
    expect(
      text('Поменяйте телефон в шапке на +7 (495) 123-45-67, почту — на info@example.ru'),
    ).toBe(true)
    expect(text('Поле пароль: увеличьте шрифт')).toBe(true)
    // An address is never refused, whatever it holds.
    expect(text('ftp://admin:Qwerty123@example.ru/public_html')).toBe(true)
  })

  it('requires the text for a first request and an answer and refuses it for a retry', () => {
    const { text: _text, ...noText } = first
    expect(accepts('feed.request', noText)).toBe(false)
    expect(accepts('feed.request', { ...noText, kind: 'answer', answersEventId: '1' })).toBe(false)
    expect(accepts('feed.request', { ...retry, text: 'ещё раз' })).toBe(false)
  })

  it('requires the question id for an answer only', () => {
    const { answersEventId: _id, ...noId } = answer
    expect(accepts('feed.request', noId)).toBe(false)
    expect(accepts('feed.request', { ...first, answersEventId: '17' })).toBe(false)
    expect(accepts('feed.request', { ...retry, answersEventId: '17' })).toBe(false)
    for (const id of [
      '0',
      '017',
      '-1',
      '1.5',
      'q:1',
      '',
      '1'.repeat(20),
      '9223372036854775808',
      '9999999999999999999',
    ])
      expect(accepts('feed.request', { ...answer, answersEventId: id })).toBe(false)
    expect(accepts('feed.request', { ...answer, answersEventId: 17 })).toBe(false)
    expect(accepts('feed.request', { ...answer, answersEventId: '9223372036854775807' })).toBe(true)
  })

  it('takes ids only: no author name, no address', () => {
    expect(accepts('feed.request', { ...first, authorId: 'Иван Петров' })).toBe(false)
    expect(accepts('feed.request', { ...first, authorId: 'ivan@example.ru' })).toBe(false)
    expect(accepts('feed.request', { ...first, requestId: 'r1' })).toBe(false)
    const { requestId: _request, ...noRequest } = first
    expect(accepts('feed.request', noRequest)).toBe(false)
  })

  it('takes up to ten attachment ids', () => {
    expect(accepts('feed.request', { ...first, attachments: Array(10).fill(author) })).toBe(true)
    expect(accepts('feed.request', { ...first, attachments: Array(11).fill(author) })).toBe(false)
    expect(accepts('feed.request', { ...first, attachments: ['inbox/photo.png'] })).toBe(false)
    expect(accepts('feed.request', { ...answer, attachments: [author] })).toBe(true)
  })

  it('takes no attachments with a retry: it is a press, and the reader would drop them', () => {
    expect(accepts('feed.request', { ...retry, attachments: [author] })).toBe(false)
    expect(accepts('feed.request', { ...retry, attachments: [] })).toBe(false)
  })

  it('lists the six kinds written today', () => {
    expect(feedRequestKinds).toEqual([
      'first',
      'answer',
      'retry',
      'revision',
      'command',
      'continue',
    ])
  })

  it('refuses a kind it does not know', () => {
    for (const kind of ['message', 'rewrite'])
      expect(accepts('feed.request', { ...first, kind })).toBe(false)
  })

  it('takes «Продолжить» as a press with the question of the platform it answers', () => {
    expect(accepts('feed.request', continued)).toBe(true)
    const { questionEventId: _question, ...noQuestion } = continued
    expect(accepts('feed.request', noQuestion)).toBe(false)
    expect(accepts('feed.request', { ...continued, questionEventId: '0' })).toBe(false)
    expect(accepts('feed.request', { ...continued, text: 'Продолжайте' })).toBe(false)
    expect(accepts('feed.request', { ...continued, attachments: [author] })).toBe(false)
  })

  it('takes words for a candidate with the revision they are about', () => {
    expect(accepts('feed.request', revision)).toBe(true)
    const { candidateRevision: _revision, ...noRevision } = revision
    expect(accepts('feed.request', noRevision)).toBe(false)
    expect(accepts('feed.request', { ...revision, candidateRevision: 0 })).toBe(false)
    expect(accepts('feed.request', { ...revision, text: 'пароль: Qwerty123456' })).toBe(false)
  })

  it('takes a command as a press: its id, never words for the agent', () => {
    for (const id of ['release', 'preview', 'reset', 'update', 'cancel'])
      expect(accepts('feed.request', { ...command, command: id })).toBe(true)
    expect(accepts('feed.request', { ...command, command: 'deploy' })).toBe(false)
    expect(accepts('feed.request', { ...command, text: '/release' })).toBe(false)
    expect(accepts('feed.request', { ...command, attachments: [author] })).toBe(false)
  })
})

describe('feed.step', () => {
  it('takes the four stages and nothing else', () => {
    for (const name of feedSteps) expect(accepts('feed.step', { ...step, step: name })).toBe(true)
    expect(feedSteps).toEqual(['work', 'save', 'site', 'files'])
    expect(accepts('feed.step', { ...step, step: 'thinking' })).toBe(false)
  })

  it('bounds the turn and the attempt', () => {
    expect(accepts('feed.step', { ...step, turn: 999_999 })).toBe(true)
    expect(accepts('feed.step', { ...step, turn: 1_000_000 })).toBe(false)
    expect(accepts('feed.step', { ...step, turn: 0 })).toBe(false)
    expect(accepts('feed.step', { ...step, turn: 1.5 })).toBe(false)
    expect(accepts('feed.step', { ...step, turn: null })).toBe(false)
    expect(accepts('feed.step', { ...step, attempt: 0 })).toBe(false)
    expect(feedStepPayloadSchema.safeParse({ ...step, attempt: 3 }).success).toBe(true)
  })
})

describe('feed.question', () => {
  const questions = (count: number, text = 'Где?') =>
    Array.from({ length: count }, () => ({ text, options: [] as string[] }))

  it('takes one to five questions', () => {
    expect(accepts('feed.question', { ...agentQuestion, questions: questions(5) })).toBe(true)
    expect(accepts('feed.question', { ...agentQuestion, questions: questions(6) })).toBe(false)
    expect(accepts('feed.question', { ...agentQuestion, questions: [] })).toBe(false)
  })

  it('bounds the intro, the question and its options', () => {
    const withIntro = (intro: string) => accepts('feed.question', { ...agentQuestion, intro })
    expect(withIntro('я'.repeat(2000))).toBe(true)
    expect(withIntro('я'.repeat(2001))).toBe(false)
    expect(withIntro('')).toBe(false)
    const withText = (text: string) =>
      accepts('feed.question', { ...agentQuestion, questions: questions(1, text) })
    expect(withText('я'.repeat(500))).toBe(true)
    expect(withText('я'.repeat(501))).toBe(false)
    expect(withText('')).toBe(false)
    const withOptions = (options: string[]) =>
      accepts('feed.question', { ...agentQuestion, questions: [{ text: 'Где?', options }] })
    expect(withOptions(Array(6).fill('Да'))).toBe(true)
    expect(withOptions(Array(7).fill('Да'))).toBe(false)
    expect(withOptions(['я'.repeat(200)])).toBe(true)
    expect(withOptions(['я'.repeat(201)])).toBe(false)
    expect(withOptions([''])).toBe(false)
  })

  it('requires the options list of every question', () => {
    expect(accepts('feed.question', { ...agentQuestion, questions: [{ text: 'Где?' }] })).toBe(
      false,
    )
    expect(accepts('feed.question', { ...agentQuestion, questions: ['Где?'] })).toBe(false)
  })

  it('takes a platform question as a reason and three whole non-negative numbers', () => {
    for (const reason of ['step', 'credits', 'gift', 'attempts'])
      expect(accepts('feed.question', { ...ceiling, reason })).toBe(true)
    expect(accepts('feed.question', { ...ceiling, reason: 'budget' })).toBe(false)
    expect(accepts('feed.question', { ...ceiling, spent: -1 })).toBe(false)
    expect(accepts('feed.question', { ...ceiling, held: 1.5 })).toBe(false)
    expect(accepts('feed.question', { ...ceiling, left: '3' })).toBe(false)
    const { left: _left, ...noLeft } = ceiling
    expect(accepts('feed.question', noLeft)).toBe(false)
  })

  it('refuses an unknown kind', () => {
    expect(accepts('feed.question', { ...agentQuestion, kind: 'approval' })).toBe(false)
    expect(feedQuestionKinds).toEqual(['agent', 'ceiling'])
    expect(feedCeilingReasons).toEqual(['step', 'credits', 'gift', 'attempts'])
  })
})

describe('feed.result', () => {
  it('bounds the message', () => {
    expect(accepts('feed.result', { ...result, message: 'я'.repeat(2000) })).toBe(true)
    expect(accepts('feed.result', { ...result, message: 'я'.repeat(2001) })).toBe(false)
    expect(accepts('feed.result', { ...result, message: '' })).toBe(false)
  })

  it('bounds the trusted file count and takes null for «not known»', () => {
    for (const filesChanged of [0, 10_000, null])
      expect(accepts('feed.result', { ...result, filesChanged })).toBe(true)
    for (const filesChanged of [10_001, -1, 1.5, ['a.php'], undefined])
      expect(accepts('feed.result', { ...result, filesChanged })).toBe(false)
  })

  it('closes its enums', () => {
    expect(feedResultNexts).toEqual(['done', 'awaiting_approval'])
    for (const next of ['awaiting_user', 'failed', 'cancelled', 'deploying', 'queued'])
      expect(accepts('feed.result', { ...result, next })).toBe(false)
    for (const site of ['unchanged', 'changed', 'check'])
      expect(accepts('feed.result', { ...result, site })).toBe(true)
    // A result never claims a restore.
    expect(accepts('feed.result', { ...result, site: 'restored' })).toBe(false)
    expect(accepts('feed.result', { ...result, next: 'awaiting_approval' })).toBe(true)
    expect(accepts('feed.result', { ...result, next: 'awaiting_user' })).toBe(false)
    expect(accepts('feed.result', { ...result, changeType: 'deploy' })).toBe(false)
    expect(accepts('feed.result', { ...result, risk: 'none' })).toBe(false)
    expect(accepts('feed.result', { ...result, needsApproval: 'yes' })).toBe(false)
    expect(feedResultPayloadSchema.safeParse({ ...result, turn: null }).success).toBe(false)
  })
})

describe('feed.failure and feed.cancelled', () => {
  it('take every code of the catalogue and a null turn', () => {
    for (const code of feedFailureCodes)
      expect(accepts('feed.failure', { ...failure, code, turn: null })).toBe(true)
  })

  it('close the trusted facts about the site and the credits', () => {
    expect(feedSiteStates).toEqual(['unchanged', 'changed', 'restored', 'check'])
    expect(feedCreditsStates).toEqual(['returned', 'expired'])
    for (const type of ['feed.failure', 'feed.cancelled'] as const) {
      const base = type === 'feed.failure' ? failure : cancelled
      for (const site of ['unchanged', 'restored', 'check'])
        expect(accepts(type, { ...base, site })).toBe(true)
      // A failed or cancelled task never claims «changed»: it is restored or in doubt.
      expect(accepts(type, { ...base, site: 'changed' })).toBe(false)
      for (const credits of ['returned', 'expired', null])
        expect(accepts(type, { ...base, credits })).toBe(true)
      expect(accepts(type, { ...base, credits: 'charged' })).toBe(false)
      const { credits: _credits, ...noCredits } = base
      expect(accepts(type, noCredits)).toBe(false)
    }
  })

  it('take every way of cancelling, with an optional author id', () => {
    // The list of the design, not the list of the implementation checked against itself.
    expect(feedCancelledBys).toEqual([
      'not_available',
      'queue_timeout',
      'customer',
      'declined',
      'stopped',
      'no_answer',
    ])
    for (const by of feedCancelledBys)
      expect(accepts('feed.cancelled', { ...cancelled, by })).toBe(true)
    expect(accepts('feed.cancelled', { ...cancelled, by: 'operator' })).toBe(false)
    expect(accepts('feed.cancelled', { ...cancelled, by: 'customer', authorId: author })).toBe(true)
    expect(accepts('feed.cancelled', { ...cancelled, authorId: 'Иван' })).toBe(false)
  })
})

describe('versions', () => {
  it('writes only the current version', () => {
    for (const type of feedEventTypes)
      for (const payload of samples[type]) {
        const { v: _v, ...noVersion } = payload
        expect(accepts(type, noVersion)).toBe(false)
        expect(accepts(type, { ...payload, v: 2 })).toBe(false)
        expect(accepts(type, { ...payload, v: '1' })).toBe(false)
      }
  })

  it('reads a newer version of a known type as «newer»', () => {
    for (const type of feedEventTypes)
      for (const payload of samples[type]) {
        expect(readFeedRow(type, { ...payload, v: 2 })).toEqual({ type: 'newer' })
        expect(readFeedRow(type, { v: 7, whatever: true })).toEqual({ type: 'newer' })
      }
  })

  it('reads a missing or malformed version as «unreadable»', () => {
    for (const v of [undefined, null, '1', 0, -1, 1.5, Number.NaN, 'constructor', '__proto__']) {
      expect(readFeedRow('feed.step', { ...step, v })).toEqual({ type: 'unreadable' })
    }
  })
})

describe('reading stored rows', () => {
  it('reads an unknown feed type as «newer»: the row may be a consent card', () => {
    // `feed.decision` was one of these until the release rows came (plan 53); `feed.consent`
    // stands in for it.
    for (const type of [
      'feed.approval',
      'feed.consent',
      'feed.deploy',
      'feed.revert',
      'feed.x',
      'feed.',
    ])
      expect(readFeedRow(type, { v: 1 })).toEqual({ type: 'newer' })
    expect(readFeedRow('feed.approval', null)).toEqual({ type: 'newer' })
  })

  it('reads a row that is not a feed row as «unreadable» and returns nothing of it', () => {
    const secretive = { v: 1, events: [{ type: 'command', command: 'cat wp-config.php' }] }
    for (const type of ['turn.output', 'turn.lifecycle', 'llm.policy_flagged', '', 'FEED.step'])
      expect(readFeedRow(type, secretive)).toEqual({ type: 'unreadable' })
  })

  it('reads a broken payload as «unreadable» and never throws', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom')
        },
      },
    )
    const shapeless: unknown[] = [
      null,
      undefined,
      'text',
      42,
      [],
      [{ v: 1 }],
      {},
      { v: 1 },
      hostile,
    ]
    for (const type of feedEventTypes)
      for (const payload of shapeless)
        expect(readFeedRow(type, payload)).toEqual({ type: 'unreadable' })

    const broken: Record<FeedEventType, unknown[]> = {
      'feed.request': [
        { ...first, text: '' },
        { ...first, text: 'я'.repeat(4001) },
        { ...first, text: undefined },
        { ...first, authorId: 'Иван' },
        { ...first, kind: undefined },
        { ...first, kind: 7 },
        { ...answer, answersEventId: 'q:1' },
        { ...answer, answersEventId: undefined },
        { ...retry, requestId: undefined },
      ],
      'feed.step': [
        { ...step, turn: 'first' },
        { ...step, turn: 0 },
        { ...step, attempt: 0 },
        { ...step, attempt: undefined },
        { ...step, step: undefined },
        { ...step, step: 7 },
      ],
      'feed.question': [
        { ...agentQuestion, kind: undefined },
        { ...agentQuestion, intro: undefined },
        { ...agentQuestion, intro: '\u200B' },
        { ...agentQuestion, questions: [] },
        { ...agentQuestion, questions: 'Где?' },
        { ...agentQuestion, questions: [{ text: 'Где?' }] },
        { ...ceiling, reason: undefined },
        { ...ceiling, reason: 7 },
        { ...ceiling, spent: -1 },
        { ...ceiling, left: undefined },
      ],
      'feed.result': [
        { ...result, message: 42 },
        { ...result, message: 'я'.repeat(2001) },
        { ...result, message: '\u200B' },
        { ...result, filesChanged: 'много' },
        { ...result, filesChanged: undefined },
        { ...result, needsApproval: undefined },
        { ...result, site: undefined },
        { ...result, next: undefined },
        { ...result, turn: null },
      ],
      'feed.failure': [
        { ...failure, turn: 0 },
        { ...failure, turn: undefined },
        { ...failure, code: undefined },
        { ...failure, code: 7 },
        { ...failure, site: undefined },
        { ...failure, credits: undefined },
        { ...failure, credits: 5 },
      ],
      'feed.cancelled': [
        { ...cancelled, by: undefined },
        { ...cancelled, authorId: 'Иван' },
        { ...cancelled, site: null },
        { ...cancelled, credits: undefined },
      ],
      'feed.candidate': [
        { ...candidate, version: '1.4.0' },
        { ...candidate, revision: 0 },
        { ...candidate, files: undefined },
        { ...candidate, records: -1 },
      ],
      'feed.decision': [
        { ...decision, authorId: 'Иван' },
        { ...decision, version: 'v01.0.0' },
        { ...decision, revision: undefined },
      ],
      'feed.release': [
        { ...release, outcome: undefined },
        { ...release, outcome: 7 },
        { ...release, releaseId: 'r1' },
        { ...release, version: 'latest' },
      ],
      'feed.update': [
        { v: 1, outcome: 'conflict', conflicts: -1 },
        { v: 1, outcome: 'conflict' },
        { v: 1, outcome: 7, conflicts: 0 },
        { v: 1, outcome: undefined, conflicts: 0 },
      ],
      'feed.undo': [
        { ...undoConfirmed, authorId: 'Иван' },
        { ...undoInstalled, stage: undefined },
        { ...undoInstalled, stage: 7 },
        { ...undoInstalled, returnsTo: undefined },
        { ...undoInstalled, records: { returned: -1, kept: 0 } },
      ],
    }
    for (const type of feedEventTypes)
      for (const payload of broken[type])
        expect(readFeedRow(type, payload), JSON.stringify(payload)).toEqual({ type: 'unreadable' })
  })

  it('drops keys it does not know', () => {
    expect(readFeedRow('feed.step', { ...step, label: 'Думает', path: 'a.php' })).toEqual(
      shown('feed.step', step),
    )
  })

  describe('unknown enum values', () => {
    const read = (type: FeedEventType, payload: unknown): FeedEvent => readFeedRow(type, payload)

    it('failure.code → technical', () => {
      expect(FEED_FAILURE_FALLBACK).toBe('technical')
      expect(read('feed.failure', { ...failure, code: 'quota_moved' })).toEqual({
        ...shown('feed.failure', failure),
        code: 'technical',
      })
    })

    it('site → check', () => {
      expect(read('feed.failure', { ...failure, site: 'partly' })).toMatchObject({ site: 'check' })
      expect(read('feed.failure', { ...failure, site: 'changed' })).toMatchObject({ site: 'check' })
      expect(read('feed.cancelled', { ...cancelled, site: 'partly' })).toMatchObject({
        site: 'check',
      })
      expect(read('feed.result', { ...result, site: 'restored' })).toMatchObject({
        type: 'feed.result',
        site: 'check',
      })
    })

    it('credits → null: no phrase about credits', () => {
      expect(read('feed.failure', { ...failure, credits: 'partly' })).toMatchObject({
        type: 'feed.failure',
        credits: null,
      })
      expect(read('feed.cancelled', { ...cancelled, credits: 'partly' })).toMatchObject({
        type: 'feed.cancelled',
        credits: null,
      })
    })

    it('step → the row is skipped, the only one a reader may leave out', () => {
      expect(read('feed.step', { ...step, step: 'review' })).toEqual({ type: 'skipped' })
    })

    it('cancelled.by → a plate without a reason', () => {
      expect(read('feed.cancelled', { ...cancelled, by: 'operator' })).toEqual({
        ...shown('feed.cancelled', cancelled),
        by: null,
      })
    })

    it('request.kind → the text when there is one', () => {
      expect(read('feed.request', { ...first, kind: 'rewrite' })).toEqual({
        type: 'feed.request',
        kind: 'other',
        text: first.text,
        authorId: author,
      })
      expect(read('feed.request', { v: 1, kind: 'resume', authorId: author })).toEqual({
        type: 'feed.request',
        kind: 'other',
        authorId: author,
      })
      expect(read('feed.request', { v: 1, kind: 'resume', text: 7, authorId: 'x' })).toEqual({
        type: 'feed.request',
        kind: 'other',
      })
    })

    it('request.command → a press without a name', () => {
      expect(read('feed.request', { ...command, command: 'deploy' })).toEqual({
        ...shown('feed.request', command),
        command: null,
      })
    })

    it('candidate.bump → null, release.reason → null', () => {
      expect(read('feed.candidate', { ...candidate, bump: 'hotfix' })).toEqual({
        ...shown('feed.candidate', candidate),
        bump: null,
      })
      expect(read('feed.release', { ...release, outcome: 'failed', reason: 'moon_phase' })).toEqual(
        { ...shown('feed.release', release), outcome: 'failed', reason: null },
      )
    })

    it('release.outcome and decision.kind → «newer»: what became of the site cannot be guessed', () => {
      expect(read('feed.release', { ...release, outcome: 'partly' })).toEqual({ type: 'newer' })
      expect(read('feed.decision', { ...decision, kind: 'consent' })).toEqual({ type: 'newer' })
    })

    it('result.next → null: the screen is drawn by the task status', () => {
      expect(read('feed.result', { ...result, next: 'deploying' })).toMatchObject({
        type: 'feed.result',
        next: null,
        message: result.message,
      })
    })

    it('question.kind and question.reason → «newer»: a question cannot be left out', () => {
      expect(read('feed.question', { ...agentQuestion, kind: 'approval' })).toEqual({
        type: 'newer',
      })
      expect(read('feed.question', { ...ceiling, reason: 'daily' })).toEqual({ type: 'newer' })
    })

    it('changeType and risk → ignored', () => {
      expect(read('feed.result', { ...result, changeType: 'design', risk: 'extreme' })).toEqual({
        ...shown('feed.result', result),
        changeType: null,
        risk: null,
      })
    })
  })
})

describe('payload size', () => {
  it('counts UTF-8 bytes of the stored JSON', () => {
    expect(feedPayloadBytes({ a: 'я' })).toBe(10)
    expect(feedLimits.payloadBytes).toBe(32 * 1024)
  })

  it('keeps the largest payload the schemas allow under the limit', () => {
    // Three bytes per UTF-16 unit is the worst case of well-formed text. Half of a surrogate
    // pair, which JSON writes as a six-byte escape, is refused by the text rules.
    const wide = (length: number) => '€'.repeat(length)
    const largest = {
      v: 1,
      kind: 'agent',
      turn: 999_999,
      intro: wide(2000),
      questions: Array.from({ length: 5 }, () => ({
        text: wide(500),
        options: Array.from({ length: 6 }, () => wide(200)),
      })),
    }
    expect(feedPayloadBytes(largest)).toBeLessThanOrEqual(feedLimits.payloadBytes)
    expect(accepts('feed.question', largest)).toBe(true)
    expect(
      accepts('feed.request', { ...first, text: wide(4000), attachments: Array(10).fill(author) }),
    ).toBe(true)
    const escaped = (length: number) => '\uD800'.repeat(length)
    expect(
      accepts('feed.question', {
        ...largest,
        intro: escaped(2000),
        questions: largest.questions.map(() => ({
          text: escaped(500),
          options: Array.from({ length: 6 }, () => escaped(200)),
        })),
      }),
    ).toBe(false)
  })

  it('refuses a payload over the limit even when every field is within its own', () => {
    // No payload of valid fields reaches 32 KiB, so the check is met with a smaller limit.
    const payload = { ...result, message: 'я'.repeat(100) }
    const bytes = feedPayloadBytes(payload)
    expect(feedPayloadSchemas['feed.result'].safeParse(payload).success).toBe(true)
    const row = { type: 'feed.result', payload }
    expect(feedRowSchemaWithin(bytes).safeParse(row).success).toBe(true)
    const over = feedRowSchemaWithin(bytes - 1).safeParse(row)
    expect(over.success).toBe(false)
    expect(over.error?.issues.map((issue) => issue.message)).toEqual(['feed payload is too large'])
  })

  it('applies the limit to every type', () => {
    for (const type of feedEventTypes)
      for (const payload of samples[type]) {
        const row = { type, payload }
        expect(feedRowSchemaWithin(feedPayloadBytes(payload)).safeParse(row).success).toBe(true)
        expect(feedRowSchemaWithin(feedPayloadBytes(payload) - 1).safeParse(row).success).toBe(
          false,
        )
      }
  })
})

describe('ids and the cursor', () => {
  it('takes a bigint as a string of digits', () => {
    for (const id of ['1', '4812', '9223372036854775807'])
      expect(feedEventIdSchema.safeParse(id).success).toBe(true)
    for (const id of [
      '0',
      '01',
      '',
      '-1',
      '1e3',
      ' 1',
      '1'.repeat(20),
      // One past the largest bigint, and the largest string of nineteen digits.
      '9223372036854775808',
      '9999999999999999999',
    ])
      expect(feedEventIdSchema.safeParse(id).success).toBe(false)
    expect(feedEventIdSchema.safeParse('999999999999999999').success).toBe(true)
    expect(feedEventIdSchema.safeParse('1000000000000000000').success).toBe(true)
    expect(feedEventIdSchema.safeParse(1).success).toBe(false)
  })

  it('starts the cursor at zero', () => {
    for (const cursor of ['0', '1', '4812', '9223372036854775807'])
      expect(feedCursorSchema.safeParse(cursor).success).toBe(true)
    for (const cursor of [
      '',
      '00',
      '-1',
      'last',
      '1'.repeat(20),
      '9223372036854775808',
      '9999999999999999999',
    ])
      expect(feedCursorSchema.safeParse(cursor).success).toBe(false)
  })

  it('never throws on what is not a number', () => {
    for (const value of ['last', '1n', '0x10', ' ', '1'.repeat(400)]) {
      expect(() => feedCursorSchema.safeParse(value)).not.toThrow()
      expect(() => feedEventIdSchema.safeParse(value)).not.toThrow()
    }
  })
})

describe('task head', () => {
  const head = {
    id: author,
    title: 'Добавьте блок отзывов',
    mode: 'work',
    status: 'running',
    attempt: 1,
    turnNo: 1,
    waiting: null,
    held: false,
    canRetry: false,
    workingSince: '2026-10-11T09:00:00.000Z',
    runningSince: '2026-10-11T09:00:05.000Z',
  }

  it('accepts the head of the design and every status of spec §7', () => {
    expect(feedTaskHeadSchema.parse(head)).toEqual(head)
    for (const status of taskStatuses)
      expect(feedTaskHeadSchema.safeParse({ ...head, status }).success).toBe(true)
    expect(
      feedTaskHeadSchema.safeParse({
        ...head,
        title: null,
        status: 'queued',
        turnNo: 0,
        waiting: 'agents',
        workingSince: null,
        runningSince: null,
      }).success,
    ).toBe(true)
    expect(taskWaitingReasons).toEqual(['agents', 'site'])
    expect(taskModes).toEqual(['work', 'chat'])
  })

  it('takes the largest turn number and the longest title', () => {
    expect(feedTaskHeadSchema.safeParse({ ...head, turnNo: 999_999 }).success).toBe(true)
    expect(feedTaskHeadSchema.safeParse({ ...head, title: 'я'.repeat(120) }).success).toBe(true)
  })

  it('refuses unknown values and extra keys', () => {
    const refused = (patch: Record<string, unknown>) =>
      expect(feedTaskHeadSchema.safeParse({ ...head, ...patch }).success).toBe(false)
    refused({ status: 'paused' })
    refused({ waiting: 'credits' })
    refused({ mode: 'plan' })
    refused({ attempt: 0 })
    refused({ turnNo: -1 })
    refused({ turnNo: 1_000_000 })
    refused({ id: 'task-1' })
    refused({ title: 'я'.repeat(121) })
    refused({ runningSince: 'вчера' })
    refused({ workingSince: 'вчера' })
    refused({ held: 'yes' })
    refused({ canRetry: 'yes' })
    refused({ summary: 'Edited front-page.php' })
    refused({ failureReason: 'ENOENT' })
  })
})

describe('failure catalogue', () => {
  it('lists the twelve codes of the design', () => {
    expect(feedFailureCodes).toEqual([
      'technical',
      'timeout',
      'too_large',
      'task_limit',
      'credits_out',
      'forbidden_change',
      'secret_found',
      'site_files',
      'site_held',
      'content_refused',
      'unavailable',
      'not_accepted',
    ])
  })

  it('has a text and a retry flag for every code and for nothing else', () => {
    expect(Object.keys(feedFailureText).sort()).toEqual([...feedFailureCodes].sort())
    expect(Object.keys(feedFailureRetry).sort()).toEqual([...feedFailureCodes].sort())
  })

  it('allows a retry exactly where the design does', () => {
    expect(feedFailureCodes.filter((code) => !feedFailureRetry[code])).toEqual([
      'credits_out',
      'site_files',
      'site_held',
      'content_refused',
      'not_accepted',
    ])
  })

  it('speaks Russian, politely, without code names', () => {
    for (const code of feedFailureCodes) {
      const text = feedFailureText[code]
      expect(text).not.toMatch(/[A-Za-z_]/)
      expect(text).not.toMatch(/(^|[^\p{L}])(ты|тебя|тебе|твой|твоя|твои)([^\p{L}]|$)/iu)
      expect(text.endsWith('.')).toBe(true)
      for (const name of feedFailureCodes) expect(text).not.toContain(name)
    }
  })
})

describe('rows of a candidate and a release', () => {
  it('closes their enums', () => {
    expect(feedDecisionKinds).toEqual(['release'])
    expect(feedReleaseOutcomes).toEqual([
      'installed',
      'rolled_back',
      'failed',
      'unknown',
      'refused',
    ])
    expect(feedReleaseReasons).toEqual([
      'conflict',
      'outdated',
      'not_started',
      'site_check',
      'technical',
      'not_allowed',
      'checks_failed',
      'site_inactive',
      'client_variable',
      'site_broken_before',
      'plugin_outdated',
      'slug_taken',
      'values_unavailable',
      'created_id_in_code',
      'site_unreachable',
    ])
  })

  it('reads what a rollback left, and a release row without it', () => {
    const release = {
      v: 1,
      releaseId: '0199f0a0-0000-7000-8000-000000000001',
      version: 'v1.2.0',
      outcome: 'rolled_back',
      reason: 'site_check',
      credits: 'returned',
    }
    expect(accepts('feed.release', release)).toBe(true)
    expect(accepts('feed.release', { ...release, kept: { records: 1, tables: 2 } })).toBe(true)
    expect(accepts('feed.release', { ...release, kept: { records: -1, tables: 0 } })).toBe(false)
    expect(accepts('feed.release', { ...release, kept: { records: 1 } })).toBe(false)
  })

  it('takes a version only as vX.Y.Z without leading zeros', () => {
    for (const version of ['v0.0.1', 'v1.4.0', 'v999999999.0.0'])
      expect(accepts('feed.candidate', { ...candidate, version })).toBe(true)
    for (const version of ['1.4.0', 'v1.4', 'v01.4.0', 'v1.4.0-rc.1', 'V1.4.0', ''])
      expect(accepts('feed.candidate', { ...candidate, version })).toBe(false)
  })

  it('counts files, media and records, never names them', () => {
    expect(feedCandidatePayloadSchema.shape.files.shape).toHaveProperty('added')
    expect(accepts('feed.candidate', { ...candidate, paths: ['a.php'] })).toBe(false)
    expect(accepts('feed.candidate', { ...candidate, media: 1.5 })).toBe(false)
  })

  it('names the release by its id and says nothing raw about why it ended', () => {
    expect(accepts('feed.release', { ...release, reason: 'conflict in wp-config.php' })).toBe(false)
    expect(accepts('feed.release', { ...release, step: 'files' })).toBe(false)
    for (const outcome of feedReleaseOutcomes)
      expect(accepts('feed.release', { ...release, outcome })).toBe(true)
  })
})
