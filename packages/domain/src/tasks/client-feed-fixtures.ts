import type { FeedEventType } from './client-feed.ts'

/**
 * Frozen samples of stored feed rows, one or more per type and version. Rows are immutable and
 * live as long as their task, so every sample must stay readable: samples are only added,
 * never edited or removed.
 */
export interface FeedFixture {
  name: string
  type: FeedEventType
  payload: Readonly<Record<string, unknown>>
}

const author = '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d8e'
const request = '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d8f'

export const feedFixtures: readonly FeedFixture[] = Object.freeze([
  {
    name: 'request v1 first',
    type: 'feed.request',
    payload: {
      v: 1,
      kind: 'first',
      text: 'Поменяйте телефон в шапке на +7 (495) 123-45-67.\nИ добавьте блок «Отзывы».',
      authorId: author,
      requestId: request,
    },
  },
  {
    name: 'request v1 answer',
    type: 'feed.request',
    payload: {
      v: 1,
      kind: 'answer',
      text: 'Да, на главной.',
      authorId: author,
      requestId: request,
      answersEventId: '4812',
    },
  },
  {
    name: 'request v1 retry',
    type: 'feed.request',
    payload: { v: 1, kind: 'retry', authorId: author, requestId: request },
  },
  {
    name: 'request v1 first with attachments',
    type: 'feed.request',
    payload: {
      v: 1,
      kind: 'first',
      text: 'Поставьте это фото на главную.',
      authorId: author,
      requestId: request,
      attachments: ['018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d90', '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d91'],
    },
  },
  {
    name: 'step v1 work',
    type: 'feed.step',
    payload: { v: 1, turn: 1, attempt: 1, step: 'work' },
  },
  {
    name: 'step v1 save',
    type: 'feed.step',
    payload: { v: 1, turn: 1, attempt: 1, step: 'save' },
  },
  {
    name: 'question v1 agent',
    type: 'feed.question',
    payload: {
      v: 1,
      kind: 'agent',
      turn: 1,
      intro: 'Чтобы продолжить, мне нужно уточнить две вещи.',
      questions: [
        { text: 'На какой странице показать блок?', options: [] },
        { text: 'Какой заголовок у блока?', options: ['Отзывы', 'Нам доверяют'] },
      ],
    },
  },
  {
    name: 'question v1 ceiling',
    type: 'feed.question',
    payload: { v: 1, kind: 'ceiling', turn: 3, reason: 'step', spent: 12, held: 15, left: 3 },
  },
  {
    name: 'result v1 done',
    type: 'feed.result',
    payload: {
      v: 1,
      turn: 2,
      message: 'Телефон в шапке заменён. Проверьте, пожалуйста, как он выглядит.',
      site: 'changed',
      next: 'done',
      filesChanged: null,
      changeType: 'content',
      needsApproval: false,
      risk: 'low',
    },
  },
  {
    name: 'result v1 awaiting approval',
    type: 'feed.result',
    payload: {
      v: 1,
      turn: 2,
      message: 'На главной появится блок «Отзывы» с тремя карточками.',
      site: 'unchanged',
      next: 'awaiting_approval',
      filesChanged: 3,
      changeType: 'code',
      needsApproval: true,
      risk: 'medium',
    },
  },
  {
    name: 'failure v1 before a turn',
    type: 'feed.failure',
    payload: { v: 1, turn: null, code: 'unavailable', site: 'unchanged', credits: null },
  },
  {
    name: 'failure v1 with restored content',
    type: 'feed.failure',
    payload: { v: 1, turn: 4, code: 'timeout', site: 'restored', credits: 'returned' },
  },
  {
    name: 'cancelled v1 not available',
    type: 'feed.cancelled',
    payload: { v: 1, turn: 2, by: 'not_available', site: 'unchanged', credits: 'returned' },
  },
  {
    name: 'cancelled v1 queue timeout',
    type: 'feed.cancelled',
    payload: { v: 1, turn: null, by: 'queue_timeout', site: 'unchanged', credits: 'expired' },
  },
  {
    name: 'cancelled v1 by a person',
    type: 'feed.cancelled',
    payload: {
      v: 1,
      turn: 1,
      by: 'customer',
      authorId: author,
      site: 'check',
      credits: null,
    },
  },
])
