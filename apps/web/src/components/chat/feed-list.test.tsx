// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { FeedRow } from './chat-types'
import { FeedList, LiveBlock, type FeedActions } from './feed-list'
import { feedReducer, initialFeedState, type FeedHeadState } from './feed-state'
import {
  agentQuestionRow,
  browserAnswer,
  browserQuestionRow,
  candidateHead,
  candidateRow,
  ceilingRow,
  commandRow,
  feedAnswer,
  RELEASE_ID,
  requestRow,
  resultRow,
  stepRow,
  verdicts,
} from './testing'

const NBSP = /\u00a0/g
const text = (element: HTMLElement) => (element.textContent ?? '').replace(NBSP, ' ')

function headOf(patch: Parameters<typeof feedAnswer>[0]): FeedHeadState {
  const head = feedReducer(initialFeedState, {
    type: 'answer',
    answer: feedAnswer(patch),
    after: '0',
  }).head
  if (head === null) throw new Error('no head')
  return head
}

/** The head of a task in the browser (docs/plan/57-browser-tasks.md). */
function browserHeadOf(patch: Parameters<typeof browserAnswer>[0] = {}): FeedHeadState {
  const head = feedReducer(initialFeedState, {
    type: 'answer',
    answer: browserAnswer(patch),
    after: '0',
  }).head
  if (head === null) throw new Error('no head')
  return head
}

function actions(patch: Partial<FeedActions> = {}): FeedActions {
  return {
    onContinue: vi.fn(),
    onRetry: vi.fn(),
    onStop: vi.fn(),
    onRelease: vi.fn(),
    onUpdate: vi.fn(),
    onUndo: vi.fn(),
    onShowChanges: vi.fn(),
    busy: false,
    ...patch,
  }
}

function showFeed(
  rows: FeedRow[],
  head: FeedHeadState,
  open: { question?: string; candidate?: string; retry?: string } = {},
  patch: Partial<FeedActions> = {},
) {
  const handlers = actions(patch)
  render(
    <FeedList
      head={head}
      rows={rows}
      siteUrl="https://kroshka.example"
      openQuestionId={open.question ?? null}
      liveCandidateId={open.candidate ?? null}
      retryId={open.retry ?? null}
      actions={handlers}
    />,
  )
  return { handlers, feed: screen.getByRole('list', { name: 'Сообщения диалога' }) }
}

describe('the rows of a dialog', () => {
  it('shows the client words as written: markup and addresses are only text', () => {
    const words = '<script>alert(1)</script> https://kroshka.example/?key=1'
    const { feed } = showFeed([requestRow('1', words)], headOf({ status: 'queued' }))
    expect(within(feed).getByText(words)).toBeTruthy()
    expect(feed.querySelector('script')).toBeNull()
    expect(feed.querySelector('a')).toBeNull()
  })

  it('folds the stages of a finished turn into the time the agent worked', () => {
    const rows: FeedRow[] = [
      requestRow('1'),
      { ...stepRow('2', 1), at: '2026-10-17T09:00:00.000Z' },
      { ...resultRow('3', 1), at: '2026-10-17T09:02:14.000Z' },
    ]
    const { feed } = showFeed(rows, headOf({ status: 'awaiting_approval', task: { turnNo: 1 } }))
    expect(text(within(feed).getByText(/Агент работал/))).toBe('Агент работал 2 мин 14 с')
  })

  it('opens «Ход работы» of a finished turn only when the client unfolds it', () => {
    const rows: FeedRow[] = [
      requestRow('1'),
      { ...stepRow('2', 1), at: '2026-10-17T09:00:00.000Z' },
      { ...resultRow('3', 1), at: '2026-10-17T09:02:14.000Z' },
    ]
    const activityOf = vi.fn((turn: number) => <p>Ход хода {turn}</p>)
    render(
      <FeedList
        head={headOf({ status: 'awaiting_approval', task: { turnNo: 1 } })}
        rows={rows}
        siteUrl="https://kroshka.example"
        openQuestionId={null}
        liveCandidateId={null}
        actions={actions()}
        activityOf={activityOf}
      />,
    )
    expect(activityOf).not.toHaveBeenCalled()
    const details = screen.getByText(/Агент работал/).closest('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))
    expect(activityOf).toHaveBeenCalledWith(1)
    expect(screen.getByRole('heading', { name: 'Ход работы' })).toBeTruthy()
    expect(screen.getByText('Ход хода 1')).toBeTruthy()
  })

  it('sets the agent answer on the page under a heading only a screen reader reads', () => {
    const { feed } = showFeed(
      [requestRow('1'), resultRow('3', 1)],
      headOf({ status: 'done', task: { turnNo: 1 } }),
    )
    const heading = within(feed).getByRole('heading', { name: 'Что изменится' })
    expect(heading.nextElementSibling?.textContent).toBe('Поменял цену капучино на 290 ₽.')
  })

  it('asks the agent question, with no standing words under it (owner, 26.10.2026)', () => {
    const question = agentQuestionRow('2', 1, ['Какую цену поставить?', 'На все размеры?'])
    const { feed } = showFeed([requestRow('1'), question], headOf({ status: 'awaiting_user' }), {
      question: question.id,
    })
    expect(within(feed).getByRole('heading', { name: 'Вопрос агента' })).toBeTruthy()
    expect(
      within(feed)
        .getAllByRole('listitem')
        .some((item) => item.textContent === 'На все размеры?'),
    ).toBe(true)
    expect(text(feed)).not.toContain('Агент продолжит, когда вы ответите.')
  })

  it('offers «Продолжить» and the way out on the open question about credits', () => {
    const question = ceilingRow('5', 2, 'step')
    const { feed, handlers } = showFeed([question], headOf({ status: 'awaiting_user' }), {
      question: question.id,
    })
    expect(text(feed)).toContain(
      'Задача оказалась больше обычной: на неё уже ушло 18 кредитов из 20 отложенных.',
    )
    fireEvent.click(within(feed).getByRole('button', { name: 'Продолжить' }))
    fireEvent.click(within(feed).getByRole('button', { name: 'Остановиться' }))
    expect(handlers.onContinue).toHaveBeenCalledTimes(1)
    expect(handlers.onStop).toHaveBeenCalledTimes(1)
  })

  it('draws an answered question without buttons', () => {
    const { feed } = showFeed([ceilingRow('5', 2, 'credits')], headOf({ status: 'queued' }))
    expect(within(feed).queryAllByRole('button')).toEqual([])
  })

  it('shows the result that waits for a decision with the line about the site', () => {
    const { feed } = showFeed([resultRow('3', 1)], headOf({ status: 'awaiting_approval' }))
    expect(within(feed).getByRole('heading', { name: 'Что изменится' })).toBeTruthy()
    expect(text(feed)).toContain('Поменял цену капучино на 290 ₽.')
    expect(text(feed)).toContain('На сайте пока ничего не изменилось.')
  })

  it('shows the answer of a pass that changed nothing as the agent’s, the dialog open', () => {
    // The owner, 26.10.2026: «после того как в работе произошла какая-то работа, не закрывай чат».
    const open: FeedRow = {
      id: '3',
      at: '2026-10-17T09:02:14.000Z',
      type: 'feed.result',
      turn: 1,
      message: 'Это сайт учебного комбината на WordPress.',
      site: 'unchanged',
      next: 'awaiting_user',
      filesChanged: 0,
      changeType: 'none',
      needsApproval: false,
      risk: 'low',
    }
    const { feed } = showFeed([open], headOf({ status: 'awaiting_user' }))
    expect(within(feed).getByRole('heading', { name: 'Ответ агента' })).toBeTruthy()
    expect(within(feed).queryByRole('heading', { name: 'Готово' })).toBeNull()
    expect(text(feed)).toContain('Это сайт учебного комбината на WordPress.')
    expect(text(feed)).not.toContain('Если нужно что-то ещё')
    expect(text(feed)).not.toContain('Изменено файлов')
  })

  it('explains a failure and a cancellation by their codes', () => {
    const rows: FeedRow[] = [
      {
        id: '4',
        at: '2026-10-17T09:05:00.000Z',
        type: 'feed.failure',
        turn: 1,
        code: 'timeout',
        site: 'unchanged',
        credits: 'returned',
      },
      {
        id: '5',
        at: '2026-10-17T09:06:00.000Z',
        type: 'feed.cancelled',
        turn: null,
        by: 'customer',
        site: 'unchanged',
        credits: null,
      },
    ]
    const { feed } = showFeed(rows, headOf({ status: 'cancelled' }))
    expect(text(feed)).toContain(
      'Агент не уложился в 20 минут. Попробуйте разбить задачу на несколько небольших. На сайте ничего не изменилось. За этот запрос кредиты не списаны.',
    )
    expect(text(feed)).toContain('Вы остановили задачу. На сайте ничего не изменилось.')
  })

  // docs/plan/53, «Попробовать ещё (18.10)».
  it('says the changes were kept and offers «Попробовать ещё» on the failure the server names', () => {
    const failure = (id: string): FeedRow => ({
      id,
      at: '2026-10-17T09:05:00.000Z',
      type: 'feed.failure',
      turn: 2,
      code: 'technical',
      site: 'unchanged',
      credits: null,
      next: 'awaiting_approval',
    })
    const head = headOf({ status: 'awaiting_approval', candidate: candidateHead })
    const rows = [candidateRow('6', 1), failure('7')]
    const { feed, handlers } = showFeed(rows, head, { candidate: '6', retry: '7' })
    expect(text(feed)).toContain(
      'Не получилось выполнить задачу из-за технического сбоя. На сайте ничего не изменилось. Изменения, готовые до этого, мы сохранили.',
    )
    expect(text(feed)).toContain('Повторная попытка может стоить больше кредитов.')
    fireEvent.click(within(feed).getByRole('button', { name: 'Попробовать ещё' }))
    expect(handlers.onRetry).toHaveBeenCalledWith('7')
  })

  it('offers no retry on a failure the server does not name, and none of a closed dialog', () => {
    const rows: FeedRow[] = [
      {
        id: '4',
        at: '2026-10-17T09:05:00.000Z',
        type: 'feed.failure',
        turn: 1,
        code: 'technical',
        site: 'unchanged',
        credits: 'returned',
        next: 'failed',
      },
    ]
    const { feed } = showFeed(rows, headOf({ status: 'failed' }))
    expect(within(feed).queryByRole('button', { name: 'Попробовать ещё' })).toBeNull()
    expect(text(feed)).not.toContain('мы сохранили')
    expect(text(feed)).not.toContain('Повторная попытка')
  })

  it('tells the client a failed dialog stays open: «продолжи» goes on (28.10.2026)', () => {
    const rows: FeedRow[] = [
      {
        id: '5',
        at: '2026-10-28T19:26:27.000Z',
        type: 'feed.failure',
        turn: 1,
        code: 'technical',
        site: 'check',
        credits: 'returned',
        next: 'awaiting_user',
      },
    ]
    const { feed } = showFeed(rows, headOf({ status: 'awaiting_user' }))
    expect(text(feed)).toContain(
      'Диалог не закрыт: напишите «продолжи», и агент продолжит с того места, где остановился.',
    )
    expect(text(feed)).not.toContain('мы сохранили')
  })

  it('offers the release on the live candidate, with its counts and the proposed number', () => {
    const row = candidateRow('6', 1)
    const head = headOf({ status: 'awaiting_approval', candidate: candidateHead })
    const { feed, handlers } = showFeed([row], head, { candidate: row.id })
    expect(within(feed).getByRole('heading', { name: 'Изменения готовы' })).toBeTruthy()
    expect(text(feed)).toContain('Предлагаем выпустить как версию 1.4.0 (новые возможности).')
    expect(text(feed)).toContain('Изменено файлов: 3')
    expect(text(feed)).toContain('Добавится медиафайлов: 1')
    expect(text(feed)).toContain('Изменится записей на сайте: 3')
    fireEvent.click(within(feed).getByRole('button', { name: 'Выпустить новую версию' }))
    fireEvent.click(within(feed).getByRole('button', { name: 'Посмотреть изменения' }))
    expect(handlers.onRelease).toHaveBeenCalledTimes(1)
    expect(handlers.onShowChanges).toHaveBeenCalledTimes(1)
  })

  it('says why the release is closed and offers the update when the site moved on', () => {
    const row = candidateRow('6', 1)
    const head = headOf({
      status: 'awaiting_approval',
      candidate: { ...candidateHead, status: 'stale' },
      commands: verdicts({ release: 'needs_update' }),
    })
    const { feed, handlers } = showFeed([row], head, { candidate: row.id })
    expect(within(feed).queryByRole('button', { name: 'Выпустить новую версию' })).toBeNull()
    expect(text(feed)).toContain(
      'Сайт изменился после начала диалога. Сначала обновите рабочую копию.',
    )
    fireEvent.click(within(feed).getByRole('button', { name: 'Обновить рабочую копию' }))
    expect(handlers.onUpdate).toHaveBeenCalledTimes(1)
  })

  it('shows an old candidate without its buttons', () => {
    const { feed } = showFeed([candidateRow('6', 1)], headOf({ status: 'done' }))
    expect(within(feed).queryAllByRole('button')).toEqual([])
  })

  it('shows the presses, the decision and the outcome of a release in the client words', () => {
    const rows: FeedRow[] = [
      commandRow('7', 'reset'),
      {
        id: '8',
        at: '2026-10-17T09:10:00.000Z',
        type: 'feed.decision',
        kind: 'release',
        authorId: '0199a3f2-0000-7000-8000-0000000000a1',
        revision: 1,
        version: 'v1.4.0',
      },
      {
        id: '9',
        at: '2026-10-17T09:20:00.000Z',
        type: 'feed.release',
        releaseId: RELEASE_ID,
        version: 'v1.4.0',
        outcome: 'rolled_back',
        reason: 'site_check',
        credits: 'returned',
      },
      {
        id: '10',
        at: '2026-10-17T09:30:00.000Z',
        type: 'feed.release',
        releaseId: RELEASE_ID,
        version: 'v1.4.1',
        outcome: 'installed',
        reason: null,
        credits: null,
      },
    ]
    const { feed } = showFeed(rows, headOf({ status: 'done' }))
    expect(text(feed)).toContain('Вы сбросили данные предпросмотра')
    expect(text(feed)).toContain('Вы решили выпустить версию 1.4.0.')
    expect(within(feed).getByRole('heading', { name: 'Вернули как было' })).toBeTruthy()
    expect(text(feed)).toContain(
      'Версию 1.4.0 установить не удалось, и мы вернули сайт к прежнему состоянию. После установки сайт не прошёл проверку. За этот запрос кредиты не списаны.',
    )
    expect(within(feed).getByRole('heading', { name: 'Версия установлена' })).toBeTruthy()
    expect(text(feed)).toContain('Версия 1.4.1 установлена на сайт.')
  })

  it('tells what came of an «Обновить» that left no new revision', () => {
    const rows: FeedRow[] = [
      commandRow('13', 'update'),
      {
        id: '14',
        at: '2026-10-17T09:50:00.000Z',
        type: 'feed.update',
        outcome: 'conflict',
        conflicts: 2,
      },
      commandRow('15', 'update'),
      {
        id: '16',
        at: '2026-10-17T09:55:00.000Z',
        type: 'feed.update',
        outcome: 'withdrawn',
        conflicts: 0,
      },
    ]
    const { feed } = showFeed(rows, headOf({ status: 'awaiting_approval' }))
    expect(text(feed)).toContain('Вы попросили обновить рабочую копию')
    expect(
      within(feed).getAllByRole('heading', { name: 'Рабочую копию не обновили' }),
    ).toHaveLength(2)
    expect(text(feed)).toContain(
      'На сайте за это время изменились те же места, что и в этом диалоге (файлов: 2), поэтому изменения не переносятся на новую версию сайта сами. Отмените этот диалог и опишите задачу в новом — агент сделает её на новой версии сайта.',
    )
    expect(text(feed)).toContain('Вы написали в диалог, пока мы обновляли рабочую копию')
  })

  it('tells a row newer than the page and a row that cannot be shown', () => {
    const rows: FeedRow[] = [
      { id: '11', at: '2026-10-17T09:40:00.000Z', type: 'newer' },
      { id: '12', at: '2026-10-17T09:41:00.000Z', type: 'unreadable' },
    ]
    const { feed } = showFeed(rows, headOf({ status: 'done' }))
    expect(text(feed)).toContain(
      'Здесь появилось новое сообщение. Обновите страницу, чтобы его увидеть.',
    )
    expect(text(feed)).toContain('Не удалось показать это сообщение. Напишите нам, если оно важно.')
  })

  it('marks the top of every row: the dialog keeps its place by them (docs/plan/59, И19)', () => {
    const rows = [requestRow('1'), stepRow('2', 1), resultRow('3', 1)]
    const { feed } = showFeed(rows, headOf({ status: 'awaiting_approval', task: { turnNo: 1 } }))
    const tops = [...feed.children]
    expect(tops.length).toBeGreaterThan(0)
    expect(tops.every((row) => row.tagName === 'LI' && row.hasAttribute('data-feed-row'))).toBe(
      true,
    )
    // Only the rows themselves: a list inside a row is not one.
    expect(feed.querySelectorAll('[data-feed-row]')).toHaveLength(tops.length)
  })
})

// docs/plan/59-dialog-tools-panel.md, И12: the browser is beside the dialog only when the client
// asks for it, so the feed offers the way to it wherever it asks something of the client.
describe('the browser of a task in the feed', () => {
  const help = { reason: 'login' as const, message: null }

  it.each(['login', 'captcha', 'confirm', 'other'] as const)(
    'offers «Открыть браузер» beside «Взять управление» on an open request (%s)',
    (reason) => {
      const question = browserQuestionRow('2', 1, reason)
      const { feed, handlers } = showFeed(
        [requestRow('1'), question],
        browserHeadOf({ status: 'awaiting_user', browser: { help: { reason, message: null } } }),
        { question: question.id },
        { onOpenBrowser: vi.fn(), onTakeControl: vi.fn(), browserLive: true },
      )
      expect(
        within(feed)
          .getAllByRole('button')
          .map((button) => text(button)),
      ).toEqual(['Взять управление', 'Открыть браузер'])
      fireEvent.click(within(feed).getByRole('button', { name: 'Открыть браузер' }))
      expect(handlers.onOpenBrowser).toHaveBeenCalledTimes(1)
      expect(handlers.onTakeControl).not.toHaveBeenCalled()
    },
  )

  it('offers it beside «Продолжить работу агента» while the client drives', () => {
    const question = browserQuestionRow('2', 1, 'control')
    const { feed, handlers } = showFeed(
      [requestRow('1'), question],
      browserHeadOf({ status: 'awaiting_user', browser: { controller: 'user' } }),
      { question: question.id },
      {
        onOpenBrowser: vi.fn(),
        onTakeControl: vi.fn(),
        onResumeAgent: vi.fn(),
        controlling: true,
        browserLive: true,
      },
    )
    expect(
      within(feed)
        .getAllByRole('button')
        .map((button) => text(button)),
    ).toEqual(['Продолжить работу агента', 'Открыть браузер'])
    fireEvent.click(within(feed).getByRole('button', { name: 'Открыть браузер' }))
    expect(handlers.onOpenBrowser).toHaveBeenCalledTimes(1)
    expect(handlers.onResumeAgent).not.toHaveBeenCalled()
  })

  it('offers it for a session that closed too: the browser shows what became of it', () => {
    const question = browserQuestionRow('2', 1, 'login')
    const { feed } = showFeed(
      [requestRow('1'), question],
      browserHeadOf({ status: 'awaiting_user', browser: { status: 'closed', help } }),
      { question: question.id },
      { onOpenBrowser: vi.fn(), onTakeControl: vi.fn(), browserLive: false },
    )
    expect(
      within(feed)
        .getAllByRole('button')
        .map((button) => text(button)),
    ).toEqual(['Открыть браузер'])
  })

  it('offers it on no answered request, and on no warning of an unconfirmed save', () => {
    const answered = browserQuestionRow('2', 1, 'login')
    const unconfirmed = browserQuestionRow('3', 1, 'unconfirmed')
    const { feed } = showFeed(
      [requestRow('1'), answered, unconfirmed],
      browserHeadOf({ status: 'awaiting_user', browser: { help } }),
      { question: unconfirmed.id },
      { onOpenBrowser: vi.fn(), onTakeControl: vi.fn(), browserLive: true },
    )
    expect(within(feed).queryByRole('button', { name: 'Открыть браузер' })).toBeNull()
  })

  it('offers «Открыть браузер» beside «Продолжить работу агента» on the plate of the live block', () => {
    const onOpen = vi.fn()
    const onResume = vi.fn()
    render(
      <LiveBlock
        head={browserHeadOf({ browser: { controller: 'user' } })}
        steps={[]}
        browser={{ controlling: true, onResume, onWatch: vi.fn(), onOpen, busy: false }}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Управляете вы' })).toBeTruthy()
    // The plate names no place: the browser is beside the dialog only while it is open.
    expect(text(document.body)).toContain(
      'Управляете вы. Агент ждёт. Когда закончите, нажмите «Продолжить работу агента».',
    )
    expect(text(document.body)).not.toContain('справа')
    fireEvent.click(screen.getByRole('button', { name: 'Открыть браузер' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить работу агента' }))
    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it('offers «Смотреть, что делает агент» while the agent drives, on any width', () => {
    const onWatch = vi.fn()
    render(
      <LiveBlock
        head={browserHeadOf()}
        steps={[]}
        browser={{ controlling: false, onResume: vi.fn(), onWatch, onOpen: vi.fn(), busy: false }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Смотреть, что делает агент' }))
    expect(onWatch).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Открыть браузер' })).toBeNull()
  })
})

describe('the live block', () => {
  it('says why the dialog waits in the queue', () => {
    render(<LiveBlock head={headOf({ status: 'queued', task: { waiting: 'site' } })} steps={[]} />)
    expect(screen.getByRole('heading', { name: 'Приняли, начинаем' })).toBeTruthy()
    expect(text(document.body)).toContain(
      'На сайте сейчас идёт другая работа. Начнём, когда она закончится.',
    )
  })

  it('lists the stages of the turn at work', () => {
    const head = headOf({
      status: 'running',
      task: { turnNo: 1, runningSince: new Date().toISOString() },
    })
    render(
      <LiveBlock
        head={head}
        steps={[stepRow('2', 1) as never, stepRow('3', 1, 'save') as never]}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Агент работает' })).toBeTruthy()
    expect(screen.getByText('Работа над задачей')).toBeTruthy()
    expect(screen.getByText('Сохранение работы')).toBeTruthy()
  })

  it('shows «Ход работы» of the turn at work open under its stages', () => {
    const head = headOf({
      status: 'running',
      task: { turnNo: 2, runningSince: new Date().toISOString() },
    })
    render(
      <LiveBlock head={head} steps={[stepRow('2', 2) as never]} activity={<p>Команды агента</p>} />,
    )
    const details = screen.getByText('Ход работы').closest('details')!
    expect(details.open).toBe(true)
    expect(within(details).getByText('Команды агента')).toBeTruthy()
  })

  it('shows no «Ход работы» while the client drives the browser or the site is held', () => {
    render(
      <LiveBlock
        head={headOf({ status: 'running', task: { held: true } })}
        steps={[stepRow('2', 1) as never]}
        activity={<p>Команды агента</p>}
      />,
    )
    expect(screen.queryByText('Команды агента')).toBeNull()
  })

  it('shows the site held instead of the stages', () => {
    render(
      <LiveBlock
        head={headOf({ status: 'running', task: { held: true } })}
        steps={[stepRow('2', 1) as never]}
      />,
    )
    expect(text(document.body)).toContain('При работе с сайтом произошёл сбой, мы его разбираем.')
    expect(screen.queryByText('Работа над задачей')).toBeNull()
  })

  it('names the step of a release in work', () => {
    const head = headOf({
      status: 'deploying',
      release: {
        id: RELEASE_ID,
        status: 'deploying',
        step: 'backup',
        version: 'v1.4.0',
        outcome: null,
      },
    })
    render(<LiveBlock head={head} steps={[]} />)
    expect(screen.getByRole('heading', { name: 'Выкладываем' })).toBeTruthy()
    expect(text(document.body)).toContain('Устанавливаем на сайт. Делаем резервную копию')
  })

  it('is not drawn while the dialog waits for the client', () => {
    const { container } = render(
      <LiveBlock head={headOf({ status: 'awaiting_user' })} steps={[]} />,
    )
    expect(container.textContent).toBe('')
  })
})

describe('«Отменить выпуск»', () => {
  const UNDO_ID = '0199a3f2-0000-7000-8000-0000000000e1'
  const installedRow: FeedRow = {
    id: '9',
    at: '2026-10-18T10:00:00.000Z',
    type: 'feed.release',
    releaseId: RELEASE_ID,
    version: 'v1.4.0',
    outcome: 'installed',
    reason: null,
    credits: null,
  }
  const undoHead = {
    releaseId: RELEASE_ID,
    version: 'v1.4.0',
    installedNow: true,
    until: new Date('2026-10-25T11:30:00.000Z'),
    run: null,
  }

  it('offers the undo under the installed version while the server allows it, with its deadline', () => {
    const { handlers, feed } = showFeed(
      [installedRow],
      headOf({ status: 'done', undo: undoHead, commands: verdicts({ undo: null }) }),
    )
    fireEvent.click(within(feed).getByRole('button', { name: 'Отменить выпуск' }))
    expect(handlers.onUndo).toHaveBeenCalledTimes(1)
    expect(text(feed)).toContain('Можно отменить до 25 октября, 14:30.')
  })

  it('offers nothing past the seven days, on another version, or once the site runs another one', () => {
    for (const head of [
      headOf({ status: 'done', undo: undoHead, commands: verdicts({ undo: 'undo_expired' }) }),
      headOf({
        status: 'done',
        undo: { ...undoHead, releaseId: UNDO_ID },
        commands: verdicts({ undo: null }),
      }),
      headOf({
        status: 'done',
        undo: { ...undoHead, installedNow: false, until: null },
        commands: verdicts(),
      }),
    ]) {
      const { feed } = showFeed([installedRow], head)
      expect(within(feed).queryByRole('button', { name: 'Отменить выпуск' })).toBeNull()
      document.body.innerHTML = ''
    }
  })

  it('shows the press and the outcome of an undo in the client words', () => {
    const names = {
      undoId: UNDO_ID,
      releaseId: RELEASE_ID,
      undoneVersion: 'v1.4.0',
      version: 'v1.4.1',
    }
    const rows: FeedRow[] = [
      {
        id: '10',
        at: '2026-10-18T10:01:00.000Z',
        type: 'feed.undo',
        stage: 'confirmed',
        ...names,
        authorId: RELEASE_ID,
      },
      {
        id: '11',
        at: '2026-10-18T10:05:00.000Z',
        type: 'feed.undo',
        stage: 'installed',
        ...names,
        returnsTo: 'v1.3.0',
        reason: null,
        records: { returned: 2, kept: 1 },
      },
      {
        id: '12',
        at: '2026-10-18T10:09:00.000Z',
        type: 'feed.undo',
        stage: 'rolled_back',
        ...names,
        returnsTo: 'v1.3.0',
        reason: 'site_check',
        records: { returned: 2, kept: 0 },
      },
    ]
    const { feed } = showFeed(rows, headOf({ status: 'done' }))
    const shown = text(feed)
    expect(shown).toContain('Вы решили отменить выпуск 1.4.0.')
    expect(shown).toContain('Выпуск отменён')
    expect(shown).toContain('Сайт вернулся к версии 1.3.0; теперь на нём версия 1.4.1.')
    expect(shown).toContain('Не вернули записей: 1')
    expect(shown).toContain('Выпуск не отменили')
    expect(shown).toContain('Вернуть версию 1.3.0 не удалось, и сайт остался на версии 1.4.0.')
    expect(shown).toContain('После возврата сайт не прошёл проверку.')
  })

  it('says the undo at work in the live block of a closed dialog', () => {
    render(
      <LiveBlock
        head={headOf({
          status: 'done',
          undo: {
            ...undoHead,
            run: {
              id: UNDO_ID,
              status: 'deploying',
              step: 'files',
              version: 'v1.4.1',
              outcome: null,
            },
          },
        })}
        steps={[]}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Отменяем выпуск 1.4.0' })).toBeTruthy()
    expect(text(document.body)).toContain('Устанавливаем на сайт. Устанавливаем файлы.')
  })
})
