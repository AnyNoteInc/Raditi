// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SITE_ID } from '@/components/chat/testing'

import { SiteFiles } from './site-files'

// «Терминал» of a project (owner's request of 06.11.2026): the files of the version the site has,
// a tree and the file chosen beside it, read only.

type ListAnswer =
  | { state: 'none' | 'preparing' }
  | {
      state: 'ready'
      sha: string
      version: string | null
      changed: boolean
      truncated: boolean
      files: Array<{ path: string; size: number }>
    }
type FileAnswer =
  | { state: 'none' | 'preparing' | 'missing' | 'binary' | 'too_large' }
  | { state: 'ready'; text: string }

const calls = vi.hoisted(() => ({
  list: vi.fn<(input: { siteId: string; taskId?: string }) => Promise<ListAnswer>>(),
  read: vi.fn<(input: { siteId: string; path: string }) => Promise<FileAnswer>>(),
  save: vi.fn<(input: Record<string, string>) => Promise<{ editId: string }>>(),
  editState:
    vi.fn<
      (input: Record<string, string>) => Promise<{ state: string; revision?: number | null }>
    >(),
  chats: vi.fn<() => Promise<{ items: Array<{ id: string; title: string; status: string }> }>>(),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    siteFiles: {
      list: {
        queryOptions: (input: { siteId: string }) => ({
          queryKey: ['siteFiles.list', input],
          queryFn: () => calls.list(input),
        }),
        queryKey: () => ['siteFiles.list'],
      },
      read: {
        queryOptions: (input: { siteId: string; path: string }) => ({
          queryKey: ['siteFiles.read', input],
          queryFn: () => calls.read(input),
        }),
      },
      save: {
        mutationOptions: () => ({
          mutationFn: (input: Record<string, string>) => calls.save(input),
        }),
      },
      editState: {
        queryOptions: (input: Record<string, string>) => ({
          queryKey: ['siteFiles.editState', input],
          queryFn: () => calls.editState(input),
        }),
      },
    },
    task: {
      list: {
        queryOptions: (input: unknown) => ({
          queryKey: ['task.list', input],
          queryFn: () => calls.chats(),
        }),
      },
    },
  }),
}))

const TASK_ID = '0199a3f2-0000-7000-8000-0000000000c1'
const SHA = 'b'.repeat(40)

function show(props: { taskId?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <SiteFiles siteId={SITE_ID} {...props} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  for (const call of Object.values(calls)) call.mockReset()
})

describe('«Терминал» of a project', () => {
  it('shows the tree of the version and a file chosen in it, with its lines', async () => {
    calls.list.mockResolvedValue({
      state: 'ready',
      sha: SHA,
      version: 'v0.0.3',
      changed: false,
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
      sha: SHA,
      path: 'wp-content/themes/kadence/style.css',
    })
  })

  it('says why a file is not shown', async () => {
    calls.list.mockResolvedValue({
      state: 'ready',
      sha: SHA,
      version: null,
      changed: false,
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

  // The owner, 06.11.2026: «нужно предусмотреть возможность править файлы, при сохранении файл
  // должен сохраняться в агента, а потом по возможности комититься в гит».
  it('saves an edit of a file of the chat into the chat and says what came of it', async () => {
    calls.list.mockResolvedValue({
      state: 'ready',
      sha: SHA,
      version: 'v0.0.3',
      changed: true,
      truncated: false,
      files: [{ path: 'index.php', size: 10 }],
    })
    calls.read.mockResolvedValue({ state: 'ready', text: '<?php echo 1;\n' })
    calls.save.mockResolvedValue({ editId: '0199a3f2-0000-7000-8000-0000000000e1' })
    calls.editState.mockResolvedValue({ state: 'saved', revision: 2 })
    show({ taskId: TASK_ID })
    expect(await screen.findByText(/Рабочая копия агента/)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'index.php' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }))
    const editor = screen.getByRole('textbox', { name: 'Текст файла index.php' })
    fireEvent.change(editor, { target: { value: '<?php echo 2;\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByText(/Сохранено в чате: агент продолжит с этим файлом/)).toBeTruthy()
    expect(calls.save).toHaveBeenCalledWith({
      siteId: SITE_ID,
      taskId: TASK_ID,
      path: 'index.php',
      baseSha: SHA,
      text: '<?php echo 2;\n',
    })
    expect(calls.list).toHaveBeenCalledWith({ siteId: SITE_ID, taskId: TASK_ID })
  })

  it('saves an edit of a project into the open chat the client chooses', async () => {
    calls.list.mockResolvedValue({
      state: 'ready',
      sha: SHA,
      version: 'v0.0.3',
      changed: false,
      truncated: false,
      files: [{ path: 'index.php', size: 10 }],
    })
    calls.read.mockResolvedValue({ state: 'ready', text: 'a\n' })
    calls.chats.mockResolvedValue({
      items: [
        { id: TASK_ID, title: 'Поменять подвал', status: 'awaiting_user' },
        { id: '0199a3f2-0000-7000-8000-0000000000c2', title: 'Старый', status: 'done' },
      ],
    })
    calls.save.mockResolvedValue({ editId: '0199a3f2-0000-7000-8000-0000000000e2' })
    calls.editState.mockResolvedValue({ state: 'conflict', revision: null })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'index.php' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }))
    const saveTo = await screen.findByRole<HTMLButtonElement>('button', { name: 'Сохранить в чат' })
    // The open chats of the project come first.
    await waitFor(() => expect(saveTo.disabled).toBe(false))
    fireEvent.click(saveTo)
    expect(await screen.findByText(/Не сохранено: агент изменил этот файл/)).toBeTruthy()
    // A closed chat takes no edit: the first open one is chosen.
    expect(calls.save).toHaveBeenCalledWith(expect.objectContaining({ taskId: TASK_ID }))
  })
})
