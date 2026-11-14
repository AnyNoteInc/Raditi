'use client'

import { feedStateText, taskStatusListHint } from '@repo/domain/tasks/client-feed-labels'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import InputBase from '@mui/material/InputBase'
import IconButton from '@mui/material/IconButton'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useSelectedLayoutSegment } from 'next/navigation'
import { useDeferredValue, useEffect, useId, useState, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPCClient } from '@/trpc/client'

import { chatHref, NEW_CHAT_SEGMENT } from './chat-address'
import { dialogGroups, listTime } from './chat-format'
import { chatsText, listText, undoText } from './chat-texts'
import type { ChatFolder, DialogListItem } from './chat-types'
import { offScreen } from './composer'
import {
  DialogMenuButton,
  dialogListKey,
  RemoveDialogConfirm,
  RenameField,
  usePinArchive,
} from './dialog-actions'
import { ProjectMark } from './project-mark'
import { StatusMark } from './status-mark'

export { dialogListKey }

/** The list is read again this often while the page is shown, to follow the statuses. */
const LIST_REFRESH_MS = 15_000

/** The key of a folder for the chats without a project (`task.list` takes the same word). */
const NO_PROJECT = 'none'
const folderKey = (folder: ChatFolder) => folder.project?.id ?? NO_PROJECT

/** How long the words of the search rest before they are asked (ВВ21). */
const SEARCH_PAUSE_MS = 300

/**
 * The pages of one list: every chat of the user, or of one folder; `archive` — «Архив»
 * (docs/plan/75-chat-input-output.md, ВВ21). The first page of the list carries its pinned chats.
 */
function useChatPages(folder: string | null, view: 'active' | 'archive' = 'active') {
  const client = useTRPCClient()
  return useInfiniteQuery({
    queryKey:
      view === 'archive'
        ? [...dialogListKey, 'archive']
        : folder === null
          ? [...dialogListKey, 'all']
          : [...dialogListKey, 'folder', folder],
    queryFn: ({ pageParam }) =>
      client.task.list.query({
        ...(folder === null ? {} : { folder }),
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
  const list = useChatPages(null)
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

function DialogLink({
  item,
  current,
  now,
  inFolder,
}: {
  item: DialogListItem
  current: boolean
  now: Date
  inFolder: boolean
}) {
  // A closed dialog whose release is being undone, or was: said beside its status (Р44).
  const hint =
    item.undo === 'running'
      ? undoText.running
      : item.undo === 'installed'
        ? undoText.installed
        : item.answered || item.failed
          ? null
          : taskStatusListHint[item.status]
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
        {/* In a folder its name is the folder's. */}
        {item.project !== null && !inFolder ? (
          <Typography
            component="span"
            variant="caption"
            color={quiet}
            noWrap
            sx={{ minWidth: 0, maxWidth: '100%' }}
          >
            <span aria-hidden="true">· </span>
            {item.project.name}
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
  item,
  current,
  now,
  inFolder = false,
}: {
  item: DialogListItem
  current: boolean
  now: Date
  inFolder?: boolean
}) {
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
          <DialogLink item={item} current={current} now={now} inFolder={inFolder} />
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
        <RemoveDialogConfirm
          taskId={item.id}
          withSite={item.project !== null}
          open
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </Box>
  )
}

function DialogRows({
  items,
  labelledBy,
  currentId,
  now,
  inFolder = false,
}: {
  items: readonly DialogListItem[]
  labelledBy: string
  currentId: string | null
  now: Date
  inFolder?: boolean
}) {
  return (
    <Box
      component="ul"
      aria-labelledby={labelledBy}
      sx={{
        m: 0,
        p: 0,
        ...(inFolder && { ml: 2.25 }),
        listStyle: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      }}
    >
      {items.map((item) => (
        <li key={item.id}>
          <DialogRow
            item={item}
            current={item.id.toLowerCase() === currentId}
            now={now}
            inFolder={inFolder}
          />
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
  const list = useChatPages(null)
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

/** The chats of an open folder, read only once it is open. */
function FolderChats({
  folder,
  labelledBy,
  currentId,
}: {
  folder: string
  labelledBy: string
  currentId: string | null
}) {
  const list = useChatPages(folder)
  if (list.isPending) return <ListLoading />
  if (list.isError)
    return <ListFailed retrying={list.isFetching} onRetry={() => void list.refetch()} />
  const now = new Date()
  return (
    <>
      <DialogRows
        items={[
          ...(list.data.pages[0]?.pinned ?? []),
          ...list.data.pages.flatMap((page) => page.items),
        ]}
        labelledBy={labelledBy}
        currentId={currentId}
        now={now}
        inFolder
      />
      {list.hasNextPage ? (
        <ShowMore
          inset={2.25}
          loading={list.isFetchingNextPage}
          onMore={() => void list.fetchNextPage()}
        />
      ) : null}
    </>
  )
}

function Folder({
  folder,
  open,
  onToggle,
  children,
}: {
  folder: ChatFolder
  open: boolean
  onToggle: () => void
  children: (labelledBy: string) => ReactNode
}) {
  const labelId = useId()
  const name = folder.project?.name ?? chatsText.noProject
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <ButtonBase
        aria-expanded={open}
        onClick={onToggle}
        sx={{
          width: '100%',
          minHeight: 44,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          gap: 1,
          pl: 0.75,
          pr: 1.25,
          borderRadius: '10px',
          fontSize: 14,
          fontWeight: 500,
          textAlign: 'left',
          color: 'text.primary',
          '&:hover': { bgcolor: 'action.hover' },
        }}
      >
        <AppIcon name={open ? 'down' : 'chevron'} size={16} />
        {folder.project === null ? (
          <ProjectMark sign={<AppIcon name="chat" size={13} />} />
        ) : (
          <ProjectMark name={folder.project.name} />
        )}
        <Box
          id={labelId}
          component="span"
          sx={{
            flex: '1 1 auto',
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {name}
        </Box>
        {folder.attention && !open ? (
          <>
            <Box
              component="span"
              aria-hidden="true"
              sx={{
                flex: 'none',
                width: 8,
                height: 8,
                borderRadius: '50%',
                bgcolor: 'var(--raditi-accent)',
              }}
            />
            <Box component="span" sx={offScreen}>
              {`. ${chatsText.attention}. `}
            </Box>
          </>
        ) : null}
        <Typography component="span" variant="caption" color="text.secondary">
          {folder.count}
        </Typography>
      </ButtonBase>
      {open ? children(labelId) : null}
    </Box>
  )
}

/**
 * «По проектам» (docs/plan/61-chats-first.md, К23): the folders the server counted, «Без проекта»
 * the last; a folder reads its chats only once it is open. The folder of the open chat is open,
 * so is the folder the address names and the only one there is; the client's own press wins.
 */
function Folders({ asked, currentId }: { asked: string | null; currentId: string | null }) {
  const client = useTRPCClient()
  const folders = useQuery({
    queryKey: [...dialogListKey, 'folders'],
    queryFn: () => client.task.folders.query({}),
    refetchInterval: LIST_REFRESH_MS,
  })
  // A segment of the section that is no chat names no folder.
  const openChat = currentId === null || currentId === NEW_CHAT_SEGMENT ? null : currentId
  const shown = useQuery({
    queryKey: [...dialogListKey, 'chat', openChat],
    queryFn: () => client.task.get.query({ taskId: openChat ?? '' }),
    enabled: openChat !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const current =
    openChat === null ? null : shown.data ? (shown.data.project?.id ?? NO_PROJECT) : null
  const [pressed, setPressed] = useState<Readonly<Record<string, boolean>>>({})
  // Moving to a chat of a folder the client closed opens it again: the open chat stays in sight.
  const [followed, setFollowed] = useState(current)
  if (followed !== current) {
    setFollowed(current)
    if (current !== null && current in pressed) {
      const { [current]: _forgotten, ...rest } = pressed
      setPressed(rest)
    }
  }

  if (folders.isPending) return <ListLoading />
  if (folders.isError)
    return <ListFailed retrying={folders.isFetching} onRetry={() => void folders.refetch()} />
  if (folders.data.folders.length === 0) return <EmptyList />
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mx: { md: -1.5 } }}>
      {folders.data.folders.map((folder) => {
        const key = folderKey(folder)
        const open =
          pressed[key] ?? (key === asked || key === current || folders.data.folders.length === 1)
        return (
          <Folder
            key={key}
            folder={folder}
            open={open}
            onToggle={() => setPressed({ ...pressed, [key]: !open })}
          >
            {(labelledBy) => (
              <FolderChats folder={key} labelledBy={labelledBy} currentId={currentId} />
            )}
          </Folder>
        )
      })}
    </Box>
  )
}

/** «Архив» at the end of the list (ВВ21): read only once it is opened. */
function ArchiveSection({ currentId }: { currentId: string | null }) {
  const [open, setOpen] = useState(false)
  const labelId = useId()
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mx: { md: -1.5 } }}>
      <ButtonBase
        aria-expanded={open}
        data-archive=""
        onClick={() => setOpen(!open)}
        sx={{
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
        <Box component="span" id={labelId}>
          {listText.archive}
        </Box>
        <Box component="span" sx={offScreen}>
          {open ? listText.archiveClose : listText.archiveOpen}
        </Box>
      </ButtonBase>
      {open ? <ArchiveChats labelledBy={labelId} currentId={currentId} /> : null}
    </Box>
  )
}

function ArchiveChats({ labelledBy, currentId }: { labelledBy: string; currentId: string | null }) {
  const list = useChatPages(null, 'archive')
  if (list.isPending) return <ListLoading />
  if (list.isError)
    return <ListFailed retrying={list.isFetching} onRetry={() => void list.refetch()} />
  const items = list.data.pages.flatMap((page) => page.items)
  if (items.length === 0)
    return (
      <Typography variant="body2" color="text.secondary" sx={{ px: 1.25 }}>
        {listText.archiveEmpty}
      </Typography>
    )
  return (
    <>
      <DialogRows items={items} labelledBy={labelledBy} currentId={currentId} now={new Date()} />
      {list.hasNextPage ? (
        <ShowMore
          inset={1.5}
          loading={list.isFetchingNextPage}
          onMore={() => void list.fetchNextPage()}
        />
      ) : null}
    </>
  )
}

/** The field «Найти чат» over the list (ВВ21). */
function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Box
      role="search"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        minHeight: 40,
        px: 1.25,
        mx: { md: -1.5 },
        borderRadius: '10px',
        bgcolor: 'action.hover',
        color: 'text.secondary',
        '&:focus-within': { outline: '2px solid', outlineColor: 'primary.main' },
      }}
    >
      <AppIcon name="search" size={16} />
      <InputBase
        value={value}
        onChange={(event) => onChange(event.target.value.slice(0, 100))}
        placeholder={listText.search}
        inputProps={{ 'aria-label': listText.search, type: 'search' }}
        sx={{ flex: 1, fontSize: 14, color: 'text.primary' }}
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

/** What the search found: the chats of the list and of «Архив», the latest changed first. */
function SearchResults({ query, currentId }: { query: string; currentId: string | null }) {
  const client = useTRPCClient()
  const labelId = useId()
  const found = useQuery({
    queryKey: [...dialogListKey, 'search', query],
    queryFn: () => client.task.search.query({ query }),
  })
  if (found.isPending)
    return (
      <Box role="status" aria-label={listText.searchLoading}>
        <ListLoading />
      </Box>
    )
  if (found.isError)
    return <ListFailed retrying={found.isFetching} onRetry={() => void found.refetch()} />
  if (found.data.items.length === 0)
    return (
      <Typography role="status" variant="body2" color="text.secondary">
        {listText.searchEmpty}
      </Typography>
    )
  return (
    <Box sx={{ mx: { md: -1.5 } }}>
      <Box id={labelId} sx={offScreen}>
        {listText.search}
      </Box>
      <DialogRows
        items={found.data.items}
        labelledBy={labelId}
        currentId={currentId}
        now={new Date()}
      />
    </Box>
  )
}

/** The words of the search once they have rested: a word typed on does not ask each letter. */
function useRestedWords(words: string): string {
  const [rested, setRested] = useState(words)
  useEffect(() => {
    const later = window.setTimeout(() => setRested(words), SEARCH_PAUSE_MS)
    return () => window.clearTimeout(later)
  }, [words])
  return useDeferredValue(rested)
}

/**
 * The chats of the user in the column of «Чаты», one list or folders of projects, each with its
 * status in a sign and a word and its time. The open chat is the current page. The list follows
 * the statuses while the page is shown.
 */
export function DialogList({
  grouped = false,
  folder = null,
}: {
  /** «По проектам»; otherwise one list. */
  grouped?: boolean
  /** The folder the address asks to open. */
  folder?: string | null
}) {
  const segment = useSelectedLayoutSegment()
  const currentId = segment === null ? null : segment.toLowerCase()
  const [words, setWords] = useState('')
  const query = useRestedWords(words).replace(/\s+/gu, ' ').trim()
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <SearchField value={words} onChange={setWords} />
      {query !== '' ? (
        <SearchResults query={query} currentId={currentId} />
      ) : (
        <>
          {grouped ? (
            <Folders asked={folder?.toLowerCase() ?? null} currentId={currentId} />
          ) : (
            <OneList currentId={currentId} />
          )}
          <ArchiveSection currentId={currentId} />
        </>
      )}
    </Box>
  )
}
