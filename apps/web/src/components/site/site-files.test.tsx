// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SITE_ID } from '@/components/chat/testing'

import { SiteFiles } from './site-files'

// «Терминал» of a project (owner's request of 06.11.2026): the files of the version the site has,
// a tree and the file chosen beside it, read only.

type ListAnswer =
  | { state: 'none' | 'preparing' }
  | {
      state: 'ready'
      version: string | null
      truncated: boolean
      files: Array<{ path: string; size: number }>
    }
type FileAnswer =
  | { state: 'none' | 'preparing' | 'missing' | 'binary' | 'too_large' }
  | { state: 'ready'; text: string }

const calls = vi.hoisted(() => ({
  list: vi.fn<(input: { siteId: string }) => Promise<ListAnswer>>(),
  read: vi.fn<(input: { siteId: string; path: string }) => Promise<FileAnswer>>(),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    siteFiles: {
      list: {
        queryOptions: (input: { siteId: string }) => ({
          queryKey: ['siteFiles.list', input],
          queryFn: () => calls.list(input),
        }),
      },
      read: {
        queryOptions: (input: { siteId: string; path: string }) => ({
          queryKey: ['siteFiles.read', input],
          queryFn: () => calls.read(input),
        }),
      },
    },
  }),
}))

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <SiteFiles siteId={SITE_ID} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  calls.list.mockReset()
  calls.read.mockReset()
})

describe('«Терминал» of a project', () => {
  it('shows the tree of the version and a file chosen in it, with its lines', async () => {
    calls.list.mockResolvedValue({
      state: 'ready',
      version: 'v0.0.3',
      truncated: false,
      files: [
        { path: 'index.php', size: 40 },
        { path: 'wp-content/themes/kadence/style.css', size: 20 },
      ],
    })
    calls.read.mockResolvedValue({ state: 'ready', text: 'body {\n  color: red;\n}\n' })
    show()
    expect(await screen.findByText(/Файлы версии v0\.0\.3, которая сейчас на сайте/)).toBeTruthy()
    const tree = screen.getByRole('navigation', { name: 'Файлы проекта' })
    expect(within(tree).getByText('2 файла')).toBeTruthy()
    expect(screen.getByText('Выберите файл в списке, чтобы посмотреть его.')).toBeTruthy()
    // Folders open one level at a time.
    expect(within(tree).queryByText('themes')).toBeNull()
    fireEvent.click(within(tree).getByRole('button', { name: /wp-content/ }))
    fireEvent.click(within(tree).getByRole('button', { name: /themes/ }))
    fireEvent.click(within(tree).getByRole('button', { name: /kadence/ }))
    fireEvent.click(within(tree).getByRole('button', { name: 'style.css' }))
    const view = await screen.findByRole('region', { name: 'wp-content/themes/kadence/style.css' })
    expect(await within(view).findByText('color: red;', { exact: false })).toBeTruthy()
    expect(within(view).getByText(/3 строки/)).toBeTruthy()
    expect(calls.read).toHaveBeenCalledWith({
      siteId: SITE_ID,
      path: 'wp-content/themes/kadence/style.css',
    })
  })

  it('says why a file is not shown', async () => {
    calls.list.mockResolvedValue({
      state: 'ready',
      version: null,
      truncated: false,
      files: [{ path: 'logo.png', size: 400 }],
    })
    calls.read.mockResolvedValue({ state: 'binary' })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'logo.png' }))
    expect(
      await screen.findByText('Это не текстовый файл — показать его здесь нельзя.'),
    ).toBeTruthy()
  })

  it('says a project without files in a repository has none, and waits while core reads them', async () => {
    calls.list.mockResolvedValueOnce({ state: 'none' })
    show()
    expect(
      await screen.findByText(
        'У этого проекта нет файлов в репозитории: он подключён без доступа к файлам.',
      ),
    ).toBeTruthy()
  })

  it('says the list is being prepared while core reads it', async () => {
    calls.list.mockResolvedValue({ state: 'preparing' })
    show()
    expect((await screen.findByRole('status')).textContent).toBe('Готовим список файлов…')
  })
})
