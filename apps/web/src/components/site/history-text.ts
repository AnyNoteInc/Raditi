import { fileSizeText } from '@/components/chat/chat-format'
import { formatMoscowDay } from '@/lib/moscow-date'
import { plural } from '@/lib/plural'

// The words of «Изменения», «Запуски» and «База и бэкап»: what the platform recorded about a run,
// a version or a copy, said to the owner of the site. Never a message of a program, a path or
// an address — the journal of a run is made of the platform's own reports (plan 38, «з»).

export type RunState = 'running' | 'installed' | 'rolled_back' | 'failed' | 'refused' | 'unknown'
export type RunKind = 'import' | 'release' | 'undo'
export type StepName =
  'import' | 'conflicts' | 'backup' | 'files' | 'db' | 'verify' | 'rollback' | 'reverify'
export type StepState = 'started' | 'succeeded' | 'failed' | 'unknown'

/** A run, as the list and the page of a run read it. */
export interface RunView {
  id: string
  number: number
  kind: RunKind
  title: string | null
  taskId: string | null
  state: RunState
  step: Exclude<StepName, 'import'> | null
  version: string | null
  startedAt: Date
  finishedAt: Date | null
  approvedBy: string | null
}

/** The name of a run: what was asked in its dialog, or what the platform did. */
export function runTitle(run: Pick<RunView, 'kind' | 'title' | 'version'>): string {
  if (run.kind === 'import') return 'Подключение сайта'
  const asked = run.title ?? (run.version ? `Версия ${run.version}` : 'Обновление сайта')
  return run.kind === 'undo' ? `Отмена выпуска: ${asked}` : asked
}

/** How a run ended, in a few words. */
export const runStateText: Readonly<Record<RunState, string>> = Object.freeze({
  running: 'Идёт',
  installed: 'Выполнен',
  rolled_back: 'Ошибка · сайт возвращён',
  failed: 'Ошибка',
  refused: 'Не выполнен · сайт не менялся',
  unknown: 'Выясняем, чем закончился',
})

/** What the owner needs to know about a run that ended; null when it went as planned. */
export function runOutcomeText(run: Pick<RunView, 'kind' | 'state' | 'version'>): string | null {
  if (run.kind === 'import') {
    if (run.state === 'failed')
      return 'Копирование файлов остановилось. Что случилось и как продолжить — на странице «Обзор».'
    if (run.state === 'running') return 'Копируем файлы сайта и сохраняем его первоначальную версию.'
    return null
  }
  switch (run.state) {
    case 'rolled_back':
      return 'Обновление не прошло проверку, и сайт вернули к прежнему виду из резервной копии. От вас ничего не нужно.'
    case 'refused':
      return 'Обновление остановилось до того, как сайт изменился: на сайте всё осталось как было.'
    case 'failed':
      return 'Обновление не удалось. Подробности — в диалоге, из которого его запустили.'
    case 'unknown':
      return 'Мы ещё выясняем, чем закончилось обновление, и напишем в диалоге, как только узнаем.'
    case 'running':
      return 'Обновление идёт. Страницу можно закрыть — оно продолжится без вас.'
    case 'installed':
      return null
  }
}

/** The steps of a run, by their names in the platform's reports. */
export const stepNameText: Readonly<Record<StepName, string>> = Object.freeze({
  import: 'Копирование файлов сайта',
  conflicts: 'Сверка с сайтом',
  backup: 'Резервная копия',
  files: 'Установка файлов',
  db: 'Записи сайта',
  verify: 'Проверка сайта',
  rollback: 'Возврат как было',
  reverify: 'Проверка после возврата',
})

export const stepStateText: Readonly<Record<StepState, string>> = Object.freeze({
  started: 'Идёт',
  succeeded: 'Выполнен',
  failed: 'Ошибка',
  unknown: 'Неизвестно',
})

/** One line of the journal of a run. */
export function runLineText(line: {
  step: StepName
  event: StepState | 'files'
  files?: number
  bytes?: number
}): string {
  const step = stepNameText[line.step]
  switch (line.event) {
    case 'started':
      return `${step}: начали`
    case 'succeeded':
      return `${step}: готово`
    case 'failed':
      return `${step}: не получилось`
    case 'unknown':
      return `${step}: результат неизвестен`
    case 'files': {
      const files =
        line.files === undefined
          ? 'Файлы сайта сохранены'
          : `Сохранено ${line.files.toLocaleString('ru-RU')} ${plural(line.files, 'файл', 'файла', 'файлов')}`
      return line.bytes === undefined ? files : `${files}, ${fileSizeText(line.bytes)}`
    }
  }
}

/** «2 мин 40 с», «34 с», «1 ч 5 мин»: how long something took. */
export function durationText(from: Date, to: Date): string {
  const seconds = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000))
  if (seconds < 60) return `${seconds} с`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes} мин` : `${minutes} мин ${seconds % 60} с`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${hours} ч` : `${hours} ч ${minutes % 60} мин`
}

/** The line under a run in the list: its state and its day, and the version it installed. */
export function runListNote(run: RunView): string {
  const parts = [runStateText[run.state], formatMoscowDay(run.finishedAt ?? run.startedAt)]
  if (run.state === 'installed' && run.version) parts.push(`версия ${run.version}`)
  return parts.join(' · ')
}

/** Which runs the list shows: all, those that go on, those that did not succeed. */
export type RunFilter = 'all' | 'running' | 'errors'
export const runFilterText: Readonly<Record<RunFilter, string>> = Object.freeze({
  all: 'Все',
  running: 'Идут',
  errors: 'С ошибкой',
})
export function runMatches(run: Pick<RunView, 'state'>, filter: RunFilter): boolean {
  if (filter === 'running') return run.state === 'running'
  if (filter === 'errors') return run.state !== 'running' && run.state !== 'installed'
  return true
}

/** «Копирование файлов по FTP»: how the files of the site reach Радити and back. */
export function sourceText(
  source: { kind: 'sftp' | 'ftp' | 'git'; tls: 'verified' | 'unverified' | 'plain' | null } | null,
): string {
  if (source === null) return 'Без доступа к файлам: агент работает в админке сайта через браузер'
  if (source.kind === 'sftp') return 'Копирование файлов по SFTP (SSH)'
  if (source.kind === 'git') return 'Из репозитория Git'
  if (source.tls === 'plain') return 'Копирование файлов по FTP без шифрования'
  return 'Копирование файлов по FTP с шифрованием (FTPS)'
}

export const engineText = { mysql: 'MySQL или MariaDB', postgres: 'PostgreSQL' } as const

export const tlsText = {
  verified: 'защищённое, с проверкой сертификата',
  unverified: 'защищённое, без проверки сертификата',
  plain: 'без шифрования',
} as const
