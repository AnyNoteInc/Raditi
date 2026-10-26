// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DangerBlock, settingsBlocks, SiteSettings } from './site-settings'

const site = { name: 'Кофейня «Крошка»' }

describe('site settings', () => {
  const settingsSite = { name: site.name, host: 'kroshka.example', stack: 'wordpress' as const }

  it('says how the files of the site reach Радити, when it is known', () => {
    const { rerender } = render(
      <SiteSettings site={settingsSite} source={{ kind: 'ftp', tls: 'unverified' }} />,
    )
    expect(screen.getByText('Копирование файлов по FTP с шифрованием (FTPS)')).toBeTruthy()
    rerender(<SiteSettings site={settingsSite} source={null} />)
    expect(screen.getByText(/^Без доступа к файлам/)).toBeTruthy()
    rerender(<SiteSettings site={settingsSite} />)
    expect(screen.queryByText('Как Радити получает файлы сайта')).toBeNull()
  })

  it('shows no accesses: they moved to «Переменные»', () => {
    render(<SiteSettings site={settingsSite} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Сайт' })).toBeTruthy()
    expect(screen.getByText('kroshka.example')).toBeTruthy()
    expect(screen.queryByText(/Доступ/)).toBeNull()
  })

  it('is split by its cards: the site and its dangerous actions, beside the menu at the root', () => {
    expect(
      settingsBlocks({ host: 'kroshka.example' }).map(({ segment, title, note }) => ({
        segment,
        title,
        note,
      })),
    ).toEqual([
      { segment: 'site', title: 'Сайт', note: 'kroshka.example' },
      { segment: 'danger', title: 'Опасная область', note: 'Удаление проекта' },
    ])
    render(
      <DangerBlock nested>
        <p>Удалить проект</p>
      </DangerBlock>,
    )
    // At the root the menu holds the h1 of the section.
    expect(screen.getByRole('heading', { level: 2, name: 'Опасная область' })).toBeTruthy()
  })
})
