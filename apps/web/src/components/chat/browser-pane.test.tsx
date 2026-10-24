// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { BrowserPane, type BrowserPaneProps } from './browser-pane'
import type { BrowserState } from './browser-stream'
import type { FeedHeadState } from './feed-state'
import { browserAnswer, SESSION_ID, SITE_ID, TASK_ID } from './testing'
import type { BrowserStream } from './use-browser-stream'

const VIEWER = '0199a3f2-0000-7000-8000-0000000000aa'

const calls = vi.hoisted(() => ({
  list: vi.fn(async () => [] as unknown[]),
  bind: vi.fn(async () => ({ bound: 1 })),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    attachment: {
      list: {
        queryOptions: (input: unknown) => ({
          queryKey: ['attachment.list', input],
          queryFn: () => calls.list(),
        }),
      },
      bind: { mutationOptions: () => ({ mutationFn: calls.bind }) },
    },
  }),
  useTRPCClient: () => ({
    attachment: { start: { mutate: vi.fn() }, remove: { mutate: vi.fn() } },
  }),
}))

beforeAll(() => {
  // jsdom draws nothing: the painter gets no context and the picture stays empty.
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext
})

const state = (patch: Partial<BrowserState> = {}): BrowserState => ({
  session: SESSION_ID,
  status: 'ready',
  controller: 'agent',
  controlEpoch: 3,
  manualReady: false,
  holder: null,
  pageId: 7,
  viewportVersion: 2,
  viewport: { width: 1280, height: 800 },
  url: 'https://kroshka.example/wp-admin/post.php?post=128&action=edit',
  title: 'Новая запись',
  tabs: [
    { pageId: 7, url: 'https://kroshka.example/wp-admin/post.php?post=128', title: 'Новая запись' },
  ],
  ...patch,
})

function fakeStream(patch: Partial<BrowserStream> = {}): BrowserStream {
  return {
    connection: 'open',
    endReason: null,
    state: state(),
    viewer: VIEWER,
    holding: false,
    refusal: null,
    send: vi.fn(() => true),
    take: vi.fn(),
    release: vi.fn(),
    retry: vi.fn(),
    setPainter: vi.fn(),
    ...patch,
  }
}

/** This tab drives the browser and may type. */
const holding = (patch: Partial<BrowserState> = {}) =>
  fakeStream({
    holding: true,
    state: state({ controller: 'user', holder: VIEWER, manualReady: true, ...patch }),
  })

function head(patch: Parameters<typeof browserAnswer>[0] = {}): FeedHeadState {
  const { events: _events, cursor: _cursor, more: _more, ...rest } = browserAnswer(patch)
  return rest
}

function show(props: Partial<BrowserPaneProps> = {}) {
  const handlers = {
    onTake: vi.fn(),
    onResume: vi.fn(),
    onStop: vi.fn(),
    onFullscreen: vi.fn(),
  }
  const stream = props.stream ?? fakeStream()
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <BrowserPane
        taskId={TASK_ID}
        siteId={SITE_ID}
        head={head()}
        stream={stream}
        configured
        visible
        fullscreen={false}
        canStop
        busy={false}
        {...handlers}
        {...props}
      />
    </QueryClientProvider>,
  )
  return { ...handlers, stream }
}

/**
 * The display an element gets below `sm`. jsdom applies no media query, and MUI writes the `xs`
 * value of `sx` as `@media (min-width:0px)`: it is read from the rules themselves.
 */
function phoneDisplay(element: Element): string | null {
  let display: string | null = null
  for (const sheet of Array.from(document.styleSheets))
    for (const rule of Array.from(sheet.cssRules))
      if (rule instanceof CSSMediaRule && rule.media.mediaText === '(min-width:0px)')
        for (const inner of Array.from(rule.cssRules))
          if (
            inner instanceof CSSStyleRule &&
            element.matches(inner.selectorText) &&
            inner.style.display !== ''
          )
            display = inner.style.display
  return display
}

const toolbar = () => screen.getByRole('toolbar', { name: 'Управление браузером' })
const sent = (stream: BrowserStream) =>
  vi.mocked(stream.send).mock.calls.map(([message]) => message)
const keyboard = () => screen.getByLabelText<HTMLTextAreaElement>('Ввод на страницу')
const canvas = () => screen.getByRole('img', { name: 'Страница сайта в браузере задачи' })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the browser of a task', () => {
  it('under the agent: the state, the address and the two buttons, nothing to type into', () => {
    const { onTake, onStop } = show()
    const bar = within(toolbar())
    expect(bar.getByRole('status').textContent).toBe('Работает агент')
    expect(bar.getByLabelText('Адрес страницы').textContent).toBe(
      'kroshka.example/wp-admin/post.php?post=128&action=edit',
    )
    fireEvent.click(bar.getByRole('button', { name: 'Взять управление' }))
    fireEvent.click(bar.getByRole('button', { name: 'Остановить' }))
    expect(onTake).toHaveBeenCalledTimes(1)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Только просмотр')).toBeTruthy()
    expect(keyboard().disabled).toBe(true)
    expect(bar.queryByRole('button', { name: 'Продолжить работу агента' })).toBeNull()
  })

  it('says «Ждём вас» while the task waits for the client', () => {
    show({ head: head({ status: 'awaiting_user' }) })
    expect(within(toolbar()).getByRole('status').textContent).toBe('Ждём вас')
  })

  it('while this tab controls: «Продолжить работу агента», the hint and the address to go by', () => {
    const stream = holding()
    const { onResume, onStop } = show({ stream })
    const bar = within(toolbar())
    expect(bar.getByRole('status').textContent).toBe('Управляете вы')
    fireEvent.click(bar.getByRole('button', { name: 'Продолжить работу агента' }))
    expect(onResume).toHaveBeenCalledTimes(1)
    // «Остановить» moves into «Ещё».
    expect(bar.queryByRole('button', { name: 'Остановить' })).toBeNull()
    fireEvent.click(bar.getByRole('button', { name: 'Ещё' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Остановить' }))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(
      screen.getAllByText(
        'Агент не видит страницу, пока управляете вы. Пароль вводите прямо здесь. Чтобы вернуться к кнопкам, дважды нажмите Esc.',
      ).length,
    ).toBeGreaterThan(0)
    const address = bar.getByRole('textbox', { name: 'Адрес страницы' })
    fireEvent.change(address, { target: { value: 'kroshka.example/wp-admin/post-new.php' } })
    fireEvent.submit(address.closest('form')!)
    expect(sent(stream)).toContainEqual({
      t: 'navigate',
      url: 'https://kroshka.example/wp-admin/post-new.php',
    })
  })

  it('offers to take over when another tab controls the browser', () => {
    show({ stream: fakeStream({ state: state({ controller: 'user', holder: SESSION_ID }) }) })
    const bar = within(toolbar())
    expect(bar.getByText('Управление в другой вкладке')).toBeTruthy()
    expect(bar.getByRole('button', { name: 'Взять управление' })).toBeTruthy()
  })

  it('sends Russian text, keys and a paste with the stamp of the latest state', () => {
    const stream = holding()
    show({ stream })
    const field = keyboard()
    expect(field.disabled).toBe(false)
    fireEvent.input(field, { target: { value: 'Открыли веранду' } })
    expect(field.value).toBe('')
    fireEvent.keyDown(field, { key: 'Enter', code: 'Enter' })
    fireEvent.keyUp(field, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(field, { key: 's', code: 'KeyS', ctrlKey: true })
    // A paste shortcut sends no keys: its text comes with the paste.
    fireEvent.keyDown(field, { key: 'v', code: 'KeyV', ctrlKey: true })
    fireEvent.paste(field, { clipboardData: { getData: () => 'меню на сентябрь' } })
    const stamp = { t: 'input', pageId: 7, controlEpoch: 3, viewportVersion: 2 }
    expect(sent(stream)).toEqual([
      { ...stamp, event: { kind: 'text', text: 'Открыли веранду' } },
      {
        ...stamp,
        event: { kind: 'key', type: 'down', key: 'Enter', code: 'Enter', modifiers: [] },
      },
      { ...stamp, event: { kind: 'key', type: 'up', key: 'Enter', code: 'Enter', modifiers: [] } },
      {
        ...stamp,
        event: { kind: 'key', type: 'down', key: 's', code: 'KeyS', modifiers: ['Control'] },
      },
      { ...stamp, event: { kind: 'text', text: 'меню на сентябрь' } },
    ])
  })

  it('sends a finished composition once, and lets go of held keys when the focus goes', () => {
    const stream = holding()
    show({ stream })
    const field = keyboard()
    fireEvent.compositionStart(field)
    fireEvent.input(field, { target: { value: 'приве' } })
    fireEvent.compositionEnd(field, { data: 'привет' })
    fireEvent.keyDown(field, { key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true })
    fireEvent.blur(field)
    expect(sent(stream).map((message) => (message as { event: unknown }).event)).toEqual([
      { kind: 'text', text: 'приве' },
      { kind: 'key', type: 'down', key: 'ArrowLeft', code: 'ArrowLeft', modifiers: ['Shift'] },
      { kind: 'key', type: 'up', key: 'ArrowLeft', code: 'ArrowLeft', modifiers: ['Shift'] },
    ])
  })

  it('lets Esc twice leave the page for the toolbar, and every other key reach the page', () => {
    const stream = holding()
    show({ stream })
    const field = keyboard()
    field.focus()
    fireEvent.keyDown(field, { key: 'Tab', code: 'Tab' })
    fireEvent.keyUp(field, { key: 'Tab', code: 'Tab' })
    fireEvent.keyDown(field, { key: 'Escape', code: 'Escape' })
    fireEvent.keyUp(field, { key: 'Escape', code: 'Escape' })
    expect(document.activeElement).toBe(field)
    // The second Esc in a row is not the page's: the focus goes to the buttons above it.
    const second = fireEvent.keyDown(field, { key: 'Escape', code: 'Escape' })
    expect(second).toBe(false)
    expect(document.activeElement).toBe(toolbar())
    expect(sent(stream).map((message) => (message as { event: unknown }).event)).toEqual([
      { kind: 'key', type: 'down', key: 'Tab', code: 'Tab', modifiers: [] },
      { kind: 'key', type: 'up', key: 'Tab', code: 'Tab', modifiers: [] },
      { kind: 'key', type: 'down', key: 'Escape', code: 'Escape', modifiers: [] },
      { kind: 'key', type: 'up', key: 'Escape', code: 'Escape', modifiers: [] },
    ])
  })

  it('leaves a character of AltGr and an Enter of the input method to the text', () => {
    const stream = holding()
    show({ stream })
    const field = keyboard()
    fireEvent.keyDown(field, { key: '€', code: 'KeyE', modifierAltGraph: true })
    fireEvent.keyDown(field, { key: 'Enter', code: 'Enter', keyCode: 229 })
    expect(stream.send).not.toHaveBeenCalled()
  })

  it('maps a click on the picture to the window, and ignores the margins', () => {
    const stream = holding()
    // The panel is 1000 × 800: the window shows as 1000 × 625 between margins of 87 px.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 50,
      width: 1000,
      height: 800,
      right: 1100,
      bottom: 850,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    })
    show({ stream })
    fireEvent.pointerDown(canvas(), {
      pointerType: 'mouse',
      button: 0,
      clientX: 600,
      clientY: 449.5,
      pointerId: 1,
    })
    fireEvent.pointerUp(canvas(), {
      pointerType: 'mouse',
      button: 0,
      clientX: 600,
      clientY: 449.5,
      pointerId: 1,
    })
    fireEvent.pointerDown(canvas(), {
      pointerType: 'mouse',
      button: 0,
      clientX: 600,
      clientY: 60,
      pointerId: 2,
    })
    const events = sent(stream).map((message) => (message as { event: unknown }).event)
    expect(events).toEqual([
      { kind: 'mouse', type: 'move', x: 640, y: 400, button: 'none', clickCount: 0 },
      { kind: 'mouse', type: 'down', x: 640, y: 400, button: 'left', clickCount: 1 },
      { kind: 'mouse', type: 'up', x: 640, y: 400, button: 'left', clickCount: 1 },
    ])
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockRestore()
  })

  it('sends no input while the agent drives the browser', () => {
    const stream = fakeStream()
    show({ stream })
    fireEvent.pointerDown(canvas(), { pointerType: 'mouse', button: 0, clientX: 10, clientY: 10 })
    fireEvent.input(keyboard(), { target: { value: 'x' } })
    expect(stream.send).not.toHaveBeenCalled()
  })

  it('covers the picture while it connects, reconnects or fails', () => {
    const first = show({ stream: fakeStream({ connection: 'connecting', state: null }) })
    expect(screen.getByText('Подключаемся к браузеру…')).toBeTruthy()
    expect(within(toolbar()).getByRole('status').textContent).toBe('Подключение')
    expect(first.stream.send).not.toHaveBeenCalled()
  })

  it('offers «Повторить» when the browser cannot be shown', () => {
    const { stream } = show({ stream: fakeStream({ connection: 'failed' }) })
    expect(screen.getByRole('alert').textContent).toContain('Не удалось показать браузер')
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(stream.retry).toHaveBeenCalledTimes(1)
    expect(within(toolbar()).getByRole('status').textContent).toBe('Ошибка')
  })

  it('says when the browser was closed, and why', () => {
    show({
      head: head({ browser: { status: 'closed', closeReason: 'idle' } }),
      stream: fakeStream({ connection: 'idle', state: null }),
    })
    expect(screen.getByText('Браузер закрыт: 30 минут без действий')).toBeTruthy()
    expect(within(toolbar()).getByRole('status').textContent).toBe('Сессия закрыта')
    expect(within(toolbar()).queryByRole('button', { name: 'Взять управление' })).toBeNull()
  })

  it('asks the client to sign in with «Взять управление» on the picture', () => {
    const { onTake } = show({
      head: head({ status: 'awaiting_user' }),
      stream: fakeStream({ state: state({ help: { reason: 'login', message: 'Нужен вход.' } }) }),
    })
    expect(screen.getByRole('heading', { name: 'Войдите на сайт' })).toBeTruthy()
    expect(screen.getByText('Нужен вход.')).toBeTruthy()
    expect(
      screen.getByText(
        'Пока управляете вы, агент не видит страницу и то, что вы вводите. Пароль не пишите в чат.',
      ),
    ).toBeTruthy()
    const takes = screen.getAllByRole('button', { name: 'Взять управление' })
    fireEvent.click(takes.at(-1)!)
    expect(onTake).toHaveBeenCalledTimes(1)
  })

  it('offers no control while «Остановить» is under way, and says so', () => {
    const { onTake } = show({
      head: head({ status: 'awaiting_user' }),
      stream: fakeStream({ state: state({ help: { reason: 'login', message: 'Нужен вход.' } }) }),
      canStop: false,
      stopping: true,
    })
    expect(within(toolbar()).getByText('Останавливаем задачу…')).toBeTruthy()
    const takes = screen.getAllByRole<HTMLButtonElement>('button', { name: 'Взять управление' })
    // The toolbar's and the bottom bar's; the picture offers none.
    expect(takes).toHaveLength(2)
    for (const take of takes) {
      expect(take.disabled).toBe(true)
      fireEvent.click(take)
    }
    expect(onTake).not.toHaveBeenCalled()
    cleanup()
    const { onResume } = show({ stream: holding(), canStop: false, stopping: true })
    const resumes = screen.getAllByRole<HTMLButtonElement>('button', {
      name: 'Продолжить работу агента',
    })
    for (const resume of resumes) {
      expect(resume.disabled).toBe(true)
      fireEvent.click(resume)
    }
    expect(onResume).not.toHaveBeenCalled()
  })

  it('answers a question of the page in a window of Радити, the safe choice first', () => {
    const stream = holding({ dialog: { id: 'd1', kind: 'beforeunload', message: '' } })
    show({ stream })
    const dialog = screen.getByRole('dialog', { name: 'Страница спрашивает' })
    expect(
      within(dialog).getByText('Покинуть страницу? Изменения могут не сохраниться.'),
    ).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Остаться' }))
    expect(sent(stream)).toContainEqual({ t: 'dialog', id: 'd1', accept: false })
  })

  it('fills the answer of a prompt', () => {
    const stream = holding({
      dialog: { id: 'd2', kind: 'prompt', message: 'Название рубрики?', defaultValue: 'Новости' },
    })
    show({ stream })
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Ответ странице' }), {
      target: { value: 'Веранда' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'ОК' }))
    expect(sent(stream)).toContainEqual({ t: 'dialog', id: 'd2', accept: true, text: 'Веранда' })
  })

  it('gives a file chooser of the page the files of the task', async () => {
    calls.list.mockResolvedValue([
      {
        id: '0199a3f2-0000-7000-8000-0000000000f1',
        name: 'veranda-1.jpg',
        type: 'image/jpeg',
        size: 2_400_000,
        kind: 'image',
        sentAt: new Date(),
      },
      {
        id: '0199a3f2-0000-7000-8000-0000000000f2',
        name: 'menu-leto.pdf',
        type: 'application/pdf',
        size: 312_000,
        kind: 'document',
        sentAt: new Date(),
      },
    ])
    const stream = holding({ chooser: { id: 'c1', multiple: false, accept: ['image/*'] } })
    show({ stream })
    const dialog = screen.getByRole('dialog', { name: 'Выберите файл для загрузки на сайт' })
    const image = await within(dialog).findByRole('radio', { name: 'veranda-1.jpg' })
    // A file the page does not take cannot be chosen.
    expect(
      within(dialog).getByRole<HTMLInputElement>('radio', { name: 'menu-leto.pdf' }).disabled,
    ).toBe(true)
    fireEvent.click(image)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Загрузить на сайт' }))
    await vi.waitFor(() =>
      expect(sent(stream)).toContainEqual({
        t: 'files',
        chooserId: 'c1',
        attachmentIds: ['0199a3f2-0000-7000-8000-0000000000f1'],
      }),
    )
    expect(calls.bind).not.toHaveBeenCalled()
  })

  it('cancels a file chooser with no files', () => {
    const stream = holding({ chooser: { id: 'c2', multiple: true, accept: [] } })
    show({ stream })
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(sent(stream)).toContainEqual({ t: 'files', chooserId: 'c2', attachmentIds: [] })
  })

  it('offers the window sizes only while this tab controls the browser', () => {
    const agent = show()
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Ещё' }))
    expect(screen.getByRole('menuitem', { name: '1440 × 900' }).getAttribute('aria-disabled')).toBe(
      'true',
    )
    expect(agent.stream.send).not.toHaveBeenCalled()
  })

  it('changes the window size from the menu while this tab controls the browser', () => {
    const stream = holding()
    show({ stream })
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Ещё' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '1024 × 768' }))
    expect(sent(stream)).toContainEqual({ t: 'viewport', width: 1024, height: 768 })
  })

  it('switches tabs from the list of the page tabs', () => {
    const stream = holding({
      tabs: [
        { pageId: 7, url: 'https://kroshka.example/wp-admin/post.php', title: 'Новая запись' },
        { pageId: 8, url: 'https://kroshka.example/wp-admin/upload.php', title: 'Медиафайлы' },
      ],
    })
    show({ stream })
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Вкладка 1 из 2' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Медиафайлы' }))
    expect(sent(stream)).toContainEqual({ t: 'tab', pageId: 8 })
  })

  it('keeps «Свернуть» while the browser is over the content, on a phone too', () => {
    const { onFullscreen } = show({ fullscreen: true })
    const button = within(toolbar()).getByRole('button', { name: 'Свернуть' })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(phoneDisplay(button)).toBe('inline-flex')
    fireEvent.click(button)
    expect(onFullscreen).toHaveBeenCalledWith(false)
  })

  it('toggles the whole area for the browser', () => {
    const { onFullscreen } = show()
    const button = within(toolbar()).getByRole('button', { name: 'Во весь экран' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    expect(onFullscreen).toHaveBeenCalledWith(true)
  })
})
