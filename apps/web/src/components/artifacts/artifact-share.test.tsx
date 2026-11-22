// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ArtifactShareButton } from './artifact-share'
import type { CabinetArtifact } from './use-artifact'

// «Поделиться» (docs/plan/88-artifacts.md, Ар33–Ар36).

const ARTIFACT = '019f1a21-1800-7f00-8abc-0000000000a1'
const calls = vi.hoisted(() => ({
  link: vi.fn(async (_input: unknown) => ({ token: 'C'.repeat(43), expiresAt: null })),
  invite: vi.fn(async (_input: unknown) => ({ sent: true })),
}))
const mutation = (fn: (input: never) => Promise<unknown>) => ({
  mutationOptions: () => ({ mutationFn: fn }),
})

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    artifact: {
      shareState: {
        queryKey: (input: unknown) => ['shareState', input],
        queryOptions: (input: unknown) => ({
          queryKey: ['shareState', input],
          queryFn: async () => ({
            link: null,
            people: [
              {
                userId: '019f1a21-1800-7f00-8abc-0000000000b1',
                name: 'Борис',
                email: 'boris@example.ru',
                role: 'view',
                sources: ['link'],
              },
            ],
            invites: [],
          }),
        }),
      },
      shareLink: mutation(calls.link),
      shareRevoke: mutation(vi.fn()),
      shareInvite: mutation(calls.invite),
      shareInviteRevoke: mutation(vi.fn()),
      shareSetRole: mutation(vi.fn()),
      shareRemove: mutation(vi.fn()),
      shareCloseAll: mutation(vi.fn()),
    },
  }),
}))

const artifact = (role: CabinetArtifact['role'], kind = 'document') =>
  ({ id: ARTIFACT, role, kind }) as unknown as CabinetArtifact

function show(value: CabinetArtifact) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ArtifactShareButton artifact={value} />
    </QueryClientProvider>,
  )
}

describe('«Поделиться»', () => {
  it('makes a link shown once, invites by an address, lists who has access', async () => {
    show(artifact('owner'))
    fireEvent.click(screen.getByRole('button', { name: 'Поделиться' }))
    const dialog = await screen.findByRole('dialog', { name: 'Поделиться' })
    expect(await within(dialog).findByText('Борис')).toBeTruthy()
    expect(within(dialog).getByText('boris@example.ru')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать ссылку' }))
    await waitFor(() =>
      expect(calls.link).toHaveBeenCalledWith(
        { artifactId: ARTIFACT, role: 'view', term: null },
        expect.anything(),
      ),
    )
    expect(
      (
        within(dialog).getByRole('textbox', {
          name: 'Ссылка для пользователей Радити',
        }) as HTMLInputElement
      ).value,
    ).toBe(`${window.location.origin}/a#${'C'.repeat(43)}`)
    fireEvent.change(within(dialog).getByLabelText('Адрес почты'), {
      target: { value: 'vera@example.ru' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Пригласить' }))
    await waitFor(() =>
      expect(calls.invite).toHaveBeenCalledWith(
        { artifactId: ARTIFACT, email: 'vera@example.ru', role: 'view' },
        expect.anything(),
      ),
    )
    expect(await within(dialog).findByText('Приглашение отправлено.')).toBeTruthy()
  })

  it('is not there for a recipient', () => {
    show(artifact('edit'))
    expect(screen.queryByRole('button', { name: 'Поделиться' })).toBeNull()
  })
})
