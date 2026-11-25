// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FeedArtifact } from './feed-artifact'

const ARTIFACT = '0199a3f2-0000-7000-8000-0000000000c1'
const TASK = '0199a3f2-0000-7000-8000-0000000000aa'

const { ofChat } = vi.hoisted(() => ({
  ofChat: vi.fn(async (_input: { taskId: string }) => [
    {
      id: '0199a3f2-0000-7000-8000-0000000000c1',
      kind: 'canvas',
      title: 'Сайт пекарни',
      version: 2,
      group: 'made' as const,
    },
  ]),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    artifact: {
      ofChat: {
        queryOptions: (input: { taskId: string }) => ({
          queryKey: ['artifact', 'ofChat', input],
          queryFn: () => ofChat(input),
        }),
      },
    },
  }),
}))

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

beforeEach(() => vi.clearAllMocks())

describe('FeedArtifact (plan 93, АТ9)', () => {
  it('names a canvas of the chat by its title, and «Открыть» shows it beside the chat', async () => {
    const onOpen = vi.fn()
    wrap(<FeedArtifact taskId={TASK} artifactId={ARTIFACT} kind="canvas" onOpen={onOpen} />)
    expect(await screen.findByText('Сайт пекарни')).toBeTruthy()
    expect(screen.getByRole('article', { name: 'Холст «Сайт пекарни»' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Открыть «Сайт пекарни»' }))
    expect(onOpen).toHaveBeenCalledWith(ARTIFACT)
  })

  it('says it is open beside the chat instead of «Открыть»', async () => {
    wrap(<FeedArtifact taskId={TASK} artifactId={ARTIFACT} kind="canvas" onOpen={vi.fn()} open />)
    expect(await screen.findByText('Открыто справа')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Открыть/ })).toBeNull()
  })

  it('leads to the page of the artifact where the chat has no tab, named by its kind', () => {
    wrap(<FeedArtifact artifactId={ARTIFACT} kind="slides" />)
    expect(ofChat).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'Открыть «Презентация»' })).toHaveAttribute(
      'href',
      `/artifacts/${ARTIFACT}`,
    )
  })
})
