// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactPublishButton } from './artifact-publish'
import type { CabinetArtifact } from './use-artifact'

// «Опубликовать» of an artifact (docs/plan/88-artifacts.md, Ар2, Ар23, 88.11б; plan 93, АТ9): the
// current version by default, an older one behind «Другая версия».

const ID = '019f1a21-1800-7f00-8abc-000000000001'
const { publish, publication } = vi.hoisted(() => ({
  publish: vi.fn(async (_input: unknown) => ({
    pageId: '019f1a21-1800-7f00-8abc-0000000000bb',
    url: 'https://abc.pages.raditi.ru/',
    version: 1,
    versionNo: 3,
  })),
  publication: vi.fn(async (): Promise<unknown> => null),
}))

const query = (path: string, fn: () => Promise<unknown>) => ({
  queryKey: (input: unknown) => [path, input],
  queryOptions: (input: unknown) => ({ queryKey: [path, input], queryFn: fn }),
})

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    pages: {
      artifactPublication: query('publication', publication),
      publishArtifact: { mutationOptions: () => ({ mutationFn: publish }) },
    },
    artifact: {
      versions: query('versions', async () => [
        {
          no: 3,
          label: null,
          createdAt: '2026-11-20T10:00:00.000Z',
          current: true,
        },
        {
          no: 2,
          label: 'Для мамы',
          createdAt: '2026-11-19T10:00:00.000Z',
          current: false,
        },
      ]),
    },
  }),
}))

const doc = (role: string, kind = 'document') =>
  ({ id: ID, kind, role, version: 3 }) as unknown as CabinetArtifact

function show(role = 'owner', kind = 'document') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ArtifactPublishButton artifact={doc(role, kind)} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  publication.mockResolvedValue(null)
})

describe('«Опубликовать» (88.11б, АТ9)', () => {
  it('publishes the current version in one step and gives the address', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Опубликовать' }))
    const dialog = screen.getByRole('dialog', { name: 'Опубликовать страницу' })
    expect(within(dialog).getByText(/снимок артефакта/)).toBeTruthy()
    // No version to choose until asked for.
    expect(within(dialog).queryByRole('combobox')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Опубликовать' }))
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith({ artifactId: ID, versionNo: null }, expect.anything()),
    )
    expect(
      await within(dialog).findByRole('link', { name: 'https://abc.pages.raditi.ru/' }),
    ).toBeTruthy()
  })

  it('publishes an older version chosen behind «Другая версия»', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Опубликовать' }))
    const dialog = screen.getByRole('dialog', { name: 'Опубликовать страницу' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Другая версия' }))
    fireEvent.mouseDown(within(dialog).getByRole('combobox'))
    fireEvent.click(await screen.findByRole('option', { name: /Версия 2 · .* · «Для мамы»/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Опубликовать' }))
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith({ artifactId: ID, versionNo: 2 }, expect.anything()),
    )
  })

  it('offers «Обновить» once there is a page, saying it shows an older version', async () => {
    publication.mockResolvedValue({
      pageId: 'p',
      url: 'https://abc.pages.raditi.ru/',
      versionNo: 2,
      current: false,
    })
    show()
    // The page is read first: the dialog opens on what is there.
    await waitFor(() => expect(publication).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Опубликовать' }))
    const dialog = screen.getByRole('dialog', { name: 'Обновить страницу' })
    expect(within(dialog).getByText(/показывает более раннюю версию/)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Обновить' })).toBeTruthy()
  })

  it('says «сайт» of a canvas', async () => {
    show('owner', 'canvas')
    fireEvent.click(await screen.findByRole('button', { name: 'Опубликовать' }))
    expect(screen.getByRole('dialog', { name: 'Опубликовать сайт' })).toBeTruthy()
  })

  it('is not there for one who is not the owner', () => {
    show('edit')
    expect(screen.queryByRole('button', { name: 'Опубликовать' })).toBeNull()
  })
})
