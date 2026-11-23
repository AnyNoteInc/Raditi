// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CabinetArtifact } from '../use-artifact'
import { ArtifactSitemap, sitemapTexts } from './artifact-sitemap'

// «Структура сайта» in the cabinet (docs/plan/88-artifacts.md, §7.7, 88.27): the outline of the
// pages, a page written with its revision, moved among its siblings, nested and taken out, and
// «Сделать сайт» — the request to the agent in the draft of a new chat.

const ARTIFACT = '019f1a21-1800-7f00-8abc-0000000000b8'

const { write, keep, push } = vi.hoisted(() => ({
  write: vi.fn(async (_input: unknown) => ({ seq: 2 })),
  keep: vi.fn(),
  push: vi.fn(),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    artifact: { write: { mutationOptions: () => ({ mutationFn: write }) } },
    user: {
      me: { queryOptions: () => ({ queryKey: ['me'], queryFn: async () => ({ id: 'user-1' }) }) },
    },
  }),
}))
vi.mock('@/components/chat/chat-draft', () => ({ keepChatDraft: keep }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

const node = (key: string, props: Record<string, string>, content = '', rev = 1) => ({
  key,
  kind: 'node',
  parent: null,
  rank: key,
  props,
  rev,
  heading: null,
  content,
  checking: false,
  hold: null,
})

function site(role: CabinetArtifact['role'] = 'owner'): CabinetArtifact {
  return {
    id: ARTIFACT,
    kind: 'sitemap',
    title: 'Структура сайта',
    seq: 2,
    role,
    version: 1,
    project: null,
    updatedAt: '2026-11-22T10:00:00.000Z',
    blocks: [
      node('a-home', { title: 'Главная', path: '/' }, 'Кто мы', 3),
      node('b-services', { title: 'Услуги', up: 'a-home', goal: 'Выбрать' }, '', 4),
      node('c-prices', { title: 'Цены', up: 'a-home' }, '', 5),
    ],
  } as CabinetArtifact
}

function show(artifact: CabinetArtifact) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ArtifactSitemap
        artifact={artifact}
        presence={null}
        onChanged={vi.fn()}
        onAccessLost={vi.fn()}
        place="page"
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  write.mockClear()
  keep.mockClear()
  push.mockClear()
})

describe('«Структура сайта» in the cabinet', () => {
  it('shows the pages as an outline with their addresses, goals and actions', () => {
    show(site())
    const list = screen.getByRole('list', { name: sitemapTexts.pages })
    expect(
      within(list)
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual(['Главная /', 'Услуги /uslugiЦель: Выбрать', 'Цены /ceny'])
  })

  it('writes a page with its revision, keeping its parent', async () => {
    show(site())
    fireEvent.click(screen.getByRole('button', { name: /Услуги/ }))
    fireEvent.change(screen.getByRole('textbox', { name: sitemapTexts.action }), {
      target: { value: 'Узнать цену' },
    })
    fireEvent.click(screen.getByRole('button', { name: sitemapTexts.save }))
    await waitFor(() => expect(write).toHaveBeenCalled())
    expect(write.mock.calls[0]![0]).toMatchObject({
      batch: {
        ops: [
          {
            op: 'replace',
            block: 'b-services',
            ifRev: 4,
            props: { title: 'Услуги', goal: 'Выбрать', action: 'Узнать цену' },
          },
        ],
      },
    })
  })

  it('moves a page among its siblings, nests it in the one above and takes it out', async () => {
    show(site())
    fireEvent.click(screen.getByRole('button', { name: /Цены/ }))
    fireEvent.click(screen.getByRole('button', { name: sitemapTexts.up }))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect(write.mock.calls[0]![0]).toMatchObject({
      batch: { ops: [{ op: 'move', block: 'c-prices', ifRev: 5, after: 'a-home' }] },
    })
    fireEvent.click(screen.getByRole('button', { name: sitemapTexts.indent }))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(write.mock.calls[1]![0]).toMatchObject({
      batch: { ops: [{ op: 'props', block: 'c-prices', props: { up: 'b-services' } }] },
    })
    fireEvent.click(screen.getByRole('button', { name: sitemapTexts.outdent }))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(3))
    const props = (write.mock.calls[2]![0] as { batch: { ops: { props: object }[] } }).batch.ops[0]!
      .props
    expect(props).toEqual({ up: '' })
  })

  it('asks the agent for a site in a new chat, and lets a reader only look', async () => {
    show(site('view'))
    expect(screen.queryByRole('button', { name: sitemapTexts.add })).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: sitemapTexts.makeSite })).toBeEnabled(),
    )
    // The user is known once their query answered.
    await new Promise((resolve) => setTimeout(resolve, 0))
    fireEvent.click(screen.getByRole('button', { name: sitemapTexts.makeSite }))
    expect(push).toHaveBeenCalledWith('/chats/new')
    expect(keep).toHaveBeenCalledWith('user-1', expect.stringContaining(`@artifact:${ARTIFACT}`))
  })
})
