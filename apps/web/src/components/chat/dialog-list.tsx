'use client'

import { feedStateText, taskStatusListHint } from '@repo/domain/tasks/client-feed-labels'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { useInfiniteQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useSelectedLayoutSegment } from 'next/navigation'
import { useId, useState } from 'react'

import { siteHref } from '@/components/site/site-nav'
import { useTRPCClient } from '@/trpc/client'

import { dialogGroups, listTime } from './chat-format'
import { listText, undoText } from './chat-texts'
import type { DialogListItem } from './chat-types'
import { DialogMenuButton, dialogListKey, RemoveDialogConfirm, RenameField } from './dialog-actions'
import { StatusMark } from './status-mark'

export { dialogListKey }

/** The list is read again this often while the page is shown, to follow the statuses. */
const LIST_REFRESH_MS = 15_000

function DialogLink({
  siteId,
  item,
  current,
  now,
}: {
  siteId: string
  item: DialogListItem
  current: boolean
  now: Date
}) {
  // A closed dialog whose release is being undone, or was: said beside its status (Р44).
  const hint =
    item.undo === 'running'
      ? undoText.running
      : item.undo === 'installed'
        ? undoText.installed
        : item.answered
          ? null
          : taskStatusListHint[item.status]
  return (
    <Box
      component={Link}
      href={`${siteHref(siteId, 'chat')}/${item.id}`}
      aria-current={current ? 'page' : undefined}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: '1px',
        minHeight: { xs: 44, md: 40 },
        justifyContent: 'center',
        px: 1.25,
        // The menu of the row stands at its right end: under a finger always, so room is kept;
        // where a pointer hovers it shows in place of the time.
        '@media (hover: none)': { pr: 6 },
        py: 0.75,
        borderRadius: '10px',
        textDecoration: 'none',
        color: 'text.primary',
        bgcolor: current ? 'action.selected' : 'transparent',
        transition: 'background-color var(--raditi-motion-fast) var(--raditi-ease-out)',
        '&:hover': { bgcolor: current ? 'action.selected' : 'action.hover' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
      }}
    >
      <Box component="span" sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0 }}>
        <Typography
          component="span"
          sx={{
            flex: '1 1 auto',
            minWidth: 0,
            fontSize: 14,
            fontWeight: current ? 500 : 400,
            lineHeight: 1.45,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {item.title ?? listText.untitled}
        </Typography>
        <Typography
          component="span"
          variant="caption"
          color="text.secondary"
          data-dialog-time=""
          sx={{ flex: 'none', whiteSpace: 'nowrap' }}
        >
          {listTime(item.updatedAt, now)}
        </Typography>
      </Box>
      <Box
        component="span"
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0 6px',
          minWidth: 0,
          fontSize: 12,
          color: 'text.secondary',
          '& svg': { width: 13, height: 13 },
        }}
      >
        <StatusMark status={item.status} answered={item.answered} />
        {hint ? (
          <Typography component="span" variant="caption" color="text.secondary">
            {hint}
          </Typography>
        ) : null}
      </Box>
    </Box>
  )
}

/**
 * A row of the list: the link to the dialog and its menu (owner's request of 26.10.2026) —
 * «Переименовать» writes the name in place of the link, «Удалить» asks first. Where a pointer
 * hovers, the menu shows on hover and focus of the row, in place of its time.
 */
function DialogRow({
  siteId,
  item,
  current,
  now,
}: {
  siteId: string
  item: DialogListItem
  current: boolean
  now: Date
}) {
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const title = item.title ?? listText.untitled
  return (
    <Box
      sx={{
        position: 'relative',
        '@media (hover: hover)': {
          '&:hover [data-dialog-menu], &:focus-within [data-dialog-menu]': { opacity: 1 },
          '&:hover [data-dialog-time], &:focus-within [data-dialog-time]': { visibility: 'hidden' },
        },
      }}
    >
      {renaming ? (
        <Box sx={{ py: 0.5 }}>
          <RenameField
            siteId={siteId}
            taskId={item.id}
            initial={item.title ?? ''}
            onDone={() => setRenaming(false)}
          />
        </Box>
      ) : (
        <>
          <DialogLink siteId={siteId} item={item} current={current} now={now} />
          <Box sx={{ position: 'absolute', right: 2, top: 2 }}>
            <DialogMenuButton
              quiet
              title={title}
              onRename={() => setRenaming(true)}
              onRemove={() => setRemoving(true)}
            />
          </Box>
        </>
      )}
      {removing ? (
        <RemoveDialogConfirm
          siteId={siteId}
          taskId={item.id}
          open
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </Box>
  )
}

function DialogGroup({
  siteId,
  label,
  items,
  currentId,
  now,
}: {
  siteId: string
  label: string
  items: readonly DialogListItem[]
  currentId: string | null
  now: Date
}) {
  const labelId = useId()
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Typography
        id={labelId}
        variant="caption"
        color="text.secondary"
        sx={{ px: 1.25, pt: 1, pb: 0.25, fontWeight: 500 }}
      >
        {label}
      </Typography>
      <Box
        component="ul"
        aria-labelledby={labelId}
        sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '2px' }}
      >
        {items.map((item) => (
          <li key={item.id}>
            <DialogRow
              siteId={siteId}
              item={item}
              current={item.id.toLowerCase() === currentId}
              now={now}
            />
          </li>
        ))}
      </Box>
    </Box>
  )
}

/**
 * The dialogs of a site in the column of «Чат»: those that wait for the client first, then the
 * ones started today and earlier, each with its status in a sign and a word and its time. The
 * open dialog is the current page. The list follows the statuses while the page is shown.
 */
export function DialogList({ siteId }: { siteId: string }) {
  const client = useTRPCClient()
  const segment = useSelectedLayoutSegment()
  const currentId = segment === null ? null : segment.toLowerCase()
  const list = useInfiniteQuery({
    queryKey: dialogListKey(siteId),
    queryFn: ({ pageParam }) =>
      client.task.list.query(pageParam === null ? { siteId } : { siteId, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: LIST_REFRESH_MS,
  })

  if (list.isPending) {
    return (
      <Box role="status" aria-label={listText.loading} sx={{ display: 'grid', gap: 1, pt: 1 }}>
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} variant="rounded" height={56} sx={{ borderRadius: '12px' }} />
        ))}
      </Box>
    )
  }
  if (list.isError) {
    return (
      <Alert
        severity="error"
        sx={{ borderRadius: '12px' }}
        action={
          <Button
            color="inherit"
            size="small"
            sx={{ minHeight: 44 }}
            loading={list.isFetching}
            onClick={() => void list.refetch()}
          >
            {feedStateText.listRetry}
          </Button>
        }
      >
        {feedStateText.listFailed}
      </Alert>
    )
  }

  const items = list.data.pages.flatMap((page) => page.items)
  if (items.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        {listText.empty}
      </Typography>
    )
  }
  const now = new Date()
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mx: { md: -1.5 } }}>
      {dialogGroups(items, now).map((group) => (
        <DialogGroup
          key={group.key}
          siteId={siteId}
          label={group.label}
          items={group.items}
          currentId={currentId}
          now={now}
        />
      ))}
      {list.hasNextPage ? (
        <Button
          variant="outlined"
          onClick={() => void list.fetchNextPage()}
          loading={list.isFetchingNextPage}
          sx={{ alignSelf: 'flex-start', minHeight: 44, borderRadius: '999px', ml: 1.5 }}
        >
          {listText.more}
        </Button>
      ) : null}
    </Box>
  )
}
