// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ArtifactShareButton } from './artifact-share'
import type { CabinetArtifact } from './use-artifact'

// «Поделиться» (docs/plan/88-artifacts.md, Ар33–Ар36; plan 93, АТ9): «Ссылка», «Люди», «Дополнительно».

const ARTIFACT = '019f1a21-1800-7f00-8abc-0000000000a1'
const calls = vi.hoisted(() => ({
  link: vi.fn(async (_input: unknown) => ({ token: 'C'.repeat(43), expiresAt: null })),
  invite: vi.fn(async (_input: unknown) => ({ sent: true })),
  setCopy: vi.fn(async (_input: unknown) => ({ allowed: true })),
  closeAll: vi.fn(async (_input: unknown) => ({ links: 0, grants: 1 })),
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
            copyAllowed: false,
          }),
        }),
      },
      shareLink: mutation(calls.link),
      shareRevoke: mutation(vi.fn()),
      shareInvite: mutation(calls.invite),
      shareInviteRevoke: mutation(vi.fn()),
      shareSetRole: mutation(vi.fn()),
      shareRemove: mutation(vi.fn()),
      shareCloseAll: mutation(calls.closeAll),
      shareSetCopy: mutation(calls.setCopy),
    },
  }),
}))

const artifact = (role: CabinetArtifact['role'], kind = 'document') =>
  ({ id: ARTIFACT, role, kind, title: 'Прайс' }) as unknown as CabinetArtifact

function show(value: CabinetArtifact) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ArtifactShareButton artifact={value} />
    </QueryClientProvider>,
  )
}

describe('«Поделиться» (АТ9)', () => {
  it('turns the link on and gives it to copy, invites by an address, lists who has access', async () => {
    show(artifact('owner'))
    fireEvent.click(screen.getByRole('button', { name: 'Поделиться' }))
    const dialog = await screen.findByRole('dialog', { name: 'Поделиться «Прайс»' })
    expect(within(dialog).getByRole('region', { name: 'Ссылка' })).toBeTruthy()
    const people = within(dialog).getByRole('region', { name: 'Люди' })
    expect(await within(people).findByText('Борис')).toBeTruthy()
    expect(within(people).getByText('boris@example.ru')).toBeTruthy()
    // The rare settings wait under «Дополнительно».
    expect(within(dialog).queryByRole('button', { name: 'Закрыть доступ всем' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Доступ по ссылке' }))
    await waitFor(() =>
      expect(calls.link).toHaveBeenCalledWith(
        { artifactId: ARTIFACT, role: 'view', term: null },
        expect.anything(),
      ),
    )
    expect(
      (
        (await within(dialog).findByRole('textbox', {
          name: 'Ссылка на артефакт',
        })) as HTMLInputElement
      ).value,
    ).toBe(`${window.location.origin}/a#${'C'.repeat(43)}`)
    fireEvent.change(within(people).getByLabelText('Адрес почты'), {
      target: { value: 'vera@example.ru' },
    })
    fireEvent.click(within(people).getByRole('button', { name: 'Пригласить' }))
    await waitFor(() =>
      expect(calls.invite).toHaveBeenCalledWith(
        { artifactId: ARTIFACT, email: 'vera@example.ru', role: 'view' },
        expect.anything(),
      ),
    )
    expect(await within(dialog).findByText('Приглашение отправлено.')).toBeTruthy()
  })

  it('keeps the copy and «Закрыть доступ всем» under «Дополнительно»', async () => {
    show(artifact('owner'))
    fireEvent.click(screen.getByRole('button', { name: 'Поделиться' }))
    const dialog = await screen.findByRole('dialog', { name: 'Поделиться «Прайс»' })
    await within(dialog).findByText('Борис')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Дополнительно' }))
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'Разрешить делать копию' }))
    await waitFor(() =>
      expect(calls.setCopy).toHaveBeenCalledWith(
        { artifactId: ARTIFACT, allowed: true },
        expect.anything(),
      ),
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Закрыть доступ всем' }))
    await waitFor(() =>
      expect(calls.closeAll).toHaveBeenCalledWith({ artifactId: ARTIFACT }, expect.anything()),
    )
  })

  it('is not there for a recipient', () => {
    show(artifact('edit'))
    expect(screen.queryByRole('button', { name: 'Поделиться' })).toBeNull()
  })
})
