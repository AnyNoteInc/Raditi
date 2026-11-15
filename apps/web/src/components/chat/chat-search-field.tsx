'use client'

import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import InputBase from '@mui/material/InputBase'

import { AppIcon } from '@/components/application/app-icon'

import { listText } from './chat-texts'

// The field of a search of chats, the same in «Поиск чатов» and «Архив чатов» (owner's request of
// 15.11.2026, docs/plan/79-chat-search-window.md, П2, П3): one cross of its own that clears the
// words — the browser's cross of a search field is hidden —, and the ring of the focus drawn inside
// the field, so the window that holds it never cuts its top off.

export function ChatSearchField({
  value,
  onChange,
  label,
}: {
  value: string
  onChange: (value: string) => void
  /** What the field is called, and its placeholder. */
  label: string
}) {
  return (
    <Box
      role="search"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        minHeight: 44,
        pl: 1.25,
        pr: 0.5,
        borderRadius: '10px',
        bgcolor: 'action.hover',
        color: 'text.secondary',
        '&:focus-within': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
      }}
    >
      <AppIcon name="search" size={16} />
      <InputBase
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value.slice(0, 100))}
        placeholder={label}
        inputProps={{ 'aria-label': label, type: 'search' }}
        sx={{
          flex: 1,
          fontSize: 14,
          color: 'text.primary',
          '& input::-webkit-search-cancel-button, & input::-webkit-search-decoration': {
            WebkitAppearance: 'none',
            appearance: 'none',
            display: 'none',
          },
        }}
      />
      {value !== '' ? (
        <IconButton
          aria-label={listText.searchClear}
          onClick={() => onChange('')}
          sx={{ width: 36, height: 36, color: 'text.secondary' }}
        >
          <AppIcon name="close" size={16} />
        </IconButton>
      ) : null}
    </Box>
  )
}
