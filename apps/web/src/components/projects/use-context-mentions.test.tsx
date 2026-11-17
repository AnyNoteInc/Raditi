// @vitest-environment jsdom
import { SANDBOX_PROJECT, SANDBOX_WORKDIR } from '@repo/domain'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { CONTEXT_MENTION_ROOT, REPO_MENTION_ROOT, useContextMentions } from './use-context-mentions'

// `@` in a chat of a project (docs/plan/84-projects.md, ПР24; slice 84.26): the files of the context
// and, once core keeps them, the paths of the main branch of the repository — each under its root.

const PROJECT = '0199a3f2-0000-7000-8000-00000000c001'
const answers = vi.hoisted(() => ({
  files: vi.fn(async () => ({ files: [{ name: 'Прайс.pdf' }] })),
  paths: vi.fn(async (): Promise<unknown> => ({ state: 'none' })),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    projectFile: {
      list: {
        queryOptions: (input: unknown) => ({ queryKey: ['files', input], queryFn: answers.files }),
      },
    },
    projectRepo: {
      paths: {
        queryOptions: (input: unknown) => ({ queryKey: ['paths', input], queryFn: answers.paths }),
      },
    },
  }),
}))

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
)

describe('`@` of a chat of a project', () => {
  it('puts the paths where the sandbox has them', () => {
    expect(CONTEXT_MENTION_ROOT).toBe(`${SANDBOX_PROJECT}/`)
    expect(REPO_MENTION_ROOT).toBe(`${SANDBOX_WORKDIR}/`)
  })

  it('without a repository: the files of the context below their own root', async () => {
    answers.paths.mockResolvedValueOnce({ state: 'none' })
    const { result } = renderHook(() => useContextMentions(PROJECT), { wrapper })
    expect(answers.files).not.toHaveBeenCalled()
    act(() => result.current!.onOpen())
    await waitFor(() => expect(result.current!.state).toBe('ready'))
    expect(result.current).toMatchObject({ paths: ['Прайс.pdf'], root: '/workspace/project/' })
  })

  it('with the paths of the repository: two folders below /workspace/', async () => {
    answers.paths.mockResolvedValueOnce({
      state: 'ready',
      sha: 'a'.repeat(40),
      paths: ['src/app.ts', 'README.md'],
      truncated: false,
    })
    const { result } = renderHook(() => useContextMentions(PROJECT), { wrapper })
    act(() => result.current!.onOpen())
    await waitFor(() => expect(result.current!.root).toBe('/workspace/'))
    expect(result.current!.paths).toEqual([
      'project/Прайс.pdf',
      'repo/src/app.ts',
      'repo/README.md',
    ])
    expect(`@${result.current!.root}${result.current!.paths![1]}`).toBe(
      '@/workspace/repo/src/app.ts',
    )
  })

  it('a chat without a project has no list', () => {
    const { result } = renderHook(() => useContextMentions(null), { wrapper })
    expect(result.current).toBeUndefined()
  })
})
