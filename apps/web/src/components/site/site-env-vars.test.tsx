// @vitest-environment jsdom
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { plain, serverRefusal } from '@/components/billing/testing'
import type { SiteEnvVar } from '@/components/chat/chat-types'
import { SITE_ID } from '@/components/chat/testing'

import { hostsOf, recipientsText, SiteEnvVars } from './site-env-vars'

type SetInput = {
  siteId: string
  name: string
  value: string
  hosts: string[]
  toPreview: boolean
  toAgent: boolean
  agentConsent: boolean
}

const { list, set, remove } = vi.hoisted(() => ({
  list: vi.fn<
    (input: { siteId: string }) => Promise<{ agentAllowed: boolean; variables: SiteEnvVar[] }>
  >(),
  set: vi.fn<(input: SetInput) => Promise<SiteEnvVar>>(),
  remove: vi.fn<(input: { siteId: string; name: string }) => Promise<{ removed: boolean }>>(),
}))

const mutation = <I, O>(fn: (input: I) => Promise<O>) => ({
  mutationOptions: (options: UseMutationOptions<O, Error, I>) => ({ ...options, mutationFn: fn }),
})

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    siteEnv: {
      list: {
        queryKey: (input: { siteId: string }) => ['siteEnv.list', input] as QueryKey,
        queryOptions: (input: { siteId: string }) => ({
          queryKey: ['siteEnv.list', input] as QueryKey,
          queryFn: () => list(input),
        }),
      },
      set: mutation(set),
      remove: mutation(remove),
    },
  }),
}))

const delivery: SiteEnvVar = {
  name: 'DELIVERY_KEY',
  hosts: ['api.delivery.example.ru'],
  toAgent: false,
  toPreview: true,
  agentConsentAt: null,
  keyVersion: 1,
  updatedAt: new Date('2026-10-17T09:00:00Z'),
}

function showVariables() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <SiteEnvVars siteId={SITE_ID} />
    </QueryClientProvider>,
  )
}

const card = () =>
  screen.getByRole('heading', { level: 1, name: 'Переменные окружения' }).closest('section')!
/** The panel a variable is added or changed in: it slides in over the page, outside the section. */
const panel = (name: string | RegExp) => screen.getByRole('dialog', { name })
const input = (name: string) => screen.getByLabelText<HTMLInputElement>(name, { exact: false })
const type = (name: string, value: string) => fireEvent.change(input(name), { target: { value } })
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
/** «Добавить переменную» once the list is read: until then it stands in its place, disabled. */
async function addButton() {
  const button = await screen.findByRole<HTMLButtonElement>('button', {
    name: 'Добавить переменную',
  })
  await waitFor(() => expect(button.disabled).toBe(false))
  return button
}

beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue({ agentAllowed: true, variables: [delivery] })
  set.mockImplementation(async (variable) => ({
    ...delivery,
    name: variable.name,
    hosts: variable.hosts,
    toAgent: variable.toAgent,
    toPreview: variable.toPreview,
    agentConsentAt: variable.toAgent ? new Date() : null,
  }))
  remove.mockResolvedValue({ removed: true })
})

describe('the variables of a site', () => {
  it('lists the names, the addresses and whom a variable goes to, never a value', async () => {
    showVariables()
    expect(await screen.findByText('DELIVERY_KEY')).toBeTruthy()
    const text = plain(card().textContent)
    expect(text).toContain('api.delivery.example.ru · значение скрыто')
    expect(text).toContain(
      'Пока не передаётся: предпросмотр получит её, только когда её начнут передавать агенту.',
    )
    expect(list).toHaveBeenCalledWith({ siteId: SITE_ID })
  })

  it('adds a variable in a panel over the page: the value goes once, and the form says the preview needs the agent', async () => {
    showVariables()
    const add = await addButton()
    // At the top of the section, beside its heading, not under the list.
    expect(add.parentElement!.contains(screen.getByText('Переменные окружения'))).toBe(true)
    fireEvent.click(add)
    expect(plain(panel('Добавить переменную').textContent)).toContain(
      'переменная попадёт в предпросмотр, только если её передают и агенту',
    )
    expect(document.activeElement).toBe(input('Имя'))
    expect(input('Значение').type).toBe('password')
    type('Имя', 'CRM_TOKEN')
    type('Значение', 'tok-1234567890')
    type('Адреса сервиса', 'crm.example.ru\napi.crm.example.ru:8443')
    save()
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1))
    expect(set.mock.calls[0]![0]).toEqual({
      siteId: SITE_ID,
      name: 'CRM_TOKEN',
      value: 'tok-1234567890',
      hosts: ['crm.example.ru', 'api.crm.example.ru:8443'],
      toPreview: true,
      toAgent: false,
      agentConsent: false,
    })
    expect(await screen.findByText('Переменная CRM_TOKEN сохранена.')).toBeTruthy()
    // The panel slides out, and what was typed in it goes with it.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByDisplayValue('tok-1234567890')).toBeNull()
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('keeps «Добавить переменную» in its place, disabled, while the list is read', async () => {
    let answer: (value: { agentAllowed: boolean; variables: SiteEnvVar[] }) => void = () => {}
    list.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    showVariables()
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Добавить переменную' })
    expect(button.disabled).toBe(true)
    answer({ agentAllowed: true, variables: [] })
    await waitFor(() => expect(button.disabled).toBe(false))
  })

  it('closes the panel by «Отмена» and leaves the list as it was', async () => {
    showVariables()
    fireEvent.click(await screen.findByRole('button', { name: 'Изменить DELIVERY_KEY' }))
    expect(panel('Изменить DELIVERY_KEY')).toBeTruthy()
    expect(document.activeElement).toBe(input('Значение'))
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(set).not.toHaveBeenCalled()
    expect(card()).toBeTruthy()
  })

  it('gives a variable to the agent only with the consent', async () => {
    showVariables()
    fireEvent.click(await addButton())
    type('Имя', 'CRM_TOKEN')
    type('Значение', 'tok-1234567890')
    fireEvent.click(screen.getByRole('switch', { name: 'Передавать агенту' }))
    const consent = screen.getByRole('checkbox', {
      name: 'Я понимаю: агент увидит то, что вернёт этот сервис.',
    })
    save()
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Чтобы передать переменную агенту, отметьте согласие.',
    )
    expect(set).not.toHaveBeenCalled()
    fireEvent.click(consent)
    save()
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1))
    expect(set.mock.calls[0]![0]).toMatchObject({ toAgent: true, agentConsent: true })
  })

  it('checks the name and the value before sending', async () => {
    showVariables()
    fireEvent.click(await addButton())
    type('Имя', 'WP_HOME')
    type('Значение', 'short')
    save()
    expect(await screen.findByText('Это имя занято платформой. Выберите другое.')).toBeTruthy()
    expect(document.activeElement).toBe(input('Имя'))
    type('Имя', 'shop key')
    save()
    expect(
      await screen.findByText(
        'Имя может состоять только из заглавных латинских букв, цифр и знака подчёркивания и должно начинаться с буквы.',
      ),
    ).toBeTruthy()
    type('Имя', 'SHOP_KEY')
    type('Значение', '')
    save()
    expect(await screen.findByText('Введите значение.')).toBeTruthy()
    expect(document.activeElement).toBe(input('Значение'))
    expect(set).not.toHaveBeenCalled()
  })

  it('says a refusal of the server, such as the closed agent of client data', async () => {
    set.mockRejectedValueOnce(
      serverRefusal(
        'Для этого сайта передавать переменные агенту пока нельзя, а без агента их не получает и предпросмотр. Выключите «Передавать агенту», чтобы сохранить переменную',
        'SITE_ENV_AGENT_CLOSED',
      ),
    )
    showVariables()
    fireEvent.click(await screen.findByRole('button', { name: 'Изменить DELIVERY_KEY' }))
    // The value is never shown again: a change asks for it anew.
    expect(input('Значение').value).toBe('')
    expect(input('Имя').disabled).toBe(true)
    type('Значение', 'new-value-123')
    fireEvent.click(screen.getByRole('switch', { name: 'Передавать агенту' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /агент увидит/ }))
    save()
    expect(
      await screen.findByText(
        'Для этого сайта передавать переменные агенту пока нельзя, а без агента их не получает и предпросмотр. Выключите «Передавать агенту», чтобы сохранить переменную.',
      ),
    ).toBeTruthy()
  })

  it('keeps «Передавать агенту» off up front where the workspace may not give variables to the agent', async () => {
    list.mockResolvedValue({
      agentAllowed: false,
      variables: [{ ...delivery, toAgent: true, agentConsentAt: new Date() }],
    })
    showVariables()
    expect(await screen.findByText('DELIVERY_KEY')).toBeTruthy()
    const closed =
      'Для этого сайта передавать переменные агенту пока нельзя, а без агента их не получает и предпросмотр.'
    expect(plain(card().textContent)).toContain(`Не передаётся. ${closed}`)
    fireEvent.click(screen.getByRole('button', { name: 'Изменить DELIVERY_KEY' }))
    const agent = screen.getByRole<HTMLInputElement>('switch', { name: 'Передавать агенту' })
    expect(agent.checked).toBe(false)
    expect(agent.disabled).toBe(true)
    expect(screen.queryByRole('checkbox', { name: /агент увидит/ })).toBeNull()
    expect(plain(panel('Изменить DELIVERY_KEY').textContent)).toContain(closed)
    type('Значение', 'new-value-123')
    save()
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1))
    expect(set.mock.calls[0]![0]).toMatchObject({ toAgent: false, agentConsent: false })
  })

  it('reads the list again when someone changed the variable meanwhile', async () => {
    set.mockRejectedValueOnce(
      serverRefusal('Переменную только что изменили. Обновите страницу', 'SITE_ENV_CHANGED'),
    )
    showVariables()
    fireEvent.click(await screen.findByRole('button', { name: 'Изменить DELIVERY_KEY' }))
    type('Значение', 'new-value-123')
    save()
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('removes a variable after a confirmation', async () => {
    showVariables()
    fireEvent.click(await screen.findByRole('button', { name: 'Удалить DELIVERY_KEY' }))
    const confirm = screen.getByRole('dialog', { name: 'Удалить переменную DELIVERY_KEY?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Удалить' }))
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
    expect(remove.mock.calls[0]![0]).toEqual({ siteId: SITE_ID, name: 'DELIVERY_KEY' })
    expect(await screen.findByText('Переменная DELIVERY_KEY удалена.')).toBeTruthy()
  })

  it('tells a member that only owners and admins see the variables', async () => {
    list.mockRejectedValue(
      serverRefusal(
        'Переменные сайта могут видеть и менять только владелец и администраторы',
        'SITE_ENV_NOT_ALLOWED',
      ),
    )
    showVariables()
    expect(
      await screen.findByText(
        'Переменные сайта могут видеть и менять только владелец и администраторы.',
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Добавить переменную' })).toBeNull()
  })
})

describe('helpers', () => {
  it('takes the addresses one per line, or apart by commas and spaces', () => {
    expect(hostsOf(' a.example.ru,\nb.example.ru:8443  c.example.ru ')).toEqual([
      'a.example.ru',
      'b.example.ru:8443',
      'c.example.ru',
    ])
  })

  it('names the agent only with the consent on record', () => {
    expect(recipientsText({ toAgent: true, toPreview: true, agentConsentAt: new Date() })).toBe(
      'Передаётся агенту и предпросмотру.',
    )
    expect(recipientsText({ toAgent: true, toPreview: false, agentConsentAt: new Date() })).toBe(
      'Передаётся агенту.',
    )
    expect(recipientsText({ toAgent: false, toPreview: false, agentConsentAt: null })).toBe(
      'Не передаётся ни агенту, ни предпросмотру.',
    )
    expect(
      recipientsText({ toAgent: true, toPreview: true, agentConsentAt: new Date() }, false),
    ).toBe(
      'Не передаётся. Для этого сайта передавать переменные агенту пока нельзя, а без агента их не получает и предпросмотр.',
    )
  })
})
