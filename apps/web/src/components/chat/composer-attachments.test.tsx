// @vitest-environment jsdom
import { attachmentLimits } from '@repo/domain/attachments/rules'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { UploadFailure, type UploadBytes } from './attachment-upload'
import { Composer } from './composer'
import { SITE_ID } from './testing'
import { useAttachments } from './use-attachments'

// The files of a message (docs/plan/57-browser-tasks.md, Б26): chosen, announced, sent one at a
// time with their progress; a failure can be sent again, a file taken out; the message waits for
// its files and names the ready ones.

const FIRST_ID = '0199a3f2-0000-7000-8000-0000000000f1'
const SECOND_ID = '0199a3f2-0000-7000-8000-0000000000f2'

const calls = vi.hoisted(() => ({
  start: vi.fn<
    (input: { siteId: string; name: string; size: number; type: string }) => Promise<{
      attachmentId: string
      uploadPath: string
    }>
  >(),
  remove: vi.fn(async (input: { attachmentId: string }) => input),
}))

vi.mock('@/trpc/client', () => ({
  useTRPCClient: () => ({
    attachment: { start: { mutate: calls.start }, remove: { mutate: calls.remove } },
  }),
}))

/** An upload the test finishes by hand, with its progress. */
function controlledUpload() {
  const pending: Array<{
    path: string
    progress: (fraction: number) => void
    resolve: () => void
    reject: (error: unknown) => void
  }> = []
  const upload: UploadBytes = (path, _file, { onProgress, signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      pending.push({
        path,
        progress: onProgress,
        resolve: () => resolve({ attachmentId: path.split('/').at(-1)!, size: 1 }),
        reject,
      })
    })
  return { upload, pending }
}

function Harness({
  upload,
  onSend,
}: {
  upload: UploadBytes
  onSend: (text: string, ids: readonly string[]) => Promise<boolean>
}) {
  const attachments = useAttachments(SITE_ID, upload)
  return <Composer placeholder="Ваш ответ" onSend={onSend} attachments={attachments} />
}

const field = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Сообщение' })
const sendButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Отправить' })
const files = () => screen.getByRole('list', { name: 'Файлы к сообщению' })
const choose = (...chosen: File[]) =>
  fireEvent.change(screen.getByTestId('composer-files'), { target: { files: chosen } })
const jpeg = (name: string, size = 2_100_000) =>
  new File([new Uint8Array(Math.min(size, 16))], name, { type: 'image/jpeg' })
const sized = (file: File, size: number) => {
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function show() {
  const stand = controlledUpload()
  const onSend = vi.fn(async () => true)
  render(<Harness upload={stand.upload} onSend={onSend} />)
  return { ...stand, onSend }
}

beforeEach(() => {
  vi.clearAllMocks()
  let next = 0
  calls.start.mockImplementation(async () => {
    const id = [FIRST_ID, SECOND_ID][next++] ?? SECOND_ID
    return { attachmentId: id, uploadPath: `/api/attachments/${id}` }
  })
})

describe('files of a message', () => {
  it('opens the files of the system from its button, with the allowed types', () => {
    show()
    const input = screen.getByTestId<HTMLInputElement>('composer-files')
    expect(input.multiple).toBe(true)
    expect(input.accept).toContain('.pdf')
    expect(input.accept).toContain('image/jpeg')
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'Прикрепить файлы' }))
    expect(click).toHaveBeenCalled()
  })

  it('shows the progress of each file and keeps the message until they are sent', async () => {
    const { pending, onSend } = show()
    fireEvent.change(field(), { target: { value: 'Обложку возьмите эту' } })
    choose(sized(jpeg('oblozhka.jpg'), 2_100_000), sized(jpeg('veranda.jpg'), 1_900_000))
    await waitFor(() => expect(pending).toHaveLength(1))
    expect(calls.start).toHaveBeenCalledWith({
      siteId: SITE_ID,
      name: 'oblozhka.jpg',
      size: 2_100_000,
      type: 'image/jpeg',
    })
    expect(pending[0]!.path).toBe(`/api/attachments/${FIRST_ID}`)
    act(() => pending[0]!.progress(0.64))
    const progress = within(files()).getByRole('progressbar', { name: 'Загрузка oblozhka.jpg' })
    expect(progress.getAttribute('aria-valuenow')).toBe('64')
    expect(within(files()).getByText('Загружаем… 64 %')).toBeTruthy()
    // One at a time: the second waits for the first.
    expect(calls.start).toHaveBeenCalledTimes(1)
    expect(sendButton().disabled).toBe(true)
    expect(screen.getByText('Дождитесь загрузки файлов')).toBeTruthy()
    await act(async () => pending[0]!.resolve())
    await waitFor(() => expect(pending).toHaveLength(2))
    await act(async () => pending[1]!.resolve())
    await waitFor(() => expect(sendButton().disabled).toBe(false))
    expect(within(files()).getByText('2 МБ')).toBeTruthy()
    fireEvent.click(sendButton())
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('Обложку возьмите эту', [FIRST_ID, SECOND_ID]),
    )
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Файлы к сообщению' })).toBeNull(),
    )
  })

  it('says why a file failed, sends it again on «Повторить», and blocks the message meanwhile', async () => {
    const { pending } = show()
    fireEvent.change(field(), { target: { value: 'Меню во вложении' } })
    choose(new File(['%PDF-1.7'], 'menu.pdf', { type: 'application/pdf' }))
    await waitFor(() => expect(pending).toHaveLength(1))
    await act(async () =>
      pending[0]!.reject(
        new UploadFailure('Файл повреждён или не соответствует своему расширению.', 422),
      ),
    )
    const alert = await within(files()).findByRole('alert')
    expect(alert.textContent).toContain('Файл повреждён')
    expect(sendButton().disabled).toBe(true)
    expect(screen.getByText('Повторите или уберите файлы, которые не загрузились')).toBeTruthy()
    fireEvent.click(within(files()).getByRole('button', { name: 'Повторить загрузку menu.pdf' }))
    // The announcement of the failed try is removed; the file is announced anew.
    await waitFor(() => expect(calls.remove).toHaveBeenCalledWith({ attachmentId: FIRST_ID }))
    await waitFor(() => expect(pending).toHaveLength(2))
    expect(calls.start).toHaveBeenCalledTimes(2)
  })

  it('takes a file out, cancelling its upload and the announcement', async () => {
    const { pending } = show()
    choose(jpeg('veranda.jpg'))
    await waitFor(() => expect(pending).toHaveLength(1))
    fireEvent.click(within(files()).getByRole('button', { name: 'Отменить загрузку veranda.jpg' }))
    expect(screen.queryByRole('list', { name: 'Файлы к сообщению' })).toBeNull()
    await waitFor(() => expect(calls.remove).toHaveBeenCalledWith({ attachmentId: FIRST_ID }))
  })

  it('refuses a file of another type or too large before sending anything', async () => {
    show()
    choose(
      new File(['MZ'], 'setup.exe', { type: 'application/octet-stream' }),
      sized(jpeg('big.jpg'), attachmentLimits.fileBytes + 1),
    )
    const alerts = await within(files()).findAllByRole('alert')
    expect(alerts[0]!.textContent).toContain('Такой файл прикрепить нельзя')
    expect(alerts[1]!.textContent).toContain('Файл больше 20 МБ')
    expect(calls.start).not.toHaveBeenCalled()
    // A file the rules refuse is not sent again: only taken out.
    fireEvent.click(within(files()).getByRole('button', { name: 'Повторить загрузку setup.exe' }))
    expect(calls.start).not.toHaveBeenCalled()
    fireEvent.click(within(files()).getByRole('button', { name: 'Убрать setup.exe' }))
    expect(within(files()).queryByText('setup.exe')).toBeNull()
  })

  it('takes at most ten files for a message and says so', async () => {
    show()
    choose(...Array.from({ length: 11 }, (_, index) => jpeg(`photo-${index}.jpg`)))
    expect(within(files()).getAllByRole('listitem')).toHaveLength(10)
    expect(
      screen.getByText('К одному сообщению можно прикрепить не больше 10 файлов.'),
    ).toBeTruthy()
  })
})
