// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AgentInstructions, instructionsText } from './agent-instructions'

const calls = vi.hoisted(() => ({
  read: vi.fn(async () => ({ text: 'Мы — кофейня' })),
  save: vi.fn(async (input: { text: string }) => ({ text: input.text.trim() })),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    user: {
      agentInstructions: {
        queryOptions: () => ({ queryKey: ['user', 'agentInstructions'], queryFn: calls.read }),
        queryKey: () => ['user', 'agentInstructions'],
      },
      setAgentInstructions: { mutationOptions: () => ({ mutationFn: calls.save }) },
    },
  }),
}))

describe('«Инструкции агенту» (docs/plan/76, И1)', () => {
  it('shows the instructions, saves a change and says it was saved', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AgentInstructions />
      </QueryClientProvider>,
    )
    const field = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: instructionsText.title,
    })
    expect(field.value).toBe('Мы — кофейня')
    const save = screen.getByRole<HTMLButtonElement>('button', { name: instructionsText.save })
    expect(save.disabled).toBe(true)
    fireEvent.change(field, { target: { value: 'Мы — кофейня у метро' } })
    fireEvent.click(save)
    await waitFor(() => expect(calls.save).toHaveBeenCalled())
    expect(calls.save.mock.calls[0]![0]).toEqual({ text: 'Мы — кофейня у метро' })
    expect(await screen.findByText(instructionsText.saved)).toBeTruthy()
  })
})
