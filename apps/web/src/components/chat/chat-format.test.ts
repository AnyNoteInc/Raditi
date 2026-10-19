import { describe, expect, it } from 'vitest'

import { dialogGroups, diffLines, feedTime, fileSizeText, listTime } from './chat-format'
import type { DialogListItem } from './chat-types'

const NBSP = ' '
const now = new Date('2026-10-17T12:00:00.000Z')

function dialog(id: string, status: DialogListItem['status'], createdAt: string): DialogListItem {
  return {
    id,
    title: id,
    status,
    mode: 'work',
    undo: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  }
}

describe('times of the chat', () => {
  it('names the clock today and the day before, by Moscow time', () => {
    expect(feedTime(new Date('2026-10-17T09:40:00.000Z'), now)).toBe('12:40')
    expect(feedTime(new Date('2026-10-16T09:40:00.000Z'), now)).toBe(`16${NBSP}октября, 12:40`)
    // 23:30 in UTC is already the next day in Moscow.
    expect(listTime(new Date('2026-10-16T21:30:00.000Z'), now)).toBe('00:30')
    expect(listTime(new Date('2026-10-15T09:40:00.000Z'), now)).toBe(`15${NBSP}октября`)
  })
})

describe('dialogGroups', () => {
  it('puts the dialogs that wait for the client first, then today and earlier', () => {
    const groups = dialogGroups(
      [
        dialog('a', 'running', '2026-10-17T08:00:00.000Z'),
        dialog('b', 'awaiting_approval', '2026-10-10T08:00:00.000Z'),
        dialog('c', 'done', '2026-10-10T08:00:00.000Z'),
        dialog('d', 'awaiting_user', '2026-10-17T07:00:00.000Z'),
      ],
      now,
    )
    expect(groups.map((group) => [group.label, group.items.map((item) => item.id)])).toEqual([
      ['Ждёт вашего решения', ['b', 'd']],
      ['Сегодня', ['a']],
      ['Ранее', ['c']],
    ])
  })

  it('leaves out an empty group', () => {
    expect(
      dialogGroups([dialog('a', 'done', '2026-10-17T08:00:00.000Z')], now).map((g) => g.key),
    ).toEqual(['today'])
  })
})

describe('fileSizeText', () => {
  it('reads bytes, kilobytes and megabytes', () => {
    expect(fileSizeText(512)).toBe('512 байт')
    expect(fileSizeText(12 * 1024)).toBe('12 КБ')
    expect(fileSizeText(1.4 * 1024 * 1024)).toBe('1,4 МБ')
  })
})

describe('diffLines', () => {
  it('tells added, removed and unchanged lines, the header and the hunks apart', () => {
    const diff = [
      'diff --git a/style.css b/style.css',
      'index 1111111..2222222 100644',
      '--- a/style.css',
      '+++ b/style.css',
      '@@ -1,2 +1,2 @@',
      ' body {',
      '-  color: red;',
      '+  color: brown;',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    expect(diffLines(diff)).toEqual([
      { kind: 'meta', text: 'diff --git a/style.css b/style.css' },
      { kind: 'meta', text: 'index 1111111..2222222 100644' },
      { kind: 'meta', text: '--- a/style.css' },
      { kind: 'meta', text: '+++ b/style.css' },
      { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { kind: 'context', text: 'body {' },
      { kind: 'remove', text: '  color: red;' },
      { kind: 'add', text: '  color: brown;' },
      { kind: 'meta', text: '\\ No newline at end of file' },
    ])
  })

  it('keeps markup as text: the lines are never parsed', () => {
    const [line] = diffLines('@@ -0,0 +1 @@\n+<script>alert(1)</script>').slice(1)
    expect(line).toEqual({ kind: 'add', text: '<script>alert(1)</script>' })
  })
})
