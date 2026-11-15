'use client'

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { useEffect, useRef, type KeyboardEvent } from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { PALETTE_ROOM } from './command-palette'
import { mentionText } from './chat-texts'

// A file or a folder of the project named in the field by `@` (docs/plan/78-file-mentions.md,
// У1–У4): `@` at the start of the field or after a space opens a list of the files of the chat's
// working copy — the same list the tools' «Терминал» reads (`siteFiles.list`) — and the letters
// after it narrow the list. The choice puts `@<path>` into the words; the agent reads it as a path
// from the root of its working copy. Nothing is attached: the words go as they are written.

/** At most this many rows of the list: the rest is narrowed by more letters. */
export const MENTION_ROWS = 8

export interface MentionOption {
  path: string
  folder: boolean
}

/** The `@` the caret stands in: where it begins and the letters after it, or null. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  // `@` begins a word: an address of mail (`name@site.ru`) is no mention.
  if (at > 0 && !/\s/u.test(before[at - 1] ?? '')) return null
  const query = before.slice(at + 1)
  if (/\s/u.test(query)) return null
  return { start: at, query }
}

/** The folders of the files, each once, with a slash at the end. */
export function foldersOf(paths: readonly string[]): string[] {
  const folders = new Set<string>()
  for (const path of paths) {
    const parts = path.split('/')
    for (let end = 1; end < parts.length; end += 1) folders.add(`${parts.slice(0, end).join('/')}/`)
  }
  return [...folders]
}

/**
 * The files and folders for the letters typed: those whose path holds them, case aside. A name
 * that begins with them goes first, then a path that begins with them, then the rest; a shorter
 * path before a longer one. Without letters — the folders of the top, then the files there.
 */
export function mentionMatches(
  paths: readonly string[],
  query: string,
  limit = MENTION_ROWS,
): MentionOption[] {
  const all: MentionOption[] = [
    ...foldersOf(paths).map((path) => ({ path, folder: true })),
    ...paths.map((path) => ({ path, folder: false })),
  ]
  const wanted = query.toLowerCase()
  const rank = (option: MentionOption): number | null => {
    const path = option.path.toLowerCase()
    if (wanted === '') return path.replace(/\/$/u, '').includes('/') ? null : option.folder ? 0 : 1
    const at = path.indexOf(wanted)
    if (at < 0) return null
    const name = path.replace(/\/$/u, '').split('/').at(-1) ?? ''
    if (name.startsWith(wanted)) return 0
    if (at === 0) return 1
    return 2
  }
  return all
    .flatMap((option) => {
      const place = rank(option)
      return place === null ? [] : [{ option, place }]
    })
    .sort(
      (a, b) =>
        a.place - b.place ||
        a.option.path.length - b.option.path.length ||
        a.option.path.localeCompare(b.option.path),
    )
    .slice(0, limit)
    .map(({ option }) => option)
}

/** The words with the chosen path in place of the `@` and its letters, and where the caret goes. */
export function withMention(
  text: string,
  mention: { start: number; query: string },
  path: string,
): { text: string; caret: number } {
  const end = mention.start + 1 + mention.query.length
  const rest = text.slice(end)
  // A folder may be narrowed further; a file ends the word.
  const inserted = path.endsWith('/') ? `@${path}` : `@${path}${/^\s/u.test(rest) ? '' : ' '}`
  return {
    text: `${text.slice(0, mention.start)}${inserted}${rest}`,
    caret: mention.start + inserted.length,
  }
}

/** The id of a row in the document: what `aria-activedescendant` of the field names. */
export const mentionOptionId = (listId: string, index: number) => `${listId}-m${index}`

/**
 * The keys of the list while the field has the focus: arrows move, Enter and Tab choose, Escape
 * closes. Returns true when the key was the list's.
 */
export function mentionKey(
  event: KeyboardEvent,
  count: number,
  act: { move: (step: number) => void; choose: () => void; close: () => void },
): boolean {
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp':
      if (count === 0) return false
      event.preventDefault()
      act.move(event.key === 'ArrowDown' ? 1 : -1)
      return true
    case 'Enter':
    case 'Tab':
      if (count === 0 || event.shiftKey) return false
      event.preventDefault()
      act.choose()
      return true
    case 'Escape':
      event.preventDefault()
      act.close()
      return true
    default:
      return false
  }
}

/** The list over the field: the files and folders, or why there are none yet. */
export function MentionList({
  listId,
  options,
  active,
  state,
  onChoose,
  onHover,
}: {
  listId: string
  options: readonly MentionOption[]
  active: number
  /** `ready` — the list is read; `preparing` — the files are being read; `none` — no files. */
  state: 'ready' | 'preparing' | 'none'
  onChoose: (option: MentionOption) => void
  onHover: (index: number) => void
}) {
  const activeRow = useRef<HTMLElement | null>(null)
  useEffect(() => {
    activeRow.current?.scrollIntoView?.({ block: 'nearest' })
  }, [active])
  const empty =
    state === 'preparing'
      ? mentionText.preparing
      : state === 'none'
        ? mentionText.none
        : options.length === 0
          ? mentionText.nothing
          : null
  return (
    <Box
      id={listId}
      role="listbox"
      aria-label={mentionText.label}
      tabIndex={-1}
      sx={{
        m: 0,
        p: 0.75,
        maxHeight: `min(420px, 50dvh, var(${PALETTE_ROOM}, 420px))`,
        overflowY: 'auto',
        bgcolor: 'background.paper',
        border: 1,
        borderColor: 'divider',
        borderRadius: '16px',
        boxShadow: '0 8px 24px -12px rgba(0, 0, 0, 0.18)',
      }}
    >
      {empty !== null ? (
        <Typography role="status" sx={{ px: 1.25, py: 1, fontSize: 14, color: 'text.secondary' }}>
          {empty}
        </Typography>
      ) : (
        options.map((option, index) => {
          const selected = index === active
          const trimmed = option.path.replace(/\/$/u, '')
          const cut = trimmed.lastIndexOf('/')
          const name = trimmed.slice(cut + 1)
          const where = cut < 0 ? '' : trimmed.slice(0, cut + 1)
          return (
            <Box
              key={option.path}
              ref={selected ? activeRow : undefined}
              id={mentionOptionId(listId, index)}
              role="option"
              aria-selected={selected}
              aria-label={option.folder ? mentionText.folder(option.path) : option.path}
              // The field keeps the focus: a press must not take it away before the choice.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHover(index)}
              onClick={() => onChoose(option)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                minHeight: 40,
                px: 1.25,
                py: 0.5,
                borderRadius: '10px',
                cursor: 'pointer',
                bgcolor: selected ? 'action.selected' : 'transparent',
              }}
            >
              <Box component="span" sx={{ display: 'flex', color: 'text.secondary' }}>
                <AppIcon name={option.folder ? 'folder' : 'file'} size={16} />
              </Box>
              <Typography
                component="span"
                sx={{
                  minWidth: 0,
                  fontSize: 14,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  direction: 'ltr',
                }}
              >
                <Box component="span" sx={{ fontWeight: 500 }}>
                  {name}
                  {option.folder ? '/' : ''}
                </Box>
                {where !== '' ? (
                  <Box component="span" sx={{ color: 'text.secondary', ml: 1 }}>
                    {where}
                  </Box>
                ) : null}
              </Typography>
            </Box>
          )
        })
      )}
    </Box>
  )
}
