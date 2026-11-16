'use client'

import Box from '@mui/material/Box'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useDeferredValue, useEffect, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPCClient } from '@/trpc/client'

import { chatHref } from './chat-address'
import { listTime } from './chat-format'
import { ChatSearchField } from './chat-search-field'
import { listText } from './chat-texts'
import type { DialogListItem } from './chat-types'
import { dialogListKey } from './dialog-actions'

// «Поиск чатов» (owner's request of 15.11.2026, docs/plan/79-chat-search-window.md, П1): the loupe
// of the head of the column opens this window — a field, and under it the latest chats, or, once
// words are typed and rest, the chats whose title or the client's messages hold them, «Архив»
// too. A chat opens from here and the window closes.

export const searchText = Object.freeze({
  title: 'Поиск чатов',
  close: 'Закрыть',
  recent: 'Недавние чаты',
  found: 'Найденные чаты',
  archived: 'в архиве',
  empty: 'Чатов пока нет.',
})

function useRested(words: string): string {
  const [rested, setRested] = useState(words)
  useEffect(() => {
    const later = window.setTimeout(() => setRested(words), 300)
    return () => window.clearTimeout(later)
  }, [words])
  return useDeferredValue(rested)
}

function FoundRow({ item, onOpen }: { item: DialogListItem; onOpen: () => void }) {
  const now = new Date()
  return (
    <Box component="li">
      <Box
        component={Link}
        href={chatHref(item.id)}
        onClick={onOpen}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.25,
          minHeight: 52,
          px: 1.25,
          py: 0.75,
          borderRadius: '10px',
          color: 'text.primary',
          textDecoration: 'none',
          '&:hover, &:focus-visible': { bgcolor: 'action.hover' },
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: -2,
          },
        }}
      >
        {/* A run of a scheduled task shows its stopwatch (docs/plan/82, Зп43). */}
        <Box component="span" sx={{ display: 'flex', color: 'text.secondary' }}>
          <AppIcon name={item.schedule ? 'timer' : 'chat'} size={16} />
        </Box>
        <Box
          component="span"
          sx={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column' }}
        >
          <Typography
            component="span"
            sx={{
              fontSize: 14,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {item.title ?? listText.untitled}
          </Typography>
          <Typography component="span" variant="caption" color="text.secondary">
            {listTime(item.updatedAt, now)}
            {item.archived ? ` · ${searchText.archived}` : ''}
          </Typography>
        </Box>
      </Box>
    </Box>
  )
}

export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useTRPCClient()
  const [words, setWords] = useState('')
  const query = useRested(words).replace(/\s+/gu, ' ').trim()
  const recent = useQuery({
    queryKey: [...dialogListKey, 'search-recent'],
    queryFn: () => client.task.list.query({}),
    enabled: open && query === '',
  })
  const found = useQuery({
    queryKey: [...dialogListKey, 'search', query],
    queryFn: () => client.task.search.query({ query }),
    enabled: open && query !== '',
  })
  const source = query === '' ? recent : found
  const items =
    query === ''
      ? [...(recent.data?.pinned ?? []), ...(recent.data?.items ?? [])].slice(0, 20)
      : (found.data?.items ?? [])

  function close() {
    setWords('')
    onClose()
  }

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="sm" aria-labelledby="search-title">
      <DialogTitle id="search-title" sx={{ display: 'flex', alignItems: 'center', pr: 1 }}>
        <Box component="span" sx={{ flex: 1 }}>
          {searchText.title}
        </Box>
        <IconButton aria-label={searchText.close} onClick={close} sx={{ width: 44, height: 44 }}>
          <AppIcon name="close" size={18} />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ minHeight: { sm: 360 } }}>
        <ChatSearchField value={words} onChange={setWords} label={listText.search} />
        {source.isPending ? (
          <Box
            role="status"
            aria-label={listText.searchLoading}
            sx={{ mt: 2, display: 'grid', gap: 1 }}
          >
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} variant="rounded" height={52} />
            ))}
          </Box>
        ) : items.length === 0 ? (
          <Typography role="status" variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            {query === '' ? searchText.empty : listText.searchEmpty}
          </Typography>
        ) : (
          <>
            <Typography
              id="search-list"
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', mt: 2, mb: 0.5, px: 1.25 }}
            >
              {query === '' ? searchText.recent : searchText.found}
            </Typography>
            <Box
              component="ul"
              aria-labelledby="search-list"
              sx={{ listStyle: 'none', m: 0, p: 0 }}
            >
              {items.map((item) => (
                <FoundRow key={item.id} item={item} onOpen={close} />
              ))}
            </Box>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
