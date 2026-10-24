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
    name: 'request v1 retry of a failure',
    type: 'feed.request',
    payload: { v: 1, kind: 'retry', authorId: author, requestId: request, failureEventId: '4815' },
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
    name: 'failure v1 that kept the candidate',
    type: 'feed.failure',
    payload: {
      v: 1,
      turn: 3,
      code: 'technical',
      site: 'unchanged',
      credits: null,
      next: 'awaiting_approval',
    },
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
  // docs/plan/53-chat-preview-release.md: a dialog with a candidate and its release.
  {
    name: 'request v1 revision',
    type: 'feed.request',
    payload: {
      v: 1,
      kind: 'revision',
      text: 'Сделайте заголовок блока крупнее.',
      authorId: author,
      requestId: request,
      candidateRevision: 1,
    },
  },
  {
    name: 'request v1 command',
    type: 'feed.request',
    payload: { v: 1, kind: 'command', command: 'release', authorId: author, requestId: request },
  },
  {
    name: 'candidate v1',
    type: 'feed.candidate',
    payload: {
      v: 1,
      turn: 1,
      revision: 1,
      version: 'v1.3.0',
      bump: 'minor',
      files: { added: 2, modified: 1, deleted: 0 },
      media: 1,
      records: 3,
    },
  },
  {
    name: 'decision v1 release',
    type: 'feed.decision',
    payload: { v: 1, kind: 'release', authorId: author, revision: 1, version: 'v1.3.0' },
  },
  {
    name: 'release v1 installed',
    type: 'feed.release',
    payload: {
      v: 1,
      releaseId: '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d92',
      version: 'v1.3.0',
      outcome: 'installed',
      reason: null,
      credits: null,
    },
  },
  {
    name: 'release v1 rolled back',
    type: 'feed.release',
    payload: {
      v: 1,
      releaseId: '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d93',
      version: 'v1.3.1',
      outcome: 'rolled_back',
      reason: 'site_check',
      credits: 'returned',
    },
  },
  {
    name: 'update v1 conflict',
    type: 'feed.update',
    payload: { v: 1, outcome: 'conflict', conflicts: 2 },
  },
  {
    name: 'undo v1 confirmed',
    type: 'feed.undo',
    payload: {
      v: 1,
      stage: 'confirmed',
      undoId: '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d94',
      releaseId: '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d92',
      undoneVersion: 'v1.3.0',
      version: 'v1.3.2',
      authorId: author,
    },
  },
  {
    name: 'undo v1 installed',
    type: 'feed.undo',
    payload: {
      v: 1,
      stage: 'installed',
      undoId: '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d94',
      releaseId: '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d92',
      undoneVersion: 'v1.3.0',
      version: 'v1.3.2',
      returnsTo: 'v1.2.0',
      reason: null,
      records: { returned: 2, kept: 1 },
    },
  },
  // docs/plan/57-browser-tasks.md: a task done in the browser of the task.
  {
    name: 'request v1 resume',
    type: 'feed.request',
    payload: { v: 1, kind: 'resume', authorId: author, requestId: request },
  },
  {
    name: 'question v1 browser login',
    type: 'feed.question',
    payload: {
      v: 1,
      kind: 'browser',
      turn: 1,
      reason: 'login',
      message: 'Войдите, пожалуйста, в админку сайта — дальше я продолжу сам.',
    },
  },
  {
    name: 'question v1 browser unconfirmed',
    type: 'feed.question',
    payload: { v: 1, kind: 'browser', turn: 2, reason: 'unconfirmed' },
  },
  {
    name: 'result v1 with objects',
    type: 'feed.result',
    payload: {
      v: 1,
      turn: 2,
      message: 'Новость добавлена и опубликована.',
      site: 'changed',
      next: 'done',
      filesChanged: null,
      changeType: 'content',
      needsApproval: false,
      risk: 'low',
      objects: [
        {
          kind: 'post',
          title: 'Выставка 12 ноября',
          status: 'published',
          url: 'https://example.ru/2026/10/vystavka/',
          editUrl: 'https://example.ru/wp-admin/post.php?post=42&action=edit',
        },
      ],
    },
  },
  {
    name: 'cancelled v1 with objects',
    type: 'feed.cancelled',
    payload: {
      v: 1,
      turn: 1,
      by: 'customer',
      authorId: author,
      site: 'check',
      credits: 'returned',
      objects: [
        {
          kind: 'post',
          title: null,
          status: 'draft',
          editUrl: 'https://example.ru/wp-admin/post.php?post=43&action=edit',
        },
      ],
    },
  },
  {
    name: 'failure v1 with objects',
    type: 'feed.failure',
    payload: {
      v: 1,
      turn: 3,
      code: 'timeout',
      site: 'check',
      credits: 'returned',
      objects: [{ kind: 'page', title: 'Контакты', status: 'missing' }],
    },
  },
])
