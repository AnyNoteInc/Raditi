// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { serverRefusal } from '@/components/billing/testing'
import { SITE_ID } from '@/components/chat/testing'

import { dangerText, SiteDangerZone } from './site-danger-zone'

type DeleteInput = { id: string; confirmName: string }

const { remove, replace, refresh, projectCount } = vi.hoisted(() => ({
  remove: vi.fn<(input: DeleteInput) => Promise<{ deleted: true }>>(),
  replace: vi.fn(),
  refresh: vi.fn(),
  projectCount: vi.fn<(input: { siteId: string }) => Promise<{ count: number }>>(),
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
    schedule: {
      pathFilter: () => ({ queryKey: [['schedule']] }),
      projectCount: {
        queryOptions: (input: { siteId: string }) => ({
          queryKey: ['schedule.projectCount', input.siteId],
          queryFn: () => projectCount(input),
        }),
      },
    },
  }),
}))

const site = { id: SITE_ID, name: 'УКК ЖКХ' }

function show(options: { untitled?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <SiteDangerZone site={site} untitled={options.untitled ?? false} />
    </QueryClientProvider>,
  )
  return queryClient
}

const openDialog = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Удалить проект' }))
  return within(screen.getByRole('dialog', { name: 'Удалить проект «УКК ЖКХ»?' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  remove.mockResolvedValue({ deleted: true })
  projectCount.mockResolvedValue({ count: 0 })
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
        'Сейчас на сайте идёт работа: чат, выпуск или настройка. Дождитесь, пока она закончится, или остановите чаты, затем удалите проект',
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

  it('leads to the folder of the project when its chats hold the deletion', async () => {
    remove.mockRejectedValueOnce(
      Object.assign(new Error('Сначала завершите или отмените чаты этого проекта'), {
        data: { code: 'CONFLICT', domainCode: 'SITE_DELETE_BUSY', refusal: 'tasks' },
      }),
    )
    show()
    const dialog = openDialog()
    fireEvent.change(dialog.getByLabelText('Название проекта'), { target: { value: site.name } })
    fireEvent.click(dialog.getByRole('button', { name: 'Удалить проект' }))
    expect((await dialog.findByRole('alert')).textContent).toContain(
      'Сначала завершите или отмените чаты этого проекта.',
    )
    expect(dialog.getByRole('link', { name: 'Открыть чаты проекта' }).getAttribute('href')).toBe(
      `/chats?folder=${SITE_ID}`,
    )
    expect(replace).not.toHaveBeenCalled()
  })

  // docs/plan/82-scheduled-tasks.md, Зп22: the window names the tasks the deletion stops.
  it('names how many scheduled tasks of the project stop, read when the window opens', async () => {
    projectCount.mockResolvedValue({ count: 3 })
    show()
    expect(projectCount).not.toHaveBeenCalled()
    const dialog = openDialog()
    expect(
      await dialog.findByText(
        'Остановятся 3 запланированные задачи проекта. Чаты запусков, которые ждут вашего ответа, закроются.',
      ),
    ).toBeTruthy()
    expect(projectCount).toHaveBeenCalledWith({ siteId: SITE_ID })
  })

  it('reads the scheduled tasks again once the project is deleted: they are paused now', async () => {
    const queryClient = show()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const dialog = openDialog()
    fireEvent.change(dialog.getByLabelText('Название проекта'), { target: { value: site.name } })
    fireEvent.click(dialog.getByRole('button', { name: 'Удалить проект' }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/projects'))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [['schedule']] })
  })

  it('agrees the words with the number of tasks, and says their waiting chats close', () => {
    // deleteSite closes the chats of the runs that wait for an answer, as «Удалить чат» does.
    const closing = ' Чаты запусков, которые ждут вашего ответа, закроются.'
    expect(dangerText.schedulesStop(1)).toBe(
      `Остановится 1 запланированная задача проекта.${closing}`,
    )
    expect(dangerText.schedulesStop(21)).toBe(
      `Остановится 21 запланированная задача проекта.${closing}`,
    )
    expect(dangerText.schedulesStop(4)).toBe(
      `Остановятся 4 запланированные задачи проекта.${closing}`,
    )
    expect(dangerText.schedulesStop(11)).toBe(
      `Остановятся 11 запланированных задач проекта.${closing}`,
    )
    expect(dangerText.schedulesStop(20)).toBe(
      `Остановятся 20 запланированных задач проекта.${closing}`,
    )
  })

  it('says nothing of tasks when none stop or the number is not known', async () => {
    show()
    let dialog = openDialog()
    await waitFor(() => expect(projectCount).toHaveBeenCalledOnce())
    expect(dialog.queryByText(/запланирован/)).toBeNull()
    fireEvent.click(dialog.getByRole('button', { name: 'Не удалять' }))
    cleanup()

    projectCount.mockRejectedValue(new Error('offline'))
    show()
    dialog = openDialog()
    await waitFor(() => expect(projectCount).toHaveBeenCalledTimes(2))
    expect(dialog.queryByText(/запланирован/)).toBeNull()
  })

  it('has no way to the chats when something else holds the deletion', async () => {
    remove.mockRejectedValueOnce(
      Object.assign(new Error('Сейчас на сайте идёт работа'), {
        data: { code: 'CONFLICT', domainCode: 'SITE_DELETE_BUSY', refusal: 'release' },
      }),
    )
    show()
    const dialog = openDialog()
    fireEvent.change(dialog.getByLabelText('Название проекта'), { target: { value: site.name } })
    fireEvent.click(dialog.getByRole('button', { name: 'Удалить проект' }))
    await dialog.findByRole('alert')
    expect(dialog.queryByRole('link', { name: 'Открыть чаты проекта' })).toBeNull()
  })
})
