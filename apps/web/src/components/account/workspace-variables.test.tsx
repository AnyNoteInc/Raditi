// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { variablesText, WorkspaceVariables } from './workspace-variables'

const WORKSPACE = '0199a3f2-0000-7000-8000-000000000101'

const calls = vi.hoisted(() => ({
  list: vi.fn(),
  set: vi.fn(async (input: { name: string; value: string }) => ({
    name: input.name,
    keyVersion: 1,
    updatedAt: new Date('2026-11-15T09:00:00Z'),
  })),
  remove: vi.fn(async () => ({ removed: true })),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    workspaceEnv: {
      list: {
        queryOptions: () => ({ queryKey: ['workspaceEnv', 'list'], queryFn: calls.list }),
        queryKey: () => ['workspaceEnv', 'list'],
      },
      set: { mutationOptions: () => ({ mutationFn: calls.set }) },
      remove: { mutationOptions: () => ({ mutationFn: calls.remove }) },
    },
  }),
}))

function page() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceVariables />
    </QueryClientProvider>,
  )
}

const listed = (patch: Record<string, unknown> = {}) => ({
  workspaceId: WORKSPACE,
  canEdit: true,
  agentGets: true,
  variables: [{ name: 'DELIVERY_KEY', keyVersion: 2, updatedAt: new Date('2026-11-14T09:00:00Z') }],
  ...patch,
})

beforeEach(() => {
  calls.list.mockReset()
  calls.set.mockClear()
  calls.remove.mockClear()
})

describe('«Настройки → Переменные» (docs/plan/83-remove-projects.md, БП4)', () => {
  it('lists the names, never a value, and says every chat gets them', async () => {
    calls.list.mockResolvedValue(listed())
    page()
    expect(await screen.findByText('DELIVERY_KEY')).toBeTruthy()
    expect(screen.getByText(variablesText.note)).toBeTruthy()
    expect(screen.queryByText(variablesText.agentClosed)).toBeNull()
  })

  it('adds a variable of the workspace and says it was saved', async () => {
    calls.list.mockResolvedValue(listed({ variables: [] }))
    page()
    fireEvent.click(await screen.findByRole('button', { name: variablesText.add }))
    fireEvent.change(screen.getByLabelText(new RegExp(variablesText.name)), {
      target: { value: 'API_KEY' },
    })
    fireEvent.change(screen.getByLabelText(new RegExp(variablesText.value)), {
      target: { value: 'secret-value' },
    })
    fireEvent.click(screen.getByRole('button', { name: variablesText.save }))
    await waitFor(() => expect(calls.set).toHaveBeenCalled())
    expect(calls.set.mock.calls[0]![0]).toEqual({
      workspaceId: WORKSPACE,
      name: 'API_KEY',
      value: 'secret-value',
    })
    expect(await screen.findByText(variablesText.saved('API_KEY'))).toBeTruthy()
  })

  it('refuses a name the platform would refuse before anything is sent', async () => {
    calls.list.mockResolvedValue(listed({ variables: [] }))
    page()
    fireEvent.click(await screen.findByRole('button', { name: variablesText.add }))
    fireEvent.change(screen.getByLabelText(new RegExp(variablesText.name)), {
      target: { value: 'PATH' },
    })
    fireEvent.change(screen.getByLabelText(new RegExp(variablesText.value)), {
      target: { value: 'x' },
    })
    fireEvent.click(screen.getByRole('button', { name: variablesText.save }))
    expect(await screen.findByText(variablesText.nameReserved)).toBeTruthy()
    expect(calls.set).not.toHaveBeenCalled()
  })

  it('removes a variable after the client confirms it', async () => {
    calls.list.mockResolvedValue(listed())
    page()
    fireEvent.click(await screen.findByRole('button', { name: variablesText.remove }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: variablesText.remove }))
    await waitFor(() => expect(calls.remove).toHaveBeenCalled())
    expect(calls.remove.mock.calls[0]).toEqual([
      { workspaceId: WORKSPACE, name: 'DELIVERY_KEY' },
      expect.anything(),
    ])
  })

  it('offers no change to a member, and tells a workspace of client data what waits', async () => {
    calls.list.mockResolvedValue(listed({ canEdit: false, agentGets: false }))
    page()
    expect(await screen.findByText(variablesText.readOnly)).toBeTruthy()
    expect(screen.getByText(variablesText.agentClosed)).toBeTruthy()
    expect(screen.queryByRole('button', { name: variablesText.add })).toBeNull()
    expect(screen.queryByRole('button', { name: variablesText.remove })).toBeNull()
  })
})
