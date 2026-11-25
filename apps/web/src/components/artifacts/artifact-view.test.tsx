// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactTrashNotice } from './artifact-trash-notice'
import { ArtifactView } from './artifact-view'
import type { CabinetArtifact } from './use-artifact'

// The head of the page of an artifact (docs/plan/93-artifacts-trim.md, АТ9): back, the title and
// «Сохранено · изменено …» without versions; «Попросить агента» closed until asked; «Заметки · N»
// only with notes; «Опубликовать», «Поделиться» and the rest in «⋯»; «В корзину» asks nothing and
// the gallery offers «Вернуть».

const ID = '019f1a21-1800-7f00-8abc-000000000001'

const calls = vi.hoisted(() => ({
  push: vi.fn(),
  trash: vi.fn(async (_input: unknown) => ({ trashed: true })),
  restore: vi.fn(async (_input: unknown) => ({ restored: true })),
  create: vi.fn(async (_input: unknown) => ({ taskId: 'x' })),
  comments: vi.fn<() => Promise<unknown[]>>(async () => []),
  role: { value: 'owner' as CabinetArtifact['role'] },
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: calls.push }) }))

vi.mock('./artifact-body', () => ({
  ArtifactBody: () => <p>Текст документа</p>,
  artifactBodyWide: () => false,
}))

const artifact = (): CabinetArtifact =>
  ({
    id: ID,
    kind: 'document',
    title: 'Правила возврата',
    seq: 3,
    role: calls.role.value,
    version: 12,
    project: { id: '019f1a21-1800-7f00-8abc-0000000000b1', name: 'Пекарня' },
    updatedAt: '2026-11-25T11:02:00.000Z',
    blocks: [
      {
        key: 'a',
        kind: 'section',
        parent: null,
        props: {},
        rank: '00a',
        rev: 1,
        heading: 'Сроки',
        content: '14 дней.',
        checking: false,
        hold: null,
      },
    ],
  }) as unknown as CabinetArtifact

vi.mock('./use-artifact', () => ({
  useArtifact: () => ({
    read: { isPending: false, data: artifact() },
    accessLost: false,
    presence: null,
    reread: vi.fn(),
    discardAccess: vi.fn(),
  }),
}))

vi.mock('@/trpc/client', () => {
  const query = (path: string, fn: () => Promise<unknown>) => ({
    queryKey: (input?: unknown) => [path, input],
    queryOptions: (input: unknown) => ({ queryKey: [path, input], queryFn: fn }),
    pathKey: () => [path],
  })
  const mutation = (fn: (input: never) => Promise<unknown>) => ({
    mutationOptions: () => ({ mutationFn: fn }),
  })
  const trpc = {
    artifact: {
      comments: query('comments', () => calls.comments()),
      chats: query('chats', async () => []),
      versions: query('versions', async () => []),
      shareState: query('shareState', async () => ({
        link: null,
        people: [],
        invites: [],
        copyAllowed: false,
      })),
      shareMine: query('shareMine', async () => ({ copyAllowed: false })),
      list: query('list', async () => []),
      trash: mutation(calls.trash),
      restore: mutation(calls.restore),
      shareCopy: mutation(vi.fn()),
      shareLeave: mutation(vi.fn()),
      shareLink: mutation(vi.fn()),
      shareRevoke: mutation(vi.fn()),
      shareInvite: mutation(vi.fn()),
      shareInviteRevoke: mutation(vi.fn()),
      shareSetRole: mutation(vi.fn()),
      shareRemove: mutation(vi.fn()),
      shareCloseAll: mutation(vi.fn()),
      shareSetCopy: mutation(vi.fn()),
      write: mutation(vi.fn()),
      move: mutation(vi.fn()),
    },
    project: { list: query('projects', async () => ({ items: [] })) },
    pages: {
      artifactPublication: query('publication', async () => null),
      publishArtifact: mutation(vi.fn()),
    },
    task: {
      create: mutation(calls.create),
      message: mutation(vi.fn()),
      get: query('task', async () => ({ status: 'running' })),
    },
  }
  return { useTRPC: () => trpc }
})

function show(sharing = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ArtifactView artifactId={ID} sharing={sharing} />
      <ArtifactTrashNotice />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.role.value = 'owner'
  calls.comments.mockResolvedValue([])
})

describe('the head of an artifact (АТ9)', () => {
  it('is one calm row: back, the title, «Сохранено · изменено …» and a few actions', async () => {
    show()
    const head = screen.getByRole('banner')
    expect(within(head).getByRole('link', { name: 'Все артефакты' })).toBeTruthy()
    expect(within(head).getByRole('heading', { name: /Правила возврата/ })).toBeTruthy()
    expect(within(head).getByText(/^Пекарня · Сохранено · изменено /)).toBeTruthy()
    expect(within(head).queryByText(/версия/)).toBeNull()
    expect(within(head).getByRole('button', { name: 'История версий' })).toBeTruthy()
    expect(within(head).getByRole('button', { name: 'Опубликовать' })).toBeTruthy()
    expect(within(head).getByRole('button', { name: 'Поделиться' })).toBeTruthy()
    expect(within(head).getByRole('button', { name: 'Ещё' })).toBeTruthy()
    // Rare actions are not in the row.
    expect(within(head).queryByRole('button', { name: /Перенести|В корзину/ })).toBeNull()
  })

  it('keeps the rest in «⋯», and «В корзину» asks nothing: the gallery offers «Вернуть»', async () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Перенести в проект' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Скачать в формате Markdown' })).toBeTruthy()
    expect(within(menu).queryByRole('menuitem', { name: 'Покинуть' })).toBeNull()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'В корзину' }))
    await waitFor(() => expect(calls.push).toHaveBeenCalledWith('/artifacts'))
    expect(calls.trash).toHaveBeenCalledWith({ artifactId: ID }, expect.anything())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(await screen.findByText('Перемещено в корзину')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть' }))
    await waitFor(() =>
      expect(calls.restore).toHaveBeenCalledWith({ artifactId: ID }, expect.anything()),
    )
    expect(await screen.findByText('«Правила возврата» снова в списке.')).toBeTruthy()
  })

  it('opens «Перенести в проект» from «⋯»', async () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Перенести в проект' }))
    expect(await screen.findByRole('dialog', { name: 'Перенести в проект' })).toBeTruthy()
  })

  it('offers a recipient «Покинуть», and no «Поделиться» or «В корзину»', async () => {
    calls.role.value = 'view'
    show()
    expect(screen.queryByRole('button', { name: 'Поделиться' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Опубликовать' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Покинуть' })).toBeTruthy()
    expect(within(menu).queryByRole('menuitem', { name: 'В корзину' })).toBeNull()
  })

  it('shows «Заметки · N» only when there are notes', async () => {
    show()
    await waitFor(() => expect(calls.comments).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /заметки/ })).toBeNull()
  })

  it('counts the open notes in «Заметки · N», which shows and hides them', async () => {
    calls.comments.mockResolvedValue([
      { id: 'a', resolved: false },
      { id: 'b', resolved: true },
    ])
    show()
    const chip = await screen.findByRole('button', { name: 'Показать заметки: открытых 1' })
    expect(chip.textContent).toBe('Заметки · 1')
    fireEvent.click(chip)
    expect(screen.getByRole('button', { name: 'Скрыть заметки: открытых 1' })).toBeTruthy()
  })

  it('keeps «Попросить агента» closed until asked, then sends the request with the artifact', async () => {
    show()
    expect(screen.queryByRole('textbox', { name: 'Что сделать?' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Попросить агента' }))
    const field = await screen.findByRole('textbox', { name: 'Что сделать?' })
    fireEvent.change(field, { target: { value: 'Добавьте раздел про обмен' } })
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    await waitFor(() => expect(calls.create).toHaveBeenCalled())
    expect(calls.create.mock.calls[0]![0]).toMatchObject({
      text: `@artifact:${ID} Добавьте раздел про обмен`,
      projectId: '019f1a21-1800-7f00-8abc-0000000000b1',
    })
    expect(await screen.findByText('Агент работает — правки появятся здесь сами.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Открыть чат' })).toBeTruthy()
  })
})
