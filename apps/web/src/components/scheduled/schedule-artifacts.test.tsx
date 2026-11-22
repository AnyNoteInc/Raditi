// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ScheduleArtifacts } from './schedule-artifacts'

// «Артефакты задачи» of the page of a scheduled task (docs/plan/88-artifacts.md, Ар24, 88.20б).

const SCHEDULE = '019f2a00-0000-7000-8000-0000000000a1'
const PROJECT = '019f2a00-0000-7000-8000-0000000000b1'
const setArtifacts = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ artifactIds: [] })))

const row = (id: string, title: string, project: { id: string; name: string } | null) => ({
  id,
  kind: 'document',
  title,
  project,
})

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    schedule: {
      artifacts: {
        queryKey: (input: unknown) => ['schedule.artifacts', input],
        queryOptions: (input: unknown) => ({
          queryKey: ['schedule.artifacts', input],
          queryFn: async () => [],
        }),
      },
      setArtifacts: { mutationOptions: () => ({ mutationFn: setArtifacts }) },
    },
    artifact: {
      list: {
        queryOptions: (input: unknown) => ({
          queryKey: ['artifact.list', input],
          queryFn: async () => [
            row('019f2a00-0000-7000-8000-0000000000c1', 'Личный отчёт', null),
            row('019f2a00-0000-7000-8000-0000000000c2', 'План проекта', {
              id: PROJECT,
              name: 'Сайт',
            }),
            row('019f2a00-0000-7000-8000-0000000000c3', 'Чужой проект', {
              id: '019f2a00-0000-7000-8000-0000000000b2',
              name: 'Другой',
            }),
          ],
        }),
      },
    },
  }),
}))

describe('the artifacts a scheduled task names', () => {
  it('offers the personal ones and those of its project, and saves the whole set', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ScheduleArtifacts scheduleId={SCHEDULE} projectId={PROJECT} />
      </QueryClientProvider>,
    )
    expect(await screen.findByText(/задача меняет только ваши личные артефакты/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать' }))
    const dialog = await screen.findByRole('dialog', { name: 'Артефакты задачи' })
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'План проекта' }))
    expect(within(dialog).getByRole('checkbox', { name: 'Личный отчёт' })).toBeTruthy()
    expect(within(dialog).queryByRole('checkbox', { name: 'Чужой проект' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() =>
      expect(setArtifacts.mock.calls[0]![0]).toEqual({
        scheduleId: SCHEDULE,
        artifactIds: ['019f2a00-0000-7000-8000-0000000000c2'],
      }),
    )
  })
})
