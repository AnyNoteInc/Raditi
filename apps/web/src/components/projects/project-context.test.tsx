// @vitest-environment jsdom
import { SANDBOX_PROJECT } from '@repo/domain'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Upload from '@/components/chat/attachment-upload'

import { ProjectContext } from './project-context'
import { ProjectCreateDialog } from './project-create-dialog'
import type { ProjectDetails } from './project-types'
import { CONTEXT_MENTION_ROOT } from './use-context-mentions'
import { chosenFiles, contextRefusal, droppedFiles } from './use-context-uploads'

const PROJECT_ID = '0199a3f2-0000-7000-8000-00000000c001'
const FILE = (n: number) => `0199a3f2-0000-7000-8000-0000000f000${n}`
const MIB = 1024 * 1024

const calls = vi.hoisted(() => ({
  list: vi.fn<(input: { projectId: string }) => Promise<unknown>>(),
  removeBound: vi.fn(async (input: { fileId: string }) => ({ fileId: input.fileId })),
  start: vi.fn(),
  bind: vi.fn(async () => ({ bound: 1 })),
  addText: vi.fn(),
  removeUnbound: vi.fn(async (input: { fileId: string }) => ({ fileId: input.fileId })),
  create: vi.fn(async (input: { projectId: string }) => ({ projectId: input.projectId })),
  upload: vi.fn(async (path: string) => ({ attachmentId: path.split('/').at(-1)!, size: 1 })),
}))

vi.mock('@/components/chat/attachment-upload', async (original) => ({
  ...(await original<typeof Upload>()),
  uploadBytes: calls.upload,
}))

vi.mock('@/trpc/client', async () => {
  const { repoTrpc } = await import('./testing/repo-trpc')
  return {
    useTRPC: () => ({
      ...repoTrpc(),
      project: {
        pathKey: () => ['project'],
        create: { mutationOptions: () => ({ mutationFn: calls.create }) },
      },
      projectFile: {
        pathKey: () => ['projectFile'],
        list: {
          queryOptions: (input: { projectId: string }) => ({
            queryKey: ['projectFile.list', input],
            queryFn: () => calls.list(input),
          }),
        },
        remove: { mutationOptions: () => ({ mutationFn: calls.removeBound }) },
      },
    }),
    useTRPCClient: () => ({
      projectFile: {
        start: { mutate: calls.start },
        bind: { mutate: calls.bind },
        addText: { mutate: calls.addText },
        remove: { mutate: calls.removeUnbound },
      },
    }),
  }
})

const at = new Date('2026-11-12T10:00:00Z')
const fileRow = (n: number, name: string, sizeBytes: number, kind: 'file' | 'text' = 'file') => ({
  id: FILE(n),
  projectId: PROJECT_ID,
  kind,
  name,
  mediaType: 'application/octet-stream',
  sizeBytes,
  status: 'ready' as const,
  createdAt: at,
})
const FILES = [
  fileRow(1, 'Брендбук.pdf', 6.1 * MIB),
  fileRow(2, 'Прайс зима 2026.xlsx', 84 * 1024),
  fileRow(3, 'Тексты о нас.md', 4 * 1024, 'text'),
  fileRow(4, 'Фото/витрина.jpg', 2.3 * MIB),
  fileRow(5, 'Меню.docx', 120 * 1024),
]
const BYTES = FILES.reduce((sum, file) => sum + file.sizeBytes, 0)

const kolos: ProjectDetails = {
  id: PROJECT_ID,
  name: 'Сайт пекарни «Колос»',
  goal: null,
  instructions: null,
  useAccountMemory: true,
  starred: false,
  archived: false,
  chats: 0,
  activityAt: at,
  createdAt: at,
  files: { count: FILES.length, bytes: BYTES, limitBytes: 100 * MIB, first: FILES },
  memory: { active: 0, proposed: 0 },
  repository: null,
}

function wrap(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

const fileOf = (name: string, bytes = 16, type = '') =>
  new File(['x'.repeat(bytes)], name, { type })

function choose(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  fireEvent.change(input)
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.list.mockResolvedValue({
    files: FILES,
    bytes: BYTES,
    limitBytes: 100 * MIB,
    percent: 9,
  })
  let n = 6
  calls.start.mockImplementation(async (input: { name: string }) => {
    const fileId = FILE(n++)
    return { fileId, name: input.name, uploadPath: `/api/project-files/${fileId}` }
  })
})
afterEach(cleanup)

describe('the rules of the browser before a file is sent (ПР8)', () => {
  it('refuses what the server would: empty, a type not on the list, too big, a deep path', () => {
    expect(contextRefusal({ path: 'Брендбук.pdf', size: 10 })).toBeNull()
    expect(contextRefusal({ path: 'src/app.tsx', size: 10 })).toBeNull()
    expect(contextRefusal({ path: 'Брендбук.pdf', size: 0 })).toBe('empty')
    expect(contextRefusal({ path: '.env', size: 10 })).toBe('type_not_allowed')
    expect(contextRefusal({ path: 'key.pem', size: 10 })).toBe('type_not_allowed')
    expect(contextRefusal({ path: 'big.pdf', size: 21 * MIB })).toBe('too_large')
    expect(contextRefusal({ path: 'a/b/c/d/e/f/g/h/i.md', size: 10 })).toBe('path_invalid')
  })

  it('keeps the folders of a folder chosen, the name of a file alone', () => {
    const lone = fileOf('Брендбук.pdf')
    const inFolder = fileOf('витрина.jpg')
    Object.defineProperty(inFolder, 'webkitRelativePath', { value: 'Фото/витрина.jpg' })
    expect(chosenFiles([lone, inFolder]).map((one) => one.path)).toEqual([
      'Брендбук.pdf',
      'Фото/витрина.jpg',
    ])
  })

  it('reads a dropped folder with its paths', async () => {
    const photo = fileOf('витрина.jpg')
    const entry = (name: string, fullPath: string, children?: unknown[]) =>
      children === undefined
        ? {
            isFile: true,
            isDirectory: false,
            name,
            fullPath,
            file: (done: (f: File) => void) => done(photo),
          }
        : {
            isFile: false,
            isDirectory: true,
            name,
            fullPath,
            createReader: () => {
              let given = false
              return {
                readEntries: (done: (entries: unknown[]) => void) => {
                  done(given ? [] : children)
                  given = true
                },
              }
            },
          }
    const folder = entry('Фото', '/Фото', [entry('витрина.jpg', '/Фото/витрина.jpg')])
    const data = {
      items: [{ webkitGetAsEntry: () => folder }],
      files: [],
    } as unknown as DataTransfer
    const files = await droppedFiles(data)
    expect(files.map((one) => one.path)).toEqual(['Фото/витрина.jpg'])
  })

  it('puts `@` where the files lie in the sandbox (ПР24)', () => {
    expect(CONTEXT_MENTION_ROOT).toBe(`${SANDBOX_PROJECT}/`)
  })
})

describe('«Контекст» of the page of a project (P-project, P-context)', () => {
  it('names the first three files, the rest by number, and the room taken', () => {
    wrap(<ProjectContext project={kolos} />)
    const row = screen.getByRole('region', { name: 'Контекст' })
    expect(within(row).getByText('Брендбук.pdf')).toBeTruthy()
    expect(within(row).getByText('Прайс зима 2026.xlsx')).toBeTruthy()
    // A text the client wrote is read without its `.md`.
    expect(within(row).getByText('Тексты о нас')).toBeTruthy()
    expect(within(row).getByText('Текст · 4 КБ')).toBeTruthy()
    expect(within(row).queryByText('Фото/витрина.jpg')).toBeNull()
    expect(within(row).getByText('и ещё 2 файла')).toBeTruthy()
    expect(within(row).getByText('Занято 9 % места')).toBeTruthy()
  })

  it('opens the window: what the agent sees, the room, the files to download and to remove', async () => {
    wrap(<ProjectContext project={kolos} />)
    fireEvent.click(screen.getByRole('button', { name: 'Открыть контекст проекта' }))
    const dialog = await screen.findByRole('dialog', { name: 'Контекст' })
    expect(within(dialog).getByText(/Картинки он не видит/)).toBeTruthy()
    await within(dialog).findByText('Брендбук.pdf')
    expect(within(dialog).getByText('Занято 9 % места · 9 из 100 МБ')).toBeTruthy()
    expect(within(dialog).getByRole('heading', { name: /Файлы и тексты.*5/ })).toBeTruthy()
    expect(
      within(dialog).getByRole('link', { name: 'Скачать «Брендбук.pdf»' }).getAttribute('href'),
    ).toBe(`/api/project-files/${FILE(1)}`)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Убрать «Тексты о нас»' }))
    await waitFor(() =>
      expect(calls.removeBound).toHaveBeenCalledWith(
        { projectId: PROJECT_ID, fileId: FILE(3) },
        expect.anything(),
      ),
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Готово' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Контекст' })).toBeNull())
  })

  it('uploads a file for the project and lets the project take it at once', async () => {
    const { container } = wrap(<ProjectContext project={kolos} />)
    fireEvent.click(screen.getByRole('button', { name: 'Добавить в контекст проекта' }))
    const menu = await screen.findByRole('menu', { name: 'Добавить в контекст' })
    // A link and GitLab since 84.17; the GitHub App is Э10: «Скоро».
    for (const name of [/Ссылка на GitHub/, /Подключить GitLab/])
      expect(within(menu).getByRole('menuitem', { name }).getAttribute('aria-disabled')).toBeNull()
    expect(
      within(menu)
        .getByRole('menuitem', { name: /Подключить GitHub/ })
        .getAttribute('aria-disabled'),
    ).toBe('true')
    expect(within(menu).getByText('Файлы до 20 МБ, всего до 100 МБ на проект')).toBeTruthy()
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Загрузить с устройства/ }))
    const device = await screen.findByRole('menu', { name: 'Загрузить с устройства' })
    expect(within(device).getByRole('menuitem', { name: 'Папку…' })).toBeTruthy()
    fireEvent.click(within(device).getByRole('menuitem', { name: 'Файлы…' }))
    choose(container.querySelector('input[data-context-files]')!, [fileOf('Прайс весна.xlsx')])
    await waitFor(() => expect(calls.bind).toHaveBeenCalled())
    expect(calls.start).toHaveBeenCalledWith({
      name: 'Прайс весна.xlsx',
      size: 16,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      projectId: PROJECT_ID,
    })
    expect(calls.upload).toHaveBeenCalledWith(
      `/api/project-files/${FILE(6)}`,
      expect.any(File),
      expect.anything(),
    )
    expect(calls.bind).toHaveBeenCalledWith({ projectId: PROJECT_ID, fileIds: [FILE(6)] })
  })

  it('refuses a file the rules refuse before anything is sent', async () => {
    const { container } = wrap(<ProjectContext project={kolos} />)
    choose(container.querySelector('input[data-context-files]')!, [fileOf('.env')])
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Такой файл в проект добавить нельзя',
    )
    expect(calls.start).not.toHaveBeenCalled()
  })

  it('adds a text, and keeps the window with the words when the server sees a secret', async () => {
    calls.addText
      .mockRejectedValueOnce({
        message:
          'Похоже, в тексте пароль или ключ — уберите его: агент получает этот текст в каждом чате',
        data: { code: 'BAD_REQUEST', domainCode: 'PROJECT_TEXT_HAS_SECRET' },
      })
      .mockResolvedValueOnce({ fileId: FILE(7), name: 'Ответы на отзывы.md' })
    wrap(<ProjectContext project={kolos} />)
    fireEvent.click(screen.getByRole('button', { name: 'Добавить в контекст проекта' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Добавить текстовое содержимое' }))
    const dialog = await screen.findByRole('dialog', { name: 'Добавить текстовое содержимое' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Название/ }), {
      target: { value: 'Ответы на отзывы' },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Текст/ }), {
      target: { value: 'Пароль: 7hd8Qk2' },
    })
    expect(within(dialog).getByText('15 из 100 000')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Похоже, в тексте пароль или ключ — уберите его',
    )
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Текст/ }), {
      target: { value: 'Отвечаем в течение суток.' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Добавить текстовое содержимое' })).toBeNull(),
    )
    expect(calls.addText).toHaveBeenLastCalledWith({
      title: 'Ответы на отзывы',
      text: 'Отвечаем в течение суток.',
      projectId: PROJECT_ID,
    })
  })
})

describe('«Контекст» of a new project (P-create, P-create-menu)', () => {
  function showCreate() {
    const onCreated = vi.fn()
    const onClose = vi.fn()
    const view = wrap(<ProjectCreateDialog open onClose={onClose} onCreated={onCreated} />)
    return { ...view, onCreated, onClose }
  }

  it('uploads before the project exists and creates it with its files in one call', async () => {
    calls.addText.mockResolvedValueOnce({ fileId: FILE(9), name: 'Тексты о нас.md' })
    const { container, onCreated } = showCreate()
    const dialog = screen.getByRole('dialog', { name: 'Создание проекта' })
    expect(within(dialog).getByRole('group', { name: 'Контекст' })).toBeTruthy()
    choose(container.ownerDocument.querySelector('input[data-context-files]')!, [
      fileOf('Брендбук.pdf', 16, 'application/pdf'),
    ])
    await waitFor(() => expect(calls.upload).toHaveBeenCalled())
    // A file of a project not created yet is announced without one, and nothing binds it.
    expect(calls.start).toHaveBeenCalledWith({
      name: 'Брендбук.pdf',
      size: 16,
      type: 'application/pdf',
    })
    expect(await within(dialog).findByText('PDF · 16 байт')).toBeTruthy()
    expect(calls.bind).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить контекст' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Добавить текстовое содержимое' }))
    const text = await screen.findByRole('dialog', { name: 'Добавить текстовое содержимое' })
    fireEvent.change(within(text).getByRole('textbox', { name: /Название/ }), {
      target: { value: 'Тексты о нас' },
    })
    fireEvent.change(within(text).getByRole('textbox', { name: /Текст/ }), {
      target: { value: 'Пекарня с 1998 года.' },
    })
    fireEvent.click(within(text).getByRole('button', { name: 'Добавить' }))
    expect(await within(dialog).findByText('Тексты о нас')).toBeTruthy()
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Добавить текстовое содержимое' })).toBeNull(),
    )
    expect(calls.addText).toHaveBeenCalledWith({
      title: 'Тексты о нас',
      text: 'Пекарня с 1998 года.',
    })
    // The text's window submitted its own form, not this one.
    expect(calls.create).not.toHaveBeenCalled()

    fireEvent.change(await within(dialog).findByRole('textbox', { name: /Над чем вы работаете/ }), {
      target: { value: 'Сайт пекарни' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать проект' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(calls.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Сайт пекарни', fileIds: [FILE(6), FILE(9)] }),
      expect.anything(),
    )
  })

  it('removes the files it uploaded when a file is taken out', async () => {
    const { container } = showCreate()
    choose(container.ownerDocument.querySelector('input[data-context-files]')!, [
      fileOf('Брендбук.pdf', 16, 'application/pdf'),
    ])
    const dialog = screen.getByRole('dialog', { name: 'Создание проекта' })
    await within(dialog).findByText('PDF · 16 байт')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Убрать «Брендбук.pdf»' }))
    expect(calls.removeUnbound).toHaveBeenCalledWith({ projectId: null, fileId: FILE(6) })
    expect(within(dialog).queryByText('Брендбук.pdf')).toBeNull()
  })
})
