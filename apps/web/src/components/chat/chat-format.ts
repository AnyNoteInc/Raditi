import { taskListGroupLabel } from '@repo/domain/tasks/client-feed-labels'

import { formatMoscowDate, formatMoscowDay } from '@/lib/moscow-date'

import type { DialogListItem } from './chat-types'

const moscowTime = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Moscow',
})

/** «12:40» by the Moscow clock. */
export const moscowClock = (instant: Date): string => moscowTime.format(instant)

/** The same Moscow calendar day. */
export const sameMoscowDay = (first: Date, second: Date): boolean =>
  formatMoscowDate(first) === formatMoscowDate(second)

/** The time of a row or a dialog: «12:40» today, «18 октября, 12:40» before. */
export function feedTime(at: Date, now: Date): string {
  return sameMoscowDay(at, now) ? moscowClock(at) : `${formatMoscowDay(at)}, ${moscowClock(at)}`
}

/** A moment always with its day: «25 октября, 14:30» by the Moscow clock. */
export const dayTime = (at: Date): string => `${formatMoscowDay(at)}, ${moscowClock(at)}`

/** The time of a dialog in the list: «12:40» today, «18 октября» before. */
export function listTime(at: Date, now: Date): string {
  return sameMoscowDay(at, now) ? moscowClock(at) : formatMoscowDay(at)
}

export interface DialogGroup {
  key: keyof typeof taskListGroupLabel
  label: string
  items: DialogListItem[]
}

/**
 * The groups of the list (feed design, «Подписи статусов»): «Ждёт вашего решения» gathers the
 * dialogs that wait for the client, then «Сегодня» and «Ранее» by the Moscow day the dialog was
 * started. Within a group the order of the server stays: the latest changed first.
 */
export function dialogGroups(items: readonly DialogListItem[], now: Date): DialogGroup[] {
  const groups: Record<DialogGroup['key'], DialogListItem[]> = {
    awaiting: [],
    today: [],
    earlier: [],
  }
  for (const item of items) {
    if (item.status === 'awaiting_user' || item.status === 'awaiting_approval')
      groups.awaiting.push(item)
    else if (sameMoscowDay(item.createdAt, now)) groups.today.push(item)
    else groups.earlier.push(item)
  }
  return (['awaiting', 'today', 'earlier'] as const)
    .filter((key) => groups[key].length > 0)
    .map((key) => ({ key, label: taskListGroupLabel[key], items: groups[key] }))
}

/** «512 байт», «12 КБ», «1,4 МБ»: the size of a file for reading. */
export function fileSizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} байт`
  const kib = bytes / 1024
  if (kib < 1024) return `${Math.max(1, Math.round(kib))} КБ`
  const mib = kib / 1024
  return `${mib.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`
}

export type DiffLineKind = 'add' | 'remove' | 'hunk' | 'meta' | 'context'

export interface DiffLine {
  kind: DiffLineKind
  /** The line without its sign: the sign is drawn apart, so the colour is not the only one. */
  text: string
}

/**
 * The lines of a unified diff as the panel draws them. The text is only ever set as text: a
 * line of the site's code is never markup.
 */
export function diffLines(diff: string): DiffLine[] {
  const lines = diff.endsWith('\n') ? diff.slice(0, -1).split('\n') : diff.split('\n')
  let inHunk = false
  return lines.map((line): DiffLine => {
    if (line.startsWith('@@')) {
      inHunk = true
      return { kind: 'hunk', text: line }
    }
    if (line.startsWith('diff --git ')) inHunk = false
    if (!inHunk) return { kind: 'meta', text: line }
    if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) }
    if (line.startsWith('-')) return { kind: 'remove', text: line.slice(1) }
    // `\ No newline at end of file` is a remark of the format, not a line of the file.
    if (line.startsWith('\\')) return { kind: 'meta', text: line }
    return { kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line }
  })
}
