// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentMemorySettings } from '@/components/account/agent-memory-settings'
import { FeedMemoryChange } from '@/components/chat/feed-memory'

import { MemoryPanel, ProjectMemoryRow, type MemoryEntry } from './project-memory'

// «Память» (docs/plan/84-projects.md, ПР18, ПР28, §4.8; P-memory-empty, P-memory, P-chat): the row
// of the column, the window with «Предложено» and «Сохранено», the rows of the chat with
// «Сохранить» and «Не надо», «Настройки → Общее → Память агента».

const PROJECT_ID = '0199a3f2-0000-7000-8000-00000000c001'
const CHAT_ID = '0199a3f2-0000-7000-8000-0000000c4a71'
const id = (n: number) => `0199a3f2-0000-7000-8000-0000000e000${n}`
const at = new Date()

const entry = (n: number, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: id(n),
  kind: 'preference',
  text: `Запись ${n}`,
  status: 'active',
  author: 'agent',
  version: 1,
  pendingAction: null,
  pendingText: null,
  source: { taskId: CHAT_ID, title: 'Онлайн-заказ тортов' },
  confirmed: false,
  createdAt: at,
  updatedAt: at,
  ...over,
})

const calls = vi.hoisted(() => ({
  list: vi.fn<(input: { projectId: string | null }) => Promise<unknown>>(),
  get: vi.fn<(input: { id: string }) => Promise<unknown>>(),
  add: vi.fn(async (input: unknown) => input),
  update: vi.fn(async (input: unknown) => input),
  confirm: vi.fn(async (_input: unknown) => ({ decision: 'saved', entry: null })),
  reject: vi.fn(async (_input: unknown) => ({ decision: 'dropped', entry: null })),
  remove: vi.fn(async (input: { id: string }) => input),
  clear: vi.fn(async (_input: unknown) => ({ removed: 2 })),
  setAccount: vi.fn(async (_input: unknown) => ({ updated: true })),
  setAgentMemory: vi.fn(async (input: { on: boolean }) => input),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    project: {
      pathKey: () => ['project'],
      update: { mutationOptions: () => ({ mutationFn: calls.setAccount }) },
    },
    user: { setAgentMemory: { mutationOptions: () => ({ mutationFn: calls.setAgentMemory }) } },
    projectMemory: {
      pathKey: () => ['projectMemory'],
      list: {
        queryOptions: (input: { projectId: string | null }) => ({
          queryKey: ['projectMemory', 'list', input],
          queryFn: () => calls.list(input),
        }),
      },
      get: {
        queryOptions: (input: { id: string }) => ({
          queryKey: ['projectMemory', 'get', input],
          queryFn: () => calls.get(input),
        }),
      },
      add: { mutationOptions: () => ({ mutationFn: calls.add }) },
      update: { mutationOptions: () => ({ mutationFn: calls.update }) },
      confirm: { mutationOptions: () => ({ mutationFn: calls.confirm }) },
      reject: { mutationOptions: () => ({ mutationFn: calls.reject }) },
      remove: { mutationOptions: () => ({ mutationFn: calls.remove }) },
      clear: { mutationOptions: () => ({ mutationFn: calls.clear }) },
    },
  }),
}))

function wrap(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

const listOf = (entries: MemoryEntry[], over: Record<string, unknown> = {}) => ({
  entries,
  useAccountMemory: true,
  agentMemory: true,
  limit: 40,
  ...over,
})

beforeEach(() => {
  for (const call of Object.values(calls)) call.mockClear()
})
afterEach(cleanup)

describe('«Память» of a project', () => {
  it('names its entries and the proposals in the column, and opens its window', async () => {
    calls.list.mockResolvedValue(listOf([]))
    wrap(<ProjectMemoryRow project={{ id: PROJECT_ID, memory: { active: 7, proposed: 2 } }} />)
    const row = screen.getByRole('region', { name: 'Память' })
    expect(row.textContent).toContain('7 записей · 2 предложены')
    fireEvent.click(within(row).getByRole('button', { name: 'Открыть память проекта' }))
    expect(await screen.findByText('Память пока пуста')).toBeTruthy()
    expect(
      screen.getByText(
        'Скажите агенту «запомни…» — или он сам предложит сохранить важное по ходу чатов.',
      ),
    ).toBeTruthy()
    expect(calls.list).toHaveBeenCalledWith({ projectId: PROJECT_ID })
    // The switch of the account's memory, with the way to it.
    expect(
      screen.getByRole<HTMLInputElement>('switch', { name: 'Использовать память аккаунта' })
        .checked,
    ).toBe(true)
    expect(
      screen.getByRole('link', { name: 'Посмотреть память аккаунта' }).getAttribute('href'),
    ).toBe('/settings#memory')
  })

  it('says «Пока пусто» for a project without entries', () => {
    wrap(<ProjectMemoryRow project={{ id: PROJECT_ID, memory: { active: 0, proposed: 0 } }} />)
    expect(screen.getByText('Пока пусто. Скажите агенту «запомни…»')).toBeTruthy()
  })

  it('saves and drops the proposals at their versions', async () => {
    calls.list.mockResolvedValue(
      listOf([
        entry(1, { status: 'proposed', version: 3, text: 'Форма заказа торта — в один экран' }),
        entry(2, {
          pendingAction: 'update',
          pendingText: 'Ответы — коротко, без таблиц',
          text: 'Ответы — коротко',
          version: 2,
        }),
        entry(3, { pendingAction: 'forget', text: 'Фото снимает Аня' }),
        entry(4, { author: 'client', confirmed: true, text: 'Главный цвет — терракотовый' }),
      ]),
    )
    wrap(<MemoryPanel projectId={PROJECT_ID} />)
    const proposed = await screen.findByRole('region', { name: /Предложено/ })
    expect(proposed.textContent).toContain('Агент их не учитывает, пока вы не сохраните')
    expect(proposed.textContent).toContain('предложено в чате «Онлайн-заказ тортов» · сегодня')
    expect(proposed.textContent).toContain('Агент предлагает изменить запись')
    expect(proposed.textContent).toContain('Сейчас: Ответы — коротко')
    expect(proposed.textContent).toContain('Агент предлагает забыть эту запись')
    const items = within(proposed).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    fireEvent.click(within(items[0]!).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() =>
      expect(calls.confirm.mock.calls[0]?.[0]).toEqual({ id: id(1), expectedVersion: 3 }),
    )
    fireEvent.click(within(items[1]!).getByRole('button', { name: 'Не надо' }))
    await waitFor(() =>
      expect(calls.reject.mock.calls[0]?.[0]).toEqual({ id: id(2), expectedVersion: 2 }),
    )
    // «Предложено забыть»: «Удалить» deletes the entry.
    fireEvent.click(within(items[2]!).getByRole('button', { name: 'Удалить' }))
    await waitFor(() =>
      expect(calls.confirm.mock.calls[1]?.[0]).toEqual({ id: id(3), expectedVersion: 1 }),
    )

    const saved = screen.getByRole('region', { name: /Сохранено/ })
    expect(saved.textContent).toContain('добавлено вами · сегодня')
    expect(saved.textContent).toContain('Предпочтение')
  })

  it('adds, edits, removes and clears', async () => {
    calls.list.mockResolvedValue(listOf([entry(1, { text: 'Пишем на «вы»', version: 4 })]))
    wrap(<MemoryPanel projectId={PROJECT_ID} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Изменить запись «Пишем на «вы»»' }))
    const field = screen.getByRole('textbox', { name: 'Текст записи' })
    fireEvent.change(field, { target: { value: 'Пишем по-дружески, на «вы»' } })
    expect(screen.getByText('26 из 400')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() =>
      expect(calls.update.mock.calls[0]?.[0]).toEqual({
        id: id(1),
        text: 'Пишем по-дружески, на «вы»',
        kind: 'preference',
        expectedVersion: 4,
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Добавить запись' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Текст записи' }), {
      target: { value: 'Торты принимаем за 48 часов' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() =>
      expect(calls.add.mock.calls[0]?.[0]).toEqual({
        projectId: PROJECT_ID,
        kind: 'fact',
        text: 'Торты принимаем за 48 часов',
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Удалить запись «Пишем на «вы»»' }))
    await waitFor(() => expect(calls.remove.mock.calls[0]?.[0]).toEqual({ id: id(1) }))

    fireEvent.click(screen.getByRole('button', { name: 'Очистить память' }))
    expect(screen.getByText('Очистить память?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Очистить' }))
    await waitFor(() => expect(calls.clear.mock.calls[0]?.[0]).toEqual({ projectId: PROJECT_ID }))
  })

  it('turns the account memory of the project off and says when the memory is off', async () => {
    calls.list.mockResolvedValue(listOf([], { agentMemory: false }))
    wrap(<MemoryPanel projectId={PROJECT_ID} />)
    expect(
      await screen.findByText('Память агента выключена — агент не читает и не пишет записи.'),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Использовать память аккаунта' }))
    await waitFor(() =>
      expect(calls.setAccount.mock.calls[0]?.[0]).toEqual({
        projectId: PROJECT_ID,
        useAccountMemory: false,
      }),
    )
  })

  it('refuses to add at 40 entries', async () => {
    calls.list.mockResolvedValue(
      listOf(
        Array.from({ length: 40 }, (_, n) =>
          entry(n, { id: `0199a3f2-0000-7000-8000-${String(n).padStart(12, '0')}` }),
        ),
      ),
    )
    wrap(<MemoryPanel projectId={PROJECT_ID} />)
    expect(
      await screen.findByText('В памяти 40 записей — удалите ненужные, чтобы добавить новую.'),
    ).toBeTruthy()
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Добавить запись' }).disabled,
    ).toBe(true)
  })
})

describe('the rows of memory in a chat (P-chat)', () => {
  it('shows «Запомнено» without buttons', () => {
    wrap(<FeedMemoryChange entryId={id(1)} action="saved" text="Цены — только из прайса" />)
    expect(screen.getByText('Запомнено: Цены — только из прайса')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(calls.get).not.toHaveBeenCalled()
  })

  it('offers «Сохранить» and «Не надо» while the proposal waits', async () => {
    calls.get.mockResolvedValue(entry(1, { status: 'proposed', version: 2 }))
    wrap(<FeedMemoryChange entryId={id(1)} action="proposed" text="Блоки — под шапкой" />)
    expect(screen.getByText('Агент предлагает запомнить: Блоки — под шапкой')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }))
    await waitFor(() =>
      expect(calls.confirm.mock.calls[0]?.[0]).toEqual({ id: id(1), expectedVersion: 2 }),
    )
    expect(await screen.findByText('· Сохранено')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Не надо' })).toBeNull()
  })

  it('shows no buttons for a proposal decided already or gone', async () => {
    calls.get.mockResolvedValueOnce(entry(1, { status: 'active', confirmed: true }))
    wrap(<FeedMemoryChange entryId={id(1)} action="proposed" text="Блоки — под шапкой" />)
    await waitFor(() => expect(calls.get).toHaveBeenCalled())
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    calls.get.mockResolvedValueOnce(null)
    wrap(<FeedMemoryChange entryId={id(1)} action="forget_proposed" text="Фото" />)
    await waitFor(() => expect(calls.get).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('drops a proposal to forget with «Не надо»', async () => {
    calls.get.mockResolvedValue(entry(1, { pendingAction: 'forget', version: 5 }))
    wrap(<FeedMemoryChange entryId={id(1)} action="forget_proposed" text="Фото снимает Аня" />)
    expect(await screen.findByRole('button', { name: 'Удалить' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Не надо' }))
    await waitFor(() =>
      expect(calls.reject.mock.calls[0]?.[0]).toEqual({ id: id(1), expectedVersion: 5 }),
    )
  })
})

describe('«Настройки → Общее → Память агента»', () => {
  it('turns «Агент запоминает важное» off and lists the account memory', async () => {
    calls.list.mockResolvedValue(
      listOf([entry(1, { text: 'Ответы — коротко' })], { useAccountMemory: null }),
    )
    wrap(<AgentMemorySettings />)
    const toggle = await screen.findByRole<HTMLInputElement>('switch', {
      name: 'Агент запоминает важное',
    })
    expect(toggle.checked).toBe(true)
    expect(calls.list).toHaveBeenCalledWith({ projectId: null })
    expect(await screen.findByText('Ответы — коротко')).toBeTruthy()
    // The account has no switch of its own account memory.
    expect(screen.queryByRole('switch', { name: 'Использовать память аккаунта' })).toBeNull()
    fireEvent.click(toggle)
    await waitFor(() => expect(calls.setAgentMemory.mock.calls[0]?.[0]).toEqual({ on: false }))
  })
})
