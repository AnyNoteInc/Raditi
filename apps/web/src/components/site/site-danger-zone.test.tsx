// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { serverRefusal } from '@/components/billing/testing'
import { SITE_ID } from '@/components/chat/testing'

import { SiteDangerZone } from './site-danger-zone'

type DeleteInput = { id: string; confirmName: string }

const { remove, replace, refresh } = vi.hoisted(() => ({
  remove: vi.fn<(input: DeleteInput) => Promise<{ deleted: true }>>(),
  replace: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, refresh }) }))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    project: {
      list: { queryKey: () => ['project.list'] },
      delete: {
        mutationOptions: (options: UseMutationOptions<unknown, Error, DeleteInput>) => ({
          ...options,
          mutationFn: remove,
        }),
      },
    },
  }),
}))

const site = { id: SITE_ID, name: 'УКК ЖКХ' }

function show(options: { untitled?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <SiteDangerZone site={site} untitled={options.untitled ?? false} />
    </QueryClientProvider>,
  )
}

const openDialog = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Удалить проект' }))
  return within(screen.getByRole('dialog', { name: 'Удалить проект «УКК ЖКХ»?' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  remove.mockResolvedValue({ deleted: true })
})

describe('«Опасная область» of the settings of a site', () => {
  it('says what deleting does before anything is asked', () => {
    show()
    expect(screen.getByRole('heading', { level: 2, name: 'Опасная область' })).toBeTruthy()
    expect(screen.getByText(/Сам сайт и его файлы на хостинге не изменятся/)).toBeTruthy()
    expect(remove).not.toHaveBeenCalled()
  })

  it('leaves its heading to the block of «Настройки» that names it', () => {
    show({ untitled: true })
    expect(screen.queryByRole('heading', { name: 'Опасная область' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Удалить проект' })).toBeTruthy()
  })

  it('deletes only after the name is typed, then goes to the projects', async () => {
    show()
    const dialog = openDialog()
    fireEvent.click(dialog.getByRole('button', { name: 'Удалить проект' }))
    expect(
      await dialog.findByText(
        'Название не совпадает. Введите название проекта точно так, как оно написано.',
      ),
    ).toBeTruthy()
    expect(remove).not.toHaveBeenCalled()

    fireEvent.change(dialog.getByLabelText('Название проекта'), { target: { value: 'УКК ЖКХ' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Удалить проект' }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/projects'))
    expect(remove).toHaveBeenCalledExactlyOnceWith(
      { id: SITE_ID, confirmName: 'УКК ЖКХ' },
      expect.anything(),
    )
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('keeps the dialog open with the words of a refusal', async () => {
    remove.mockRejectedValueOnce(
      serverRefusal(
        'Сейчас на сайте идёт работа: диалог, выпуск или настройка. Дождитесь, пока она закончится, или остановите диалоги, затем удалите проект',
        'SITE_DELETE_BUSY',
      ),
    )
    show()
    const dialog = openDialog()
    fireEvent.change(dialog.getByLabelText('Название проекта'), { target: { value: 'УКК ЖКХ' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Удалить проект' }))
    expect(await dialog.findByText(/Сейчас на сайте идёт работа/)).toBeTruthy()
    expect(replace).not.toHaveBeenCalled()
  })
})
