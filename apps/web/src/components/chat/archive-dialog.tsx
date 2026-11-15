'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useDeferredValue, useEffect, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC, useTRPCClient } from '@/trpc/client'

import { chatHref } from './chat-address'
import { listTime } from './chat-format'
import { ChatSearchField } from './chat-search-field'
import { listText } from './chat-texts'
import type { DialogListItem } from './chat-types'
import { dialogListKey } from './dialog-actions'

// «Архив» (owner's request of 14.11.2026, docs/plan/76-agent-instructions.md, И9): the button is
// pinned at the very bottom of the list of chats; it opens this window — the archived chats, the
// latest changed first, a search among them, and «Восстановить», which brings a chat back to the
// list. A chat opens from here too.

export const archiveText = Object.freeze({
  open: 'Архив',
  title: 'Архив чатов',
  close: 'Закрыть',
  search: 'Найти в архиве',
  restore: 'Восстановить',
  restored: 'Чат вернулся в список.',
  empty: 'В архиве пока нет чатов.',
  notFound: 'В архиве ничего не нашлось.',
  loading: 'Загружаем архив',
  more: 'Показать ещё',
})

function useRested(words: string): string {
  const [rested, setRested] = useState(words)
  useEffect(() => {
    const later = window.setTimeout(() => setRested(words), 300)
    return () => window.clearTimeout(later)
  }, [words])
  return useDeferredValue(rested)
}

function ArchivedRow({
  item,
  onRestore,
  restoring,
  onOpen,
}: {
  item: DialogListItem
  onRestore: () => void
  restoring: boolean
  onOpen: () => void
}) {
  const now = new Date()
  return (
    <Box
      component="li"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        py: 1,
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Box
        component={Link}
        href={chatHref(item.id)}
        onClick={onOpen}
        sx={{
          flex: '1 1 auto',
          minWidth: 0,
          minHeight: 44,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          color: 'text.primary',
          textDecoration: 'none',
          '&:hover': { textDecoration: 'underline' },
        }}
      >
        <Typography
          component="span"
          sx={{ fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {item.title ?? listText.untitled}
        </Typography>
        <Typography component="span" variant="caption" color="text.secondary">
          {listTime(item.updatedAt, now)}
        </Typography>
      </Box>
      <Button
        size="small"
        variant="outlined"
        loading={restoring}
        onClick={onRestore}
        sx={{ minHeight: 44, borderRadius: '999px', flex: 'none' }}
      >
        {archiveText.restore}
      </Button>
    </Box>
  )
}

export function ArchiveDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useTRPCClient()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [words, setWords] = useState('')
  const [said, setSaid] = useState<string | null>(null)
  const query = useRested(words).replace(/\s+/gu, ' ').trim()
  const restore = useMutation(trpc.task.archive.mutationOptions())
  const pages = useInfiniteQuery({
    queryKey: [...dialogListKey, 'archive'],
    queryFn: ({ pageParam }) =>
      client.task.list.query({
        view: 'archive',
        ...(pageParam === null ? {} : { cursor: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: open && query === '',
  })
  const found = useQuery({
    queryKey: [...dialogListKey, 'archive-search', query],
    queryFn: () => client.task.search.query({ query, archive: true }),
    enabled: open && query !== '',
  })
  const items =
    query === ''
      ? (pages.data?.pages.flatMap((page) => page.items) ?? [])
      : (found.data?.items ?? [])
  const loading = query === '' ? pages.isPending : found.isPending

  async function bringBack(item: DialogListItem) {
    setSaid(null)
    await restore.mutateAsync({ taskId: item.id, archived: false })
    setSaid(archiveText.restored)
    await queryClient.invalidateQueries({ queryKey: dialogListKey })
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="archive-title">
      <DialogTitle id="archive-title" sx={{ display: 'flex', alignItems: 'center', pr: 1 }}>
        <Box component="span" sx={{ flex: 1 }}>
          {archiveText.title}
        </Box>
        <IconButton aria-label={archiveText.close} onClick={onClose} sx={{ width: 44, height: 44 }}>
          <AppIcon name="close" size={18} />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <ChatSearchField value={words} onChange={setWords} label={archiveText.search} />
        {said ? (
          <Typography role="status" variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            {said}
          </Typography>
        ) : null}
        {loading ? (
          <Box
            role="status"
            aria-label={archiveText.loading}
            sx={{ mt: 2, display: 'grid', gap: 1 }}
          >
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} variant="rounded" height={52} />
            ))}
          </Box>
        ) : items.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            {query === '' ? archiveText.empty : archiveText.notFound}
          </Typography>
        ) : (
          <Box
            component="ul"
            aria-label={archiveText.title}
            sx={{ listStyle: 'none', m: 0, mt: 1, p: 0 }}
          >
            {items.map((item) => (
              <ArchivedRow
                key={item.id}
                item={item}
                restoring={restore.isPending && restore.variables?.taskId === item.id}
                onRestore={() => void bringBack(item)}
                onOpen={onClose}
              />
            ))}
          </Box>
        )}
        {query === '' && pages.hasNextPage ? (
          <Button
            onClick={() => void pages.fetchNextPage()}
            loading={pages.isFetchingNextPage}
            sx={{ mt: 1.5, minHeight: 44 }}
          >
            {archiveText.more}
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
