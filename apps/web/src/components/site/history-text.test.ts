import { describe, expect, it } from 'vitest'

import {
  durationText,
  runLineText,
  runListNote,
  runMatches,
  runOutcomeText,
  runTitle,
  sourceText,
  type RunView,
} from './history-text'

const run: RunView = {
  id: 'r',
  number: 2,
  kind: 'release',
  title: 'Поменять цену капучино',
  taskId: null,
  state: 'installed',
  step: null,
  version: '0.1.0',
  startedAt: new Date('2026-10-25T09:00:00Z'),
  finishedAt: new Date('2026-10-25T09:02:40Z'),
  approvedBy: null,
}

describe('history texts', () => {
  it('names a run by its dialog, its import or its version', () => {
    expect(runTitle(run)).toBe('Поменять цену капучино')
    expect(runTitle({ ...run, kind: 'import', title: null })).toBe('Подключение сайта')
    expect(runTitle({ ...run, title: null })).toBe('Версия 0.1.0')
    expect(runTitle({ ...run, kind: 'undo' })).toBe('Отмена выпуска: Поменять цену капучино')
  })

  it('says how long a run took', () => {
    expect(durationText(run.startedAt, run.finishedAt ?? run.startedAt)).toBe('2 мин 40 с')
    expect(durationText(run.startedAt, new Date('2026-10-25T09:00:34Z'))).toBe('34 с')
    expect(durationText(run.startedAt, new Date('2026-10-25T10:05:00Z'))).toBe('1 ч 5 мин')
  })

  it('notes a run in the list with its state, day and installed version', () => {
    expect(runListNote(run)).toBe('Выполнен · 25 октября · версия 0.1.0')
    expect(runListNote({ ...run, state: 'rolled_back' })).toBe('Ошибка · сайт возвращён · 25 октября')
  })

  it('filters runs that go on and runs that did not succeed', () => {
    expect(runMatches({ state: 'running' }, 'running')).toBe(true)
    expect(runMatches({ state: 'installed' }, 'errors')).toBe(false)
    expect(runMatches({ state: 'refused' }, 'errors')).toBe(true)
    expect(runMatches({ state: 'installed' }, 'all')).toBe(true)
  })

  it('tells the owner what an ended run means, and nothing when it went well', () => {
    expect(runOutcomeText(run)).toBeNull()
    expect(runOutcomeText({ ...run, state: 'rolled_back' })).toMatch(/вернули к прежнему виду/)
    expect(runOutcomeText({ ...run, kind: 'import', state: 'failed' })).toMatch(/«Обзор»/)
  })

  it('writes a journal line from the codes of a report, never from a message', () => {
    expect(runLineText({ step: 'verify', event: 'failed' })).toBe('Проверка сайта: не получилось')
    expect(runLineText({ step: 'import', event: 'files', files: 8071, bytes: 2 * 1024 * 1024 })).toBe(
      'Сохранено 8 071 файл, 2 МБ',
    )
  })

  it('says how the files reach Радити by the source kind and protection', () => {
    expect(sourceText({ kind: 'sftp', tls: null })).toBe('Копирование файлов по SFTP (SSH)')
    expect(sourceText({ kind: 'ftp', tls: 'plain' })).toBe('Копирование файлов по FTP без шифрования')
  })
})
