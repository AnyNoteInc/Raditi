// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ArtifactMoveButton } from './artifact-move'
import type { CabinetArtifact } from './use-artifact'

// «Перенести в проект…» and «Сделать личным» (docs/plan/88-artifacts.md, Ар42).

const ARTIFACT = '019f1a21-1800-7f00-8abc-0000000000a1'
const PROJECT = '019f1a21-1800-7f00-8abc-0000000000b1'
const move = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ moved: true })))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    project: {
      list: {
        queryOptions: () => ({
          queryKey: ['project.list'],
          queryFn: async () => ({
            items: [
              { id: PROJECT, name: 'Пекарня', archived: false },
              { id: '019f1a21-1800-7f00-8abc-0000000000b2', name: 'Старое', archived: true },
            ],
          }),
        }),
      },
    },
    artifact: { move: { mutationOptions: () => ({ mutationFn: move }) } },
  }),
}))

const artifact = (role: CabinetArtifact['role']) =>
  ({ id: ARTIFACT, role, project: null }) as unknown as CabinetArtifact

function show(role: CabinetArtifact['role'] = 'owner') {
  const changed = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ArtifactMoveButton artifact={artifact(role)} onChanged={changed} />
    </QueryClientProvider>,
  )
  return changed
}

describe('«Перенести в проект…»', () => {
  it('moves a personal artifact into a live project of the owner', async () => {
    const changed = show()
    fireEvent.click(screen.getByRole('button', { name: 'Перенести в проект…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Перенести в проект' })
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'Пекарня' }))
    // A project in «Архив» is not offered.
    expect(within(dialog).queryByRole('radio', { name: 'Старое' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Перенести' }))
    await waitFor(() => expect(changed).toHaveBeenCalled())
    expect(move.mock.calls[0]![0]).toEqual({ artifactId: ARTIFACT, projectId: PROJECT })
  })

  it('is not there for one who does not own the artifact', () => {
    show('edit')
    expect(screen.queryByRole('button', { name: 'Перенести в проект…' })).toBeNull()
  })
})
