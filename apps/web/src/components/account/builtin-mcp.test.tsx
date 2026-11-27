// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BuiltinMcp, builtinMcpText, type BuiltinMcpView } from './builtin-mcp'

const WORKSPACE_ID = '0199a000-0000-7000-8000-0000000000c1'
const GROUP_ID = '0199a000-0000-7000-8000-0000000000d1'

type Answer = (input: Record<string, unknown>) => Promise<BuiltinMcpView>
const calls = vi.hoisted(() => ({
  switch: vi.fn<Answer>(),
  vkConnect: vi.fn<Answer>(),
  vkDisconnect: vi.fn<Answer>(),
}))

const mutation = (fn: Answer) => ({
  mutationOptions: (options: UseMutationOptions<unknown, Error, Record<string, unknown>>) => ({
    ...options,
    mutationFn: fn,
  }),
})
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    builtinMcp: {
      switch: mutation(calls.switch),
      vkConnect: mutation(calls.vkConnect),
      vkDisconnect: mutation(calls.vkDisconnect),
    },
  }),
}))

const vk = (patch: Partial<BuiltinMcpView['servers'][number]> = {}) => ({
  server: 'vk' as const,
  title: 'ВКонтакте',
  summary: 'Агент готовит посты и ответы на комментарии в вашей группе.',
  needsKey: true,
  enabled: false,
  communities: [],
  ...patch,
})
const group = {
  id: GROUP_ID,
  name: 'Кофейня у дома',
  url: 'https://vk.com/coffee',
  closed: false,
  refused: false,
  notices: true,
}
const view = (patch: Partial<BuiltinMcpView> = {}): BuiltinMcpView => ({
  workspaceId: WORKSPACE_ID,
  servers: [vk()],
  canManage: true,
  communitiesLeft: 10,
  ...patch,
})

function show(initial: BuiltinMcpView) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <BuiltinMcp initial={initial} />
    </QueryClientProvider>,
  )
}

const toggle = () => screen.getByRole('switch', { name: builtinMcpText.switchLabel('ВКонтакте') })

beforeEach(() => Object.values(calls).forEach((call) => call.mockReset()))

describe('«Встроенные MCP»', () => {
  it('opens the key of a community when «ВКонтакте» is turned on, and asks the server nothing yet', () => {
    show(view())
    expect(toggle()).not.toBeChecked()
    expect(screen.queryByLabelText(builtinMcpText.keyTitle)).toBeNull()
    fireEvent.click(toggle())
    expect(screen.getByLabelText(builtinMcpText.keyTitle)).toBeInTheDocument()
    expect(calls.switch).not.toHaveBeenCalled()
  })

  it('connects the key, and the switch stays on with the group listed', async () => {
    calls.vkConnect.mockResolvedValue(
      view({ servers: [vk({ enabled: true, communities: [group] })] }),
    )
    show(view())
    fireEvent.click(toggle())
    fireEvent.change(screen.getByLabelText(builtinMcpText.keyTitle), {
      target: { value: ' vk1.a.key ' },
    })
    fireEvent.click(screen.getByRole('button', { name: builtinMcpText.connect }))
    await waitFor(() =>
      expect(calls.vkConnect).toHaveBeenCalledWith(
        { workspaceId: WORKSPACE_ID, token: 'vk1.a.key' },
        expect.anything(),
      ),
    )
    expect(await screen.findByText('Кофейня у дома')).toBeInTheDocument()
    expect(toggle()).toBeChecked()
    expect(screen.queryByLabelText(builtinMcpText.keyTitle)).toBeNull()
  })

  it('cancelling the key leaves «ВКонтакте» off', () => {
    show(view())
    fireEvent.click(toggle())
    fireEvent.click(screen.getByRole('button', { name: builtinMcpText.cancel }))
    expect(toggle()).not.toBeChecked()
  })

  it('turns a server with a working group off and on by the switch alone', async () => {
    calls.switch.mockResolvedValue(
      view({ servers: [vk({ enabled: false, communities: [group] })] }),
    )
    show(view({ servers: [vk({ enabled: true, communities: [group] })] }))
    fireEvent.click(toggle())
    await waitFor(() =>
      expect(calls.switch).toHaveBeenCalledWith(
        { workspaceId: WORKSPACE_ID, server: 'vk', enabled: false },
        expect.anything(),
      ),
    )
    await waitFor(() => expect(toggle()).not.toBeChecked())
  })

  it('says a group tells of no comments when its key had no right «Управление»', () => {
    show(view({ servers: [vk({ enabled: true, communities: [{ ...group, notices: false }] })] }))
    expect(screen.getByText(builtinMcpText.noNotices)).toBeInTheDocument()
  })

  it('shows a member the switches without changing them', () => {
    show(view({ canManage: false, servers: [vk({ enabled: true, communities: [group] })] }))
    expect(screen.getByText(builtinMcpText.readOnly)).toBeInTheDocument()
    expect(toggle()).toBeDisabled()
    expect(screen.queryByRole('button', { name: builtinMcpText.disconnect })).toBeNull()
  })
})
