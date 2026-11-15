'use client'

import { feedStateText, taskStatusListHint } from '@repo/domain/tasks/client-feed-labels'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { useInfiniteQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useSelectedLayoutSegment } from 'next/navigation'
import { useId, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPCClient } from '@/trpc/client'

import { chatHref } from './chat-address'
import { dialogGroups, listTime } from './chat-format'
import { listText } from './chat-texts'
import type { DialogListItem } from './chat-types'
import { ArchiveDialog, archiveText } from './archive-dialog'
import {
  DialogMenuButton,
  dialogListKey,
  RemoveDialogConfirm,
  RenameField,
  usePinArchive,
} from './dialog-actions'
import { StatusMark } from './status-mark'

export { dialogListKey }

/** The list is read again this often while the page is shown, to follow the statuses. */
const LIST_REFRESH_MS = 15_000

/** How long the words of the search rest before they are asked (ВВ21). */

/**
 * The pages of one list: every chat of the user; `archive` — «Архив»
 * (docs/plan/75-chat-input-output.md, ВВ21). The first page of the list carries its pinned chats.
 */
function useChatPages(view: 'active' | 'archive' = 'active') {
  const client = useTRPCClient()
  return useInfiniteQuery({
    queryKey: view === 'archive' ? [...dialogListKey, 'archive'] : [...dialogListKey, 'all'],
    queryFn: ({ pageParam }) =>
      client.task.list.query({
        ...(pageParam === null ? {} : { cursor: pageParam }),
        ...(view === 'archive' ? { view } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: LIST_REFRESH_MS,
  })
}

/** The user has no chat at all, as the server said: nothing to group yet. */
export function useChatsKnownEmpty(): boolean {
  const list = useChatPages()
  const first = list.data?.pages[0]
  return first !== undefined && first.items.length === 0 && first.pinned.length === 0
}

function ListLoading() {
  return (
    <Box role="status" aria-label={listText.loading} sx={{ display: 'grid', gap: 1, pt: 1 }}>
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} variant="rounded" height={56} sx={{ borderRadius: '12px' }} />
      ))}
    </Box>
  )
}

function ListFailed({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <Alert
      severity="error"
      sx={{ borderRadius: '12px' }}
      action={
        <Button
          color="inherit"
          size="small"
          sx={{ minHeight: 44 }}
          loading={retrying}
          onClick={onRetry}
        >
          {feedStateText.listRetry}
        </Button>
      }
    >
      {feedStateText.listFailed}
    </Alert>
  )
}

function ShowMore({
  loading,
  onMore,
  inset,
}: {
  loading: boolean
  onMore: () => void
  inset: number
}) {
  return (
    <Button
      variant="outlined"
      onClick={onMore}
      loading={loading}
      sx={{ alignSelf: 'flex-start', minHeight: 44, borderRadius: '999px', ml: inset }}
    >
      {listText.more}
    </Button>
  )
}

function DialogLink({ item, current, now }: { item: DialogListItem; current: boolean; now: Date }) {
  const hint = item.answered || item.failed ? null : taskStatusListHint[item.status]
  // On the fill of the open dialog the cabinet's quiet colour falls under 4.5:1 in the dark scheme
  // (4.4:1): its time and second line take the colour of the text.
  const quiet = current ? 'text.primary' : 'text.secondary'
  return (
    <Box
      component={Link}
      href={chatHref(item.id)}
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
          color={quiet}
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
          color: quiet,
          '& svg': { width: 13, height: 13 },
        }}
      >
        <StatusMark
          status={item.status}
          answered={item.answered}
          rewound={item.rewound}
          failed={item.failed}
          onFill={current}
        />
        {hint ? (
          <Typography component="span" variant="caption" color={quiet}>
            {hint}
          </Typography>
        ) : null}
        {item.archived ? (
          <Typography component="span" variant="caption" color={quiet}>
            <span aria-hidden="true">· </span>
            {listText.inArchive}
          </Typography>
        ) : null}
        {item.telegram ? (
          <Typography component="span" variant="caption" color={quiet}>
            <span aria-hidden="true">· </span>
            {listText.inTelegram}
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
function DialogRow({ item, current, now }: { item: DialogListItem; current: boolean; now: Date }) {
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const keep = usePinArchive()
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
            taskId={item.id}
            initial={item.title ?? ''}
            onDone={() => setRenaming(false)}
          />
        </Box>
      ) : (
        <>
          <DialogLink item={item} current={current} now={now} />
          <Box sx={{ position: 'absolute', right: 2, top: 2 }}>
            <DialogMenuButton
              quiet
              title={title}
              onRename={() => setRenaming(true)}
              onRemove={() => setRemoving(true)}
              pin={{ pinned: item.pinned, onToggle: () => keep.pin(item.id, !item.pinned) }}
              archive={{
                archived: item.archived,
                onToggle: () => keep.archive(item.id, !item.archived),
              }}
            />
          </Box>
        </>
      )}
      {removing ? (
        <RemoveDialogConfirm taskId={item.id} open onClose={() => setRemoving(false)} />
      ) : null}
    </Box>
  )
}

function DialogRows({
  items,
  labelledBy,
  currentId,
  now,
}: {
  items: readonly DialogListItem[]
  labelledBy: string
  currentId: string | null
  now: Date
}) {
  return (
    <Box
      component="ul"
      aria-labelledby={labelledBy}
      sx={{
        m: 0,
        p: 0,
        listStyle: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      }}
    >
      {items.map((item) => (
        <li key={item.id}>
          <DialogRow item={item} current={item.id.toLowerCase() === currentId} now={now} />
        </li>
      ))}
    </Box>
  )
}

function DialogGroup({
  label,
  items,
  currentId,
  now,
}: {
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
      <DialogRows items={items} labelledBy={labelId} currentId={currentId} now={now} />
    </Box>
  )
}

/** «Одним списком»: those that wait for the client first, then today and earlier. */
function OneList({ currentId }: { currentId: string | null }) {
  const list = useChatPages()
  if (list.isPending) return <ListLoading />
  if (list.isError)
    return <ListFailed retrying={list.isFetching} onRetry={() => void list.refetch()} />
  const items = list.data.pages.flatMap((page) => page.items)
  const pinned = list.data.pages[0]?.pinned ?? []
  if (items.length === 0 && pinned.length === 0) return <EmptyList />
  const now = new Date()
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mx: { md: -1.5 } }}>
      {pinned.length > 0 ? (
        <DialogGroup label={listText.pinned} items={pinned} currentId={currentId} now={now} />
      ) : null}
      {dialogGroups(items, now).map((group) => (
        <DialogGroup
          key={group.key}
          label={group.label}
          items={group.items}
          currentId={currentId}
          now={now}
        />
      ))}
      {list.hasNextPage ? (
        <ShowMore
          inset={1.5}
          loading={list.isFetchingNextPage}
          onMore={() => void list.fetchNextPage()}
        />
      ) : null}
    </Box>
  )
}

function EmptyList() {
  return (
    <Typography variant="body2" color="text.secondary">
      {listText.empty}
    </Typography>
  )
}

/**
 * «Архив» pinned at the very bottom of the list (owner's request of 14.11.2026,
 * docs/plan/76-agent-instructions.md, И9): it opens the window of the archive.
 */
export function ArchiveButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <ButtonBase
        aria-haspopup="dialog"
        data-archive=""
        onClick={() => setOpen(true)}
        sx={{
          width: '100%',
          minHeight: 44,
          display: 'flex',
          justifyContent: 'flex-start',
          gap: 1,
          px: 1.25,
          borderRadius: '10px',
          fontSize: 14,
          color: 'text.secondary',
          '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
        }}
      >
        <AppIcon name="archive" size={16} />
        {archiveText.open}
      </ButtonBase>
      <ArchiveDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}

/** The field «Найти чат» over the list (ВВ21). */
/**
 * The chats of the user in the column of «Чаты», each with its status in a sign and a word and
 * its time. The open chat is the current page. The list follows the statuses while the page is
 * shown.
 */
export function DialogList() {
  const segment = useSelectedLayoutSegment()
  const currentId = segment === null ? null : segment.toLowerCase()
  return <OneList currentId={currentId} />
}
