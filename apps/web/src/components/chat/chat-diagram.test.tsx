// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentMarkdown } from './agent-markdown'
import { diagramPictureText } from '@/components/diagram/diagram-picture'

import { chatDiagramText } from './chat-texts'

// Diagrams in an answer of the agent (docs/plan/91-chat-diagrams.md, Д1, Д4): the server's picture
// as <img>, asked by the row and the place — never by the text; the line of an error with the text.

const TASK = '0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17'
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"/>'

const { diagram } = vi.hoisted(() => ({
  diagram: vi.fn(async (_input: unknown): Promise<unknown> => ({ state: 'drawing' })),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    task: {
      diagram: {
        queryOptions: (input: unknown) => ({
          queryKey: ['task.diagram', input],
          queryFn: async () => {
            const out = await diagram(input)
            // The server's NOT_FOUND, thrown by the query and not by the mock.
            if (out === 'NOT_FOUND') throw new Error('NOT_FOUND')
            return out
          },
        }),
      },
    },
  }),
}))

const answer = [
  'Вот как идёт заказ:',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[Заявка] --> B[Счёт]',
  '```',
  '',
  'И то же для разработчика:',
  '',
  '```plantuml',
  'Клиент -> Магазин : Заказ',
  '```',
].join('\n')

function shown(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

describe('a diagram in an answer of the chat', () => {
  beforeEach(() => diagram.mockReset())

  it('asks for each diagram by the row and its place, and shows the picture', async () => {
    diagram.mockImplementation(async () => ({ state: 'drawn', svg: SVG, width: 320, height: 120 }))
    const { container } = shown(<AgentMarkdown text={answer} place={{ taskId: TASK, row: '42' }} />)
    await waitFor(() =>
      expect(container.querySelectorAll('[data-chat-diagram] img')).toHaveLength(2),
    )
    expect(diagram).toHaveBeenCalledWith({ taskId: TASK, row: '42', index: 0 })
    expect(diagram).toHaveBeenCalledWith({ taskId: TASK, row: '42', index: 1 })
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    expect(img.getAttribute('alt')).toBe(chatDiagramText.alt)
    // The text of the diagram is not drawn as code while its picture is shown.
    expect(container.querySelector('pre')).toBeNull()
    expect(screen.getAllByRole('button', { name: diagramPictureText.png })).toHaveLength(2)
  })

  it('says it draws, and shows the line of an error with the text', async () => {
    diagram.mockImplementationOnce(async () => ({ state: 'drawing' }))
    diagram.mockImplementationOnce(async () => ({ state: 'failed', line: 1 }))
    shown(<AgentMarkdown text={answer} place={{ taskId: TASK, row: '42' }} />)
    expect(await screen.findByText(diagramPictureText.drawing)).toBeTruthy()
    expect(await screen.findByText('Схема не нарисована: ошибка в строке 1')).toBeTruthy()
    // The text of the diagram is shown with the line of the error marked.
    expect(document.querySelector('[data-error="true"]')?.textContent).toBe(
      'Клиент -> Магазин : Заказ',
    )
  })

  it('stays code when the server finds no such diagram, and without a place', async () => {
    diagram.mockImplementation(async () => 'NOT_FOUND')
    const { container } = shown(<AgentMarkdown text={answer} place={{ taskId: TASK, row: '42' }} />)
    await waitFor(() => expect(container.querySelectorAll('pre')).toHaveLength(2))
    diagram.mockClear()
    const plain = shown(<AgentMarkdown text={answer} />)
    expect(plain.container.querySelectorAll('pre')).toHaveLength(2)
    expect(diagram).not.toHaveBeenCalled()
  })
})
