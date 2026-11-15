// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ProjectListItem } from './chat-types'
import { ProjectPicker } from './project-picker'

const narrow = vi.hoisted(() => ({ value: false }))

vi.mock('@mui/material/useMediaQuery', () => ({ default: () => narrow.value }))

const id = (n: number) => `0199a3f2-0000-8000-8000-${String(n).padStart(12, '0')}`

function project(
  n: number,
  name: string,
  state: ProjectListItem['chat']['state'],
  requirements: ProjectListItem['chat']['requirements'] = { repository: true, browser: true },
) {
  return {
    id: id(n),
    name,
    host: `site-${n}.example`,
    chat: { state, requirements },
  } as ProjectListItem
}

function show(
  projects: readonly ProjectListItem[],
  options: {
    value?: ProjectListItem | null
    locked?: boolean
    addProject?: boolean
    gone?: string
  } = {},
) {
  const onChange = vi.fn()
  render(
    <ProjectPicker
      projects={projects}
      value={options.value ?? null}
      locked={options.locked ?? false}
      onChange={onChange}
      {...(options.addProject === false ? {} : { onAddProject: vi.fn() })}
      {...(options.gone === undefined ? {} : { gone: options.gone })}
    />,
  )
  return onChange
}

const open = () => fireEvent.click(screen.getByRole('button', { name: /^Проект для этого чата/ }))

describe('the choice of a project', () => {
  it('without projects still has «Без проекта» and «Добавить проект»', async () => {
    show([])
    open()
    const menu = await screen.findByRole('menu', { name: 'Проект для этого чата' })
    expect(within(menu).getByRole('menuitem', { name: 'Без проекта' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Добавить проект' })).toBeTruthy()
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2)
  })

  it('stands «Без проекта» first, then the projects, then «Добавить проект»', async () => {
    show([project(1, 'Кофейня', 'ready'), project(2, 'Гранд', 'ready')])
    open()
    const items = within(await screen.findByRole('menu')).getAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'Без проекта',
      expect.stringContaining('Кофейняsite-1.example'),
      expect.stringContaining('Грандsite-2.example'),
      'Добавить проект',
    ])
    expect(screen.getAllByRole('separator')).toHaveLength(2)
  })

  // docs/plan/82-scheduled-tasks.md, Зп7: the window of a scheduled task cannot keep its fields.
  it('has no «Добавить проект» where nothing would keep what was written', async () => {
    show([project(1, 'Кофейня', 'ready')], { addProject: false })
    open()
    const items = within(await screen.findByRole('menu')).getAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'Без проекта',
      expect.stringContaining('Кофейняsite-1.example'),
    ])
    expect(screen.queryByRole('menuitem', { name: 'Добавить проект' })).toBeNull()
    expect(screen.getAllByRole('separator')).toHaveLength(1)
  })

  // docs/plan/82-scheduled-tasks.md, Зп22: a scheduled task keeps a deleted project until moved.
  it('says a project that is gone, chooses nothing, and gives «Без проекта» as a choice', async () => {
    const onChange = show([project(1, 'Кофейня', 'ready')], {
      addProject: false,
      gone: 'Проект удалён',
    })
    expect(
      screen.getByRole('button', { name: 'Проект для этого чата: Проект удалён' }),
    ).toBeTruthy()
    open()
    const menu = await screen.findByRole('menu')
    for (const item of within(menu).getAllByRole('menuitem'))
      expect(item.classList.contains('Mui-selected'), item.textContent ?? '').toBe(false)
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Без проекта' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it.each([
    ['closed', 'Сайт на паузе или отключён.'],
    ['insecure', 'В браузере агент работает только с сайтами'],
    ['unavailable', 'Сейчас этот проект недоступен для чата. Попробуйте ещё раз немного позже.'],
  ] as const)('closes a project that is %s and says why', async (state, note) => {
    const onChange = show([project(1, 'Кофейня', state, null)])
    open()
    const item = await screen.findByRole('menuitem', { name: new RegExp(`Кофейня ?${note}`) })
    expect(item.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(item)
    expect(onChange).not.toHaveBeenCalled()
  })

  it.each([
    ['importing', 'Файлы сайта ещё загружаются.'],
    ['import_failed', 'Файлы сайта не загрузились.'],
  ] as const)('leaves a project %s open, with the note', async (state, note) => {
    const browserOnly = { repository: false, browser: true }
    const item = project(1, 'Кофейня', state, browserOnly)
    const onChange = show([item])
    open()
    fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(`Кофейня ?${note}`) }))
    expect(onChange).toHaveBeenCalledWith(item)
  })

  it('is a sheet with its title on a phone', async () => {
    narrow.value = true
    try {
      show([project(1, 'Кофейня', 'ready')])
      open()
      const sheet = await screen.findByRole('dialog', { name: 'Проект для этого чата' })
      expect(within(sheet).getByText('Проект для этого чата')).toBeTruthy()
      expect(within(sheet).getByRole('menu', { name: 'Проект для этого чата' })).toBeTruthy()
    } finally {
      narrow.value = false
    }
  })

  it('says a press on what is shown too: «Без проекта» is a choice of the client', async () => {
    const onChange = show([project(1, 'Кофейня', 'ready')])
    open()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Без проекта' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('is no menu while files hold the project', () => {
    show([project(1, 'Кофейня', 'ready')], { value: project(1, 'Кофейня', 'ready'), locked: true })
    expect(screen.queryByRole('button', { name: /^Проект для этого чата/ })).toBeNull()
    const pill = screen.getByRole('button', { name: /Кофейня/ })
    fireEvent.click(pill)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
