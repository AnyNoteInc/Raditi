// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProjectArtifacts } from './project-artifacts'

// «Артефакты проекта» inside «Контекст» (docs/plan/88-artifacts.md, Ар42).

const PROJECT = '019f1a21-1800-7f00-8abc-0000000000b1'
const rows = vi.hoisted(() => ({ value: [] as { id: string; kind: string; title: string }[] }))
const list = vi.hoisted(() => vi.fn())

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    artifact: {
      list: {
        queryOptions: (input: unknown) => ({
          queryKey: ['artifact.list', input],
          queryFn: async () => {
            list(input)
            return rows.value
          },
        }),
      },
    },
  }),
}))

const row = (n: number) => ({
  id: `019f1a21-1800-7f00-8abc-00000000010${n}`,
  kind: 'document',
  title: `Документ ${n}`,
})

function show() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectArtifacts projectId={PROJECT} />
    </QueryClientProvider>,
  )
}

describe('the artifacts of a project in «Контекст»', () => {
  it('names the newest three, each opened by its page, and the rest by the gallery', async () => {
    rows.value = [1, 2, 3, 4].map(row)
    show()
    const first = await screen.findByRole('link', { name: 'Документ 1' })
    expect(first.getAttribute('href')).toBe(`/artifacts/${row(1).id}`)
    expect(screen.queryByRole('link', { name: 'Документ 4' })).toBeNull()
    expect(
      screen.getByRole('link', { name: 'Все артефакты проекта (4)' }).getAttribute('href'),
    ).toBe(`/artifacts?project=${PROJECT}`)
    expect(list).toHaveBeenCalledWith({ filter: 'all', projectId: PROJECT, sort: 'newest' })
  })

  it('says where they will come from while there are none', async () => {
    rows.value = []
    show()
    expect(await screen.findByText(/которые агент сделает в чатах проекта/)).toBeTruthy()
  })
})
