// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const params: { taskId?: string } = { taskId: '0199a3f2-0000-7000-8000-0000000000b1' }
vi.mock('next/navigation', () => ({ useParams: () => params }))

type Install = { taskId: string; fileId: string; replace?: boolean }
const install = vi.hoisted(() => vi.fn())
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    accountSkills: {
      installFromChatFile: {
        mutationOptions: () => ({ mutationFn: (input: Install) => install(input) }),
      },
    },
  }),
}))

import { FeedFile, feedFileText, isSkillFile, taskFileHref } from './feed-file'

const file = {
  fileId: '0199a3f2-0000-8000-8000-0000000000f1',
  name: 'Смета на ноябрь.xlsx',
  sizeBytes: Math.round(1.2 * 1024 * 1024),
}
const skillFile = { ...file, name: 'brand-voice.skill', sizeBytes: 2048 }

const show = (element: ReactElement) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      {element}
    </QueryClientProvider>,
  )

describe('a file of the agent in the chat', () => {
  beforeEach(() => {
    params.taskId = '0199a3f2-0000-7000-8000-0000000000b1'
    install.mockReset()
  })

  it('shows its name and size and downloads it from the cabinet’s own origin', () => {
    show(<FeedFile {...file} />)
    const href = `/api/tasks/${params.taskId}/files/${file.fileId}`
    expect(taskFileHref(params.taskId!, file.fileId)).toBe(href)
    expect(screen.getByText('Смета на ноябрь.xlsx')).toBeTruthy()
    expect(screen.getByText('1,2 МБ')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Скачать файл «Смета на ноябрь.xlsx»' })
    expect(link.getAttribute('href')).toBe(href)
    expect(link.getAttribute('download')).toBe('Смета на ноябрь.xlsx')
    expect(link.textContent).toBe('Скачать')
    expect(screen.queryByRole('button', { name: feedFileText.saveSkill })).toBeNull()
  })

  it('shows nothing outside the page of a chat', () => {
    delete params.taskId
    const { container } = show(<FeedFile {...file} />)
    expect(container.innerHTML).toBe('')
  })

  it('knows a skill by its extension', () => {
    expect(isSkillFile('brand-voice.skill')).toBe(true)
    expect(isSkillFile('Brand.SKILL')).toBe(true)
    expect(isSkillFile('brand.skill.zip')).toBe(false)
    expect(isSkillFile('notes.txt')).toBe(false)
  })
})

describe('«Сохранить как навык» (docs/plan/97-skills.md, Нв20)', () => {
  beforeEach(() => {
    params.taskId = '0199a3f2-0000-7000-8000-0000000000b1'
    install.mockReset()
  })

  it('saves the skill of the chat and says where to find it', async () => {
    install.mockResolvedValue({
      status: 'installed',
      skillId: '0199a3f2-0000-7000-8000-0000000000c1',
      name: 'brand-voice',
      enabled: true,
    })
    show(<FeedFile {...skillFile} />)
    fireEvent.click(screen.getByRole('button', { name: feedFileText.saveSkill }))

    const notice = await screen.findByRole('status')
    expect(notice.textContent).toContain(feedFileText.saved('brand-voice'))
    expect(
      within(notice).getByRole('link', { name: feedFileText.openSkills }).getAttribute('href'),
    ).toBe('/settings/skills')
    expect(install).toHaveBeenCalledExactlyOnceWith({
      taskId: params.taskId,
      fileId: skillFile.fileId,
    })
    expect(screen.queryByRole('button', { name: feedFileText.saveSkill })).toBeNull()
  })

  it('asks before replacing a skill of the same name, and replaces it on «Заменить»', async () => {
    install.mockResolvedValueOnce({ status: 'exists', name: 'brand-voice' }).mockResolvedValueOnce({
      status: 'installed',
      skillId: '0199a3f2-0000-7000-8000-0000000000c1',
      name: 'brand-voice',
      enabled: true,
    })
    show(<FeedFile {...skillFile} />)
    fireEvent.click(screen.getByRole('button', { name: feedFileText.saveSkill }))

    const dialog = await screen.findByRole('dialog', { name: feedFileText.replaceTitle })
    fireEvent.click(within(dialog).getByRole('button', { name: feedFileText.replace }))

    await screen.findByText(feedFileText.saved('brand-voice'))
    expect(install).toHaveBeenLastCalledWith({
      taskId: params.taskId,
      fileId: skillFile.fileId,
      replace: true,
    })
  })

  it('keeps the installed skill when the client does not want to replace it', async () => {
    install.mockResolvedValue({ status: 'exists', name: 'brand-voice' })
    show(<FeedFile {...skillFile} />)
    fireEvent.click(screen.getByRole('button', { name: feedFileText.saveSkill }))
    const dialog = await screen.findByRole('dialog', { name: feedFileText.replaceTitle })
    fireEvent.click(within(dialog).getByRole('button', { name: feedFileText.keep }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('shows the server’s words when the skill does not fit', async () => {
    install.mockRejectedValue({
      message: 'Навык не подходит: в папке навыка нет файла SKILL.md',
      data: { code: 'BAD_REQUEST' },
    })
    show(<FeedFile {...skillFile} />)
    fireEvent.click(screen.getByRole('button', { name: feedFileText.saveSkill }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Навык не подходит: в папке навыка нет файла SKILL.md.',
    )
  })
})
