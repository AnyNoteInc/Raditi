// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { serverRefusal } from '@/components/billing/testing'
import { SITE_ID } from '@/components/chat/testing'

import { NewDialog } from './new-dialog'

type Created = { taskId: string; alias: string; created: boolean }
type CreateInput = { siteId: string; taskId: string; text: string }

const { create, push } = vi.hoisted(() => ({
  create: vi.fn<(input: CreateInput) => Promise<Created>>(),
  push: vi.fn<(path: string) => void>(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    task: {
      create: {
        mutationOptions: (options: UseMutationOptions<Created, Error, CreateInput>) => ({
          ...options,
          mutationFn: create,
        }),
      },
    },
    billing: { usage: { queryKey: () => ['billing', 'usage'] } },
  }),
}))

const NOT_CONNECTED = 'Сайт ещё не подключён. Задачи можно будет ставить после подключения.'
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const described = (element: HTMLElement) =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')

function showDialog(props: { accepting?: boolean; heading?: 'h1' | 'h2' } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <NewDialog siteId={SITE_ID} accepting={props.accepting ?? true} heading={props.heading} />
    </QueryClientProvider>,
  )
  return queryClient
}

const field = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Сообщение' })
const send = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Отправить' })
const write = (text: string) => fireEvent.change(field(), { target: { value: text } })

beforeEach(() => {
  vi.clearAllMocks()
  create.mockImplementation(async ({ taskId }) => ({ taskId, alias: 'a1b2c3', created: true }))
})

describe('new dialog', () => {
  it('heads the screen and labels the message field', () => {
    showDialog()
    expect(screen.getByRole('heading', { level: 1, name: 'Новый диалог' })).toBeTruthy()
    expect(field().tagName).toBe('TEXTAREA')
    expect(field().getAttribute('placeholder')).toBe('Что поменять на сайте?')
  })

  it('takes the level below beside a list that heads the page', () => {
    showDialog({ heading: 'h2' })
    expect(screen.getByRole('heading', { level: 2, name: 'Новый диалог' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })

  it('starts a dialog with the first words under an id of the browser and opens it', async () => {
    const queryClient = showDialog()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    write('Поменяйте телефон в шапке сайта')
    fireEvent.click(send())
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    // The list shows the new dialog, and the credits under it what its reserve left.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['billing', 'usage'] })
    const [input] = create.mock.calls[0]!
    expect(input).toEqual({
      siteId: SITE_ID,
      taskId: expect.stringMatching(UUID_V7),
      text: 'Поменяйте телефон в шапке сайта',
    })
    expect(push).toHaveBeenCalledWith(`/projects/${SITE_ID}/chat/${input.taskId}`)
  })

  it('repeats a request that got no answer under the same id, and keeps the words', async () => {
    create.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    showDialog()
    write('Поменяйте телефон в шапке сайта')
    fireEvent.click(send())
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.',
    )
    expect(field().value).toBe('Поменяйте телефон в шапке сайта')
    fireEvent.click(send())
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[1]![0].taskId).toBe(create.mock.calls[0]![0].taskId)
  })

  it('says a refusal of the server in its words', async () => {
    create.mockRejectedValueOnce(
      serverRefusal(
        'Похоже, в сообщении есть пароль или ключ. Не отправляйте их в чат — доступы задаются в разделе «Настройки»',
        'TASK_TEXT_HAS_SECRET',
      ),
    )
    showDialog()
    write('пароль: hunter2')
    fireEvent.click(send())
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Похоже, в сообщении есть пароль или ключ. Не отправляйте их в чат — доступы задаются в разделе «Настройки».',
    )
    expect(push).not.toHaveBeenCalled()
  })

  it('has no window of commands: commands belong to a dialog', () => {
    showDialog()
    write('/')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Команды' })).toBeNull()
  })

  it('never starts a dialog with the words of a command', () => {
    showDialog()
    write('/release')
    fireEvent.click(send())
    expect(create).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(
      'Команды работают внутри диалога. Сначала опишите, что поменять на сайте.',
    )
  })

  it('says on the field why a site that is not connected takes no task', () => {
    showDialog({ accepting: false })
    expect(field().disabled).toBe(true)
    expect(send().disabled).toBe(true)
    expect(described(field())).toBe(NOT_CONNECTED)
    expect(described(send())).toBe(NOT_CONNECTED)
  })

  it('offers two modes in two words, «Работа» chosen', () => {
    showDialog()
    const modes = within(screen.getByRole('radiogroup', { name: 'Режим диалога' }))
    expect(modes.getAllByRole('radio').map((mode) => mode.closest('label')?.textContent)).toEqual([
      'Чат',
      'Работа',
    ])
    expect(modes.getByRole<HTMLInputElement>('radio', { name: 'Работа' }).checked).toBe(true)
  })

  it('shows «Чат» as a mode that cannot be chosen and says so in words', () => {
    showDialog()
    const chat = screen.getByRole<HTMLInputElement>('radio', { name: 'Чат' })
    expect(chat.disabled).toBe(true)
    expect(chat.checked).toBe(false)
    expect(described(chat)).toBe('Режим «Чат» появится позже.')
    // Not by colour alone: the word carries a mark of its own.
    expect(chat.closest('label')?.querySelector('svg')).toBeTruthy()
    expect(
      screen.getByRole('radio', { name: 'Работа' }).closest('label')?.querySelector('svg'),
    ).toBeNull()
  })

  it('keeps the reminders under the field and no attachments', () => {
    showDialog()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByText('ИИ может допускать ошибки. Проверяйте важное.')).toBeTruthy()
  })
})
