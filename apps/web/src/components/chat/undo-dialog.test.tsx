// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { serverRefusal } from '@/components/billing/testing'

import type { ReadyUndoPlan, UndoPlanAnswer } from './chat-types'
import { UndoDialog, undoFileLines } from './undo-dialog'
import { RELEASE_ID, TASK_ID } from './testing'

type ConfirmInput = {
  taskId: string
  releaseId: string
  confirmToken: string
  version: string
  reviewed?: boolean
}
type Confirmed = {
  undoId: string
  status: 'approved' | 'installed' | 'failed'
  version: string
  repeated: boolean
}

const PLAN_ID = '0199a3f2-0000-7000-8000-0000000000f1'

const { prepareUndo, planOf, confirm } = vi.hoisted(() => ({
  prepareUndo:
    vi.fn<(input: { taskId: string; releaseId: string }) => Promise<{ planId: string }>>(),
  planOf:
    vi.fn<
      (input: { taskId: string; releaseId: string; planId: string }) => Promise<UndoPlanAnswer>
    >(),
  confirm: vi.fn<(input: ConfirmInput) => Promise<Confirmed>>(),
}))

vi.mock('@/trpc/client', () => ({
  useTRPCClient: () => ({
    release: { undoPrepare: { mutate: prepareUndo }, undoPlan: { query: planOf } },
  }),
  useTRPC: () => ({
    release: {
      undoConfirm: {
        mutationOptions: (options: UseMutationOptions<Confirmed, Error, ConfirmInput>) => ({
          ...options,
          mutationFn: confirm,
        }),
      },
    },
  }),
}))

function ready(patch: Partial<ReadyUndoPlan> = {}): ReadyUndoPlan {
  return {
    state: 'ready',
    planId: PLAN_ID,
    releaseId: RELEASE_ID,
    undoneVersion: 'v1.4.0',
    returnsTo: 'v1.3.0',
    version: 'v1.4.1',
    until: new Date('2026-10-25T11:30:00.000Z'),
    files: {
      back: 1,
      removed: 1,
      restored: 0,
      mediaKept: 2,
      paths: [
        { path: 'wp-content/themes/cafe/header.php', change: 'back' },
        { path: 'wp-content/themes/cafe/promo.css', change: 'removed' },
      ],
      more: 0,
    },
    records: [
      {
        objectType: 'page',
        objectId: '42',
        verdict: 'return',
        text: 'Страница 42: вернём заголовок',
      },
      {
        objectType: 'option',
        objectId: 'blogdescription',
        verdict: 'changed',
        text: 'Настройка сайта: не вернём — её изменили на сайте после выпуска',
      },
    ],
    nothingToUndo: false,
    review: false,
    confirmToken: 'undo-token',
    expiresAt: new Date('2026-10-18T10:10:00.000Z'),
    ...patch,
  }
}

const onClose = vi.fn<() => void>()
const onConfirmed = vi.fn<() => void>()

function showDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <UndoDialog
        taskId={TASK_ID}
        releaseId={RELEASE_ID}
        version="v1.4.0"
        open
        onClose={onClose}
        onConfirmed={onConfirmed}
        pollEveryMs={1}
      />
    </QueryClientProvider>,
  )
  return screen.getByRole('dialog')
}

const NBSP = /\u00a0/g
const text = (element: HTMLElement) => (element.textContent ?? '').replace(NBSP, ' ')

beforeEach(() => {
  prepareUndo.mockReset().mockResolvedValue({ planId: PLAN_ID })
  planOf.mockReset()
  confirm.mockReset()
  onClose.mockReset()
  onConfirmed.mockReset()
})

describe('the window of «Отменить выпуск»', () => {
  it('waits for the plan core makes, then shows what returns and what stays', async () => {
    planOf.mockResolvedValueOnce({ state: 'pending' }).mockResolvedValueOnce(ready())
    const dialog = showDialog()
    expect(within(dialog).getByRole('heading', { name: 'Отменить выпуск 1.4.0?' })).toBeTruthy()
    await within(dialog).findByText(/Страница 42: вернём заголовок/)
    const shown = text(dialog)
    expect(shown).toContain(
      'Сайт вернётся к версии 1.3.0, кроме того, что изменили на сайте после выпуска. Возврат выйдет как новая версия 1.4.1, а номер 1.4.0 останется в истории.',
    )
    expect(shown).toContain('Вернутся к прежнему виду: 1')
    expect(shown).toContain('Удалятся файлы, которые добавил выпуск: 1')
    expect(shown).toContain('Медиафайлы, которые добавил выпуск, останутся на сайте: 2')
    expect(shown).toContain('wp-content/themes/cafe/promo.css')
    expect(shown).toContain('Настройка сайта: не вернём — её изменили на сайте после выпуска')
    expect(shown).toContain('Отмена бесплатна. Кредиты, списанные за этот диалог, не возвращаются.')
    expect(planOf).toHaveBeenCalledTimes(2)
    expect(prepareUndo).toHaveBeenCalledWith({ taskId: TASK_ID, releaseId: RELEASE_ID })
  })

  it('confirms exactly the plan and the number shown', async () => {
    planOf.mockResolvedValue(ready())
    confirm.mockResolvedValue({
      undoId: PLAN_ID,
      status: 'approved',
      version: 'v1.4.1',
      repeated: false,
    })
    const dialog = showDialog()
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Вернуть версию 1.3.0' }))
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[0]![0]).toEqual({
      taskId: TASK_ID,
      releaseId: RELEASE_ID,
      confirmToken: 'undo-token',
      version: 'v1.4.1',
    })
  })

  it('asks for a look at every record of a bulk undo before it confirms', async () => {
    planOf.mockResolvedValue(ready({ review: true }))
    confirm.mockResolvedValue({
      undoId: PLAN_ID,
      status: 'approved',
      version: 'v1.4.1',
      repeated: false,
    })
    const dialog = showDialog()
    const button = await within(dialog).findByRole('button', { name: 'Вернуть версию 1.3.0' })
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /посмотрел/ }))
    fireEvent.click(button)
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[0]![0]).toMatchObject({ reviewed: true })
  })

  it('has no button when nothing is left to undo', async () => {
    planOf.mockResolvedValue(ready({ nothingToUndo: true }))
    const dialog = showDialog()
    await within(dialog).findByText(/возвращать нечего/)
    expect(within(dialog).queryByRole('button', { name: /Вернуть версию/ })).toBeNull()
  })

  it('says a plan core could not make, and makes it again on «Повторить»', async () => {
    planOf
      .mockResolvedValueOnce({ state: 'failed', reason: 'site_unreachable' })
      .mockResolvedValueOnce(ready())
    const dialog = showDialog()
    await within(dialog).findByText(/Модуль «Радити» на сайте не ответил/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Повторить' }))
    await within(dialog).findByRole('button', { name: 'Вернуть версию 1.3.0' })
    expect(prepareUndo).toHaveBeenCalledTimes(2)
  })

  it('keeps a refusal of the server inside and asks for the plan again', async () => {
    planOf.mockResolvedValue(ready())
    confirm.mockRejectedValueOnce(
      serverRefusal(
        'Пока вы подтверждали отмену, на сайте что-то изменилось. Откройте «Отменить выпуск» ещё раз — мы проверим заново',
        'RELEASE_UNDO_PLAN_CHANGED',
      ),
    )
    const dialog = showDialog()
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Вернуть версию 1.3.0' }))
    await within(dialog).findByText(/на сайте что-то изменилось/)
    await waitFor(() => expect(prepareUndo).toHaveBeenCalledTimes(2))
    expect(onConfirmed).not.toHaveBeenCalled()
  })

  it('says the files in sentences', () => {
    expect(
      undoFileLines({ back: 0, removed: 0, restored: 2, mediaKept: 0, paths: [], more: 0 }),
    ).toEqual(['Вернутся файлы, которые выпуск удалил: 2'])
  })
})
