// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { HistoryList } from './history-list'
import { BackupsBlock, DatabaseBlock, type BackupView } from './site-database'
import { RunDetail, runItems, type RunDetailView } from './site-runs'
import { VersionDetail, versionItems, type VersionView } from './site-versions'

const siteId = '0199a3f2-0000-7000-8000-00000000000a'
const at = (minute: number) => new Date(Date.UTC(2026, 9, 25, 9, minute))

const initial: VersionView = {
  id: 'initial',
  kind: 'initial',
  version: 'v0.0.0',
  tag: 'v0.0.0',
  title: null,
  taskId: null,
  run: 1,
  approvedBy: null,
  installedAt: at(0),
  current: false,
  backupAt: null,
  undoes: null,
  undone: false,
}
const release: VersionView = {
  ...initial,
  id: '0199a3f2-0000-7000-8000-0000000000b1',
  kind: 'release',
  version: '0.1.0',
  tag: 'v0.1.0',
  title: 'Поменять цену капучино',
  taskId: '0199a3f2-0000-7000-8000-0000000000c1',
  run: 2,
  approvedBy: 'Анна Иванова',
  installedAt: at(20),
  current: true,
  backupAt: at(19),
}

describe('«Изменения»', () => {
  it('lists the versions across the full width, each leading to its own page', () => {
    render(
      <HistoryList
        label="Версии сайта"
        root={`/projects/${siteId}/changes`}
        items={versionItems([release, initial])}
        emptyText="Версий пока нет."
      />,
    )
    const rows = within(screen.getByRole('list', { name: 'Версии сайта' })).getAllByRole('link')
    expect(rows.map((row) => row.getAttribute('href'))).toEqual([
      `/projects/${siteId}/changes/${release.id}`,
      `/projects/${siteId}/changes/initial`,
    ])
    // The list marks nothing as open (docs/plan/64, Н6): it marks the version on the site.
    expect(screen.queryByRole('link', { current: 'page' })).toBeNull()
    expect(within(rows[0]!).getByText('на сайте')).toBeTruthy()
    expect(within(rows[1]!).getByText('Первоначальная версия сайта')).toBeTruthy()
  })

  it('shows who asked, the copy before it, the run and the dialog, and the way to undo', () => {
    render(<VersionDetail siteId={siteId} version={release} next={null} now={at(30)} />)
    expect(screen.getByText('Сейчас на сайте')).toBeTruthy()
    expect(screen.getByText('Анна Иванова')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Открыть запуск № 2' }).getAttribute('href')).toBe(
      `/projects/${siteId}/runs/${release.id}`,
    )
    expect(screen.getByRole('link', { name: 'Отменить в чате' }).getAttribute('href')).toBe(
      `/chats/${release.taskId}`,
    )
    expect(screen.getByRole('link', { name: 'Открыть чат' }).getAttribute('href')).toBe(
      `/chats/${release.taskId}`,
    )
  })

  it('offers no undo after seven days, and none for the first version', () => {
    const { rerender } = render(
      <VersionDetail
        siteId={siteId}
        version={release}
        next={null}
        now={new Date(Date.UTC(2026, 10, 2))}
      />,
    )
    expect(screen.queryByRole('link', { name: 'Отменить в чате' })).toBeNull()
    rerender(<VersionDetail siteId={siteId} version={initial} next={release} now={at(30)} />)
    expect(screen.getByText(/^Была на сайте до 25/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Открыть запуск № 1' }).getAttribute('href')).toBe(
      `/projects/${siteId}/runs/import`,
    )
  })
})

describe('«Запуски»', () => {
  const run: RunDetailView = {
    id: release.id,
    number: 3,
    kind: 'release',
    title: 'Баннер на главной',
    taskId: release.taskId,
    state: 'rolled_back',
    step: null,
    version: '0.2.0',
    startedAt: at(0),
    finishedAt: at(3),
    approvedBy: 'Анна Иванова',
    steps: [
      { step: 'verify', state: 'failed', startedAt: at(1), finishedAt: at(2) },
      { step: 'rollback', state: 'succeeded', startedAt: at(2), finishedAt: at(3) },
    ],
    lines: [
      { at: at(1), step: 'verify', event: 'started' },
      { at: at(2), step: 'verify', event: 'failed' },
    ],
  }

  it('lists runs and filters those with an error', async () => {
    const { container } = render(
      <HistoryList
        label="Запуски"
        root={`/projects/${siteId}/runs`}
        items={runItems([
          run,
          { ...run, id: 'import', number: 1, kind: 'import', state: 'installed', title: null },
        ])}
        emptyText="Запусков пока нет."
        filters
      />,
    )
    expect(container.querySelectorAll('li')).toHaveLength(2)
    screen.getByRole('button', { name: 'С ошибкой' }).click()
    await screen.findByRole('button', { name: 'С ошибкой', pressed: true })
    expect(container.querySelectorAll('li')).toHaveLength(1)
    expect(screen.getByText('№ 3 · Баннер на главной')).toBeTruthy()
  })

  it('leads from a run to its chat', () => {
    render(<RunDetail run={run} now={at(5)} />)
    expect(screen.getByRole('link', { name: 'Открыть чат' }).getAttribute('href')).toBe(
      `/chats/${run.taskId}`,
    )
  })

  it("tells how a run ended, its steps and a journal of the platform's own reports", () => {
    render(<RunDetail run={run} now={at(5)} />)
    expect(screen.getByText(/сайт вернули к прежнему виду/)).toBeTruthy()
    expect(screen.getByText('Возврат как было')).toBeTruthy()
    expect(screen.getByText('Проверка сайта: не получилось')).toBeTruthy()
    expect(screen.getByText(/2 строки$/)).toBeTruthy()
  })
})

describe('«База»', () => {
  const backups: BackupView[] = [
    {
      id: 'initial',
      kind: 'initial',
      at: at(0),
      bytes: 3 * 1024 * 1024,
      version: 'v0.0.0',
      download: 'ready',
    },
    {
      id: release.id,
      kind: 'release',
      at: at(20),
      bytes: 2048,
      version: '0.1.0',
      download: 'none',
    },
  ]

  it('says that the database is not connected', () => {
    render(<DatabaseBlock database={null} />)
    expect(screen.getByRole('heading', { level: 1, name: 'База данных сайта' })).toBeTruthy()
    expect(screen.getByText('База данных не подключена')).toBeTruthy()
  })

  it('lists the copies, and lets only the copy of the import be downloaded', () => {
    render(<BackupsBlock siteId={siteId} backups={backups} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Копии' })).toBeTruthy()
    expect(screen.getByText('При подключении сайта')).toBeTruthy()
    expect(screen.getByText('3 МБ')).toBeTruthy()
    // The copy of the import downloads through the server; a release backup only serves a rollback.
    const download = screen.getByRole('link', { name: 'Скачать' })
    expect(download.getAttribute('href')).toBe(`/api/projects/${siteId}/backups/initial`)
    expect(download.hasAttribute('download')).toBe(true)
    expect(screen.getAllByRole('link', { name: 'Скачать' })).toHaveLength(1)
    expect(screen.getByText('Только для возврата сайта')).toBeTruthy()
    // The note about where and how the copies are kept is gone (owner's request of 26.10.2026).
    expect(screen.queryByText(/хранятся в России/)).toBeNull()
  })

  it('shows the kind and the name of a connected database, never its address', () => {
    render(
      <DatabaseBlock
        nested
        database={{
          engine: 'mysql',
          databaseName: 'kroshka_wp',
          tls: 'verified',
          updatedAt: at(0),
        }}
      />,
    )
    // A tab, under the h1 of the section.
    expect(screen.getByRole('heading', { level: 2, name: 'База данных сайта' })).toBeTruthy()
    expect(screen.getByText('MySQL или MariaDB')).toBeTruthy()
    expect(screen.getByText('kroshka_wp')).toBeTruthy()
  })
})
