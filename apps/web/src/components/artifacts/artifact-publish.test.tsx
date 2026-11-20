// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactPublishButton } from './artifact-publish'
import type { CabinetArtifact } from './use-artifact'

// «Опубликовать как страницу» of a document (docs/plan/88-artifacts.md, Ар2, Ар23, 88.11б).

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
    artifact: { versions: query('versions', async () => []) },
  }),
}))

const doc = (role: string) =>
  ({ id: ID, kind: 'document', role, version: 3 }) as unknown as CabinetArtifact

function show(role = 'owner') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ArtifactPublishButton artifact={doc(role)} />
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('«Опубликовать как страницу» (88.11б)', () => {
  it('publishes the current version and gives the address', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Опубликовать как страницу' }))
    const dialog = screen.getByRole('dialog', { name: 'Опубликовать как страницу' })
    expect(within(dialog).getByText(/снимок артефакта/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Опубликовать' }))
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith({ artifactId: ID, versionNo: null }, expect.anything()),
    )
    expect(
      await within(dialog).findByRole('link', { name: 'https://abc.pages.raditi.ru/' }),
    ).toBeTruthy()
  })

  it('offers «Обновить страницу» once there is a page, and nothing to one who is not the owner', async () => {
    publication.mockResolvedValue({
      pageId: 'p',
      url: 'https://abc.pages.raditi.ru/',
      versionNo: 2,
      current: false,
    })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Обновить страницу' }))
    expect(
      await screen.findByText(/Страница показывает версию 2\. С тех пор артефакт изменился\./),
    ).toBeTruthy()
  })

  it('is not there for a viewer', () => {
    show('edit')
    expect(screen.queryByRole('button', { name: /страниц/ })).toBeNull()
  })
})
