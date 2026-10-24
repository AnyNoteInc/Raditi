import { chatCommandIds } from '@repo/domain/release/chat-commands'
import type { TaskStatus } from '@repo/domain'

import type { CandidateView, CommandVerdict, DialogFeed, FeedHead, FeedRow } from './chat-types'

// Answers of `task.feed` for the component tests: a dialog of the kofeinya «Крошка» whose agent
// changes the price of a cappuccino.

export const TASK_ID = '0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17'
export const SITE_ID = '0199a3f2-0000-7000-8000-000000000001'
export const AUTHOR_ID = '0199a3f2-0000-7000-8000-0000000000a1'
export const REQUEST_ID = '0199a3f2-0000-7000-8000-0000000000b1'
export const CANDIDATE_ID = '0199a3f2-0000-7000-8000-0000000000c1'
export const RELEASE_ID = '0199a3f2-0000-7000-8000-0000000000d1'

/**
 * Every command available, or refused with the reasons given. «Отменить выпуск» and «Попробовать
 * ещё» are listed only when they are named (`{ undo: null }` — available): a dialog that installed
 * nothing, or has no failure to retry, does not list them (dialog-view.tsx).
 */
export function verdicts(
  refused: Partial<Record<CommandVerdict['id'], CommandVerdict['refusal']>> = {},
): CommandVerdict[] {
  return chatCommandIds
    .filter((id) => (id !== 'undo' && id !== 'retry') || id in refused)
    .map((id) => {
      const refusal = refused[id] ?? null
      return { id, available: refusal === null, refusal }
    })
}

export function taskHead(patch: Partial<FeedHead> = {}): FeedHead {
  return {
    id: TASK_ID,
    title: 'Поменять цену капучино',
    mode: 'work',
    status: 'queued',
    attempt: 1,
    turnNo: 0,
    waiting: null,
    held: false,
    canRetry: false,
    workingSince: '2026-10-17T09:00:00.000Z',
    runningSince: null,
    requirements: { repository: true, browser: false },
    ...patch,
  }
}

export function feedAnswer(
  patch: Partial<Omit<DialogFeed, 'task'>> & { status?: TaskStatus; task?: Partial<FeedHead> } = {},
): DialogFeed {
  const { status, task, ...rest } = patch
  return {
    task: taskHead({ ...(status ? { status } : {}), ...task }),
    browser: null,
    preview: null,
    candidate: null,
    release: null,
    undo: null,
    commands: verdicts(),
    events: [],
    cursor: '0',
    more: false,
    ...rest,
  }
}

let at = Date.parse('2026-10-17T09:00:00.000Z')
/** The time of the next row: a minute after the one before. */
const nextAt = () => new Date((at += 60_000)).toISOString()

export function requestRow(id: string, text = 'Поменяйте цену капучино на 290 ₽'): FeedRow {
  return {
    id,
    at: nextAt(),
    type: 'feed.request',
    kind: 'first',
    text,
    authorId: AUTHOR_ID,
    requestId: REQUEST_ID,
  }
}

export function stepRow(id: string, turn: number, step: 'work' | 'save' = 'work'): FeedRow {
  return { id, at: nextAt(), type: 'feed.step', turn, attempt: 1, step }
}

export function resultRow(
  id: string,
  turn: number,
  message = 'Поменял цену капучино на 290 ₽.',
): FeedRow {
  return {
    id,
    at: nextAt(),
    type: 'feed.result',
    turn,
    message,
    site: 'unchanged',
    next: 'awaiting_approval',
    filesChanged: null,
    changeType: 'content',
    needsApproval: true,
    risk: 'low',
  }
}

export function candidateRow(id: string, turn: number, revision = 1): FeedRow {
  return {
    id,
    at: nextAt(),
    type: 'feed.candidate',
    turn,
    revision,
    version: 'v1.4.0',
    bump: 'minor',
    files: { added: 1, modified: 2, deleted: 0 },
    media: 1,
    records: 3,
  }
}

export function agentQuestionRow(
  id: string,
  turn: number,
  questions = ['Какую цену поставить?'],
): FeedRow {
  return {
    id,
    at: nextAt(),
    type: 'feed.question',
    kind: 'agent',
    turn,
    intro: 'Уточните, пожалуйста.',
    questions: questions.map((text) => ({ text, options: [] })),
  }
}

export function ceilingRow(id: string, turn: number, reason: 'step' | 'credits' = 'step'): FeedRow {
  return {
    id,
    at: nextAt(),
    type: 'feed.question',
    kind: 'ceiling',
    turn,
    reason,
    spent: 18,
    held: 20,
    left: 2,
  }
}

export function commandRow(id: string, command: CommandVerdict['id']): FeedRow {
  return {
    id,
    at: nextAt(),
    type: 'feed.request',
    kind: 'command',
    command,
    authorId: AUTHOR_ID,
    requestId: REQUEST_ID,
  }
}

/** The candidate head of a dialog that waits with revision 1. */
export const candidateHead = {
  id: CANDIDATE_ID,
  revision: 1,
  status: 'current' as const,
  counts: { files: { added: 1, modified: 2, deleted: 0 }, media: 1, records: 3 },
  proposedVersion: 'v1.4.0',
  checks: { pending: 0, passed: 2, failed: 0, stale: 0 },
}

/**
 * A description of a database plan of every kind, as core keeps it with a revision (docs/plan/53,
 * «Операции БД и миграции»): a table, a setting, a new page and a text change.
 */
export const databaseView: NonNullable<CandidateView['databaseView']> = {
  v: 1,
  planSha256: 'a'.repeat(64),
  operations: [
    {
      kind: 'schema_migration',
      index: 0,
      objectRef: 'table:bookings',
      table: 'bookings',
      created: true,
      columns: [
        { name: 'name', type: 'string', length: 120, nullable: false, default: { value: '' } },
        { name: 'starts_at', type: 'datetime', nullable: true },
      ],
      indexes: [{ name: 'by_start', columns: ['starts_at'], unique: false }],
    },
    {
      kind: 'option_update',
      index: 1,
      objectRef: 'option:blogdescription',
      label: 'Описание сайта',
      before: 'Цветы у дома',
      after: 'Цветы у дома — доставка за час',
      truncated: false,
    },
    {
      kind: 'post_create',
      index: 2,
      objectRef: 'page:1000000001',
      record: { type: 'page' },
      title: 'Цены',
      slug: 'prices',
      status: 'draft',
      excerpt: '',
      contentText: 'Букет от 500 ₽',
      contentBytes: 40,
      links: ['/contacts/'],
      truncated: false,
    },
    {
      kind: 'content_update',
      index: 3,
      objectRef: 'page:42',
      record: { type: 'page', title: 'Контакты и реквизиты' },
      fields: ['title', 'excerpt', 'content'],
      title: {
        before: 'Контакты',
        after: 'Контакты и реквизиты',
        markupOnly: false,
        links: { added: [], removed: [] },
        truncated: false,
      },
      excerpt: {
        before: 'Как нас найти',
        after: 'Как нас найти',
        markupOnly: true,
        links: { added: ['https://map.example.ru/shop'], removed: [] },
        truncated: false,
      },
      content: {
        hunks: [
          { op: 'same', text: 'Пишите нам ' },
          { op: 'del', text: 'через форму' },
          { op: 'add', text: 'на почту' },
        ],
        replaced: null,
        markupOnly: false,
        links: { added: ['mailto:shop@example.ru'], removed: [] },
        truncated: true,
      },
    },
  ],
  truncated: true,
  oversize: false,
}

// A task in the browser (docs/plan/57-browser-tasks.md): the agent adds a news post on the site of
// the kofeinya through its admin pages, and the client signs in there when asked.

export const SESSION_ID = '0199a3f2-0000-7000-8000-0000000000e1'
export const ATTACHMENT_ID = '0199a3f2-0000-7000-8000-0000000000f1'

/** The head of a task in the browser with its open session, under the agent. */
export function browserAnswer(
  patch: Omit<NonNullable<Parameters<typeof feedAnswer>[0]>, 'browser'> & {
    browser?: Partial<FeedBrowserHead> | null
  } = {},
): DialogFeed {
  const { browser, task, ...rest } = patch
  return feedAnswer({
    status: 'running',
    commands: verdicts(
      Object.fromEntries(
        chatCommandIds
          .filter((id) => id !== 'cancel' && id !== 'undo' && id !== 'retry')
          .map((id) => [id, 'not_allowed' as const]),
      ),
    ),
    ...rest,
    task: {
      title: 'Новость о летней веранде',
      turnNo: 1,
      runningSince: '2026-10-17T09:01:00.000Z',
      requirements: { repository: false, browser: true },
      ...task,
    },
    browser:
      browser === null
        ? null
        : {
            sessionId: SESSION_ID,
            status: 'ready',
            controller: 'agent',
            help: null,
            closeReason: null,
            ...browser,
          },
  })
}

export type FeedBrowserHead = NonNullable<DialogFeed['browser']>

export function browserQuestionRow(
  id: string,
  turn: number,
  reason: 'login' | 'captcha' | 'confirm' | 'other' | 'control' | 'unconfirmed' = 'login',
  message?: string,
): FeedRow {
  return {
    id,
    at: nextAt(),
    type: 'feed.question',
    kind: 'browser',
    turn,
    reason,
    ...(message === undefined ? {} : { message }),
  }
}

export function resumeRow(id: string): FeedRow {
  return {
    id,
    at: nextAt(),
    type: 'feed.request',
    kind: 'resume',
    authorId: AUTHOR_ID,
    requestId: REQUEST_ID,
  }
}

/** The result of a task in the browser: one post the platform read on the site. */
export function browserResultRow(id: string, turn: number): FeedRow {
  return {
    id,
    at: nextAt(),
    type: 'feed.result',
    turn,
    message: 'Опубликовал новость о летней веранде.',
    site: 'changed',
    next: 'done',
    filesChanged: null,
    changeType: 'content',
    needsApproval: false,
    risk: 'low',
    objects: [
      {
        kind: 'post',
        title: 'Открыли летнюю веранду',
        status: 'published',
        url: 'https://kroshka.example/novosti/veranda/',
        editUrl: 'https://kroshka.example/wp-admin/post.php?post=128&action=edit',
      },
    ],
  }
}
