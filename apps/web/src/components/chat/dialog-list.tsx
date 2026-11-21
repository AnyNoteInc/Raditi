'use client'

import { NO_PROJECT_FOLDER } from '@repo/domain/projects'
import { feedStateText, taskStatusListHint } from '@repo/domain/tasks/client-feed-labels'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import IconButton from '@mui/material/IconButton'
import Skeleton from '@mui/material/Skeleton'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useSearchParams, useSelectedLayoutSegment } from 'next/navigation'
import { useId, useState, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { MoveToProjectDialog, useMoveToProject } from '@/components/projects/move-to-project'
import { useTRPCClient } from '@/trpc/client'

import { chatHref, NEW_CHAT_SEGMENT, newChatHref, projectOfSearch } from './chat-address'
import { dialogGroups, listTime } from './chat-format'
import { chatsText, listRepoHint, listText } from './chat-texts'
import type { DialogListItem } from './chat-types'
import { offScreen } from './composer'
import { ArchiveDialog, archiveText } from './archive-dialog'
import {
  DialogMenuButton,
  dialogListKey,
  RemoveDialogConfirm,
  RenameField,
  usePinArchive,
} from './dialog-actions'
import { ScheduleSign } from './schedule-mark'
import { StatusMark } from './status-mark'

export { dialogListKey }

/** The list is read again this often while the page is shown, to follow the statuses. */
const LIST_REFRESH_MS = 15_000

/** The folder of «По проектам» of the chats without a project (`task.list` takes the same word). */
const NO_PROJECT = NO_PROJECT_FOLDER

/**
 * The pages of one list: every chat of the user, of one project, or of none (`projectId` `none`,
 * a folder of «По проектам»); `archive` — «Архив» (docs/plan/75-chat-input-output.md, ВВ21). The
 * first page of the list carries its pinned chats.
 */
function useChatPages(view: 'active' | 'archive' = 'active', projectId: string | null = null) {
  const client = useTRPCClient()
  return useInfiniteQuery({
    queryKey:
      projectId !== null
        ? [...dialogListKey, 'project', projectId]
        : view === 'archive'
          ? [...dialogListKey, 'archive']
          : [...dialogListKey, 'all'],
    queryFn: ({ pageParam }) =>
      client.task.list.query({
        ...(pageParam === null ? {} : { cursor: pageParam }),
        ...(view === 'archive' ? { view } : {}),
        ...(projectId === null ? {} : { projectId }),
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

function DialogLink({
  item,
  current,
  now,
  showProject,
}: {
  item: DialogListItem
  current: boolean
  now: Date
  /** The name of its project starts the second line (docs/plan/84-projects.md, ПР6). */
  showProject: boolean
}) {
  const hint = item.answered || item.failed ? null : taskStatusListHint[item.status]
  // The branch of a chat of a project (docs/plan/84-projects.md, §4.8).
  const repoHint = listRepoHint(item.repo)
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
        {/* A run of a scheduled task: a stopwatch before its name (docs/plan/82, Зп43). */}
        {item.schedule ? <ScheduleSign schedule={item.schedule} /> : null}
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
        {showProject && item.project ? (
          <Typography
            component="span"
            variant="caption"
            color={quiet}
            data-dialog-project=""
            sx={{
              maxWidth: 160,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item.project.name}
            <span aria-hidden="true"> ·</span>
          </Typography>
        ) : null}
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
        {repoHint ? (
          <Typography component="span" variant="caption" color={quiet} data-dialog-repo="">
            <span aria-hidden="true">· </span>
            {repoHint}
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
  showProject,
}: {
  item: DialogListItem
  current: boolean
  now: Date
  showProject: boolean
}) {
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const keep = usePinArchive()
  const move = useMoveToProject()
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
          <DialogLink item={item} current={current} now={now} showProject={showProject} />
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
              project={{
                inProject: item.project !== null,
                onMove: () => {
                  setMoveError(null)
                  setMoving(true)
                },
                onTakeOut: () => {
                  setMoveError(null)
                  void move.to(item.id, null).then(setMoveError)
                },
              }}
            />
          </Box>
        </>
      )}
      {moveError !== null ? (
        <Typography role="alert" variant="body2" color="error.main" sx={{ px: 1.25, pb: 0.5 }}>
          {moveError}
        </Typography>
      ) : null}
      {moving ? (
        <MoveToProjectDialog
          taskId={item.id}
          title={title}
          currentProjectId={item.project?.id ?? null}
          open
          onClose={() => setMoving(false)}
        />
      ) : null}
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
  showProject = true,
}: {
  items: readonly DialogListItem[]
  labelledBy: string
  currentId: string | null
  now: Date
  showProject?: boolean
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
          <DialogRow
            item={item}
            current={item.id.toLowerCase() === currentId}
            now={now}
            showProject={showProject}
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

/** The chats of one folder of «По проектам», read once it is open: its pinned ones first. */
function FolderChats({
  folder,
  labelledBy,
  currentId,
}: {
  folder: string
  labelledBy: string
  currentId: string | null
}) {
  const list = useChatPages('active', folder)
  if (list.isPending) return <ListLoading />
  if (list.isError)
    return <ListFailed retrying={list.isFetching} onRetry={() => void list.refetch()} />
  return (
    <>
      <DialogRows
        items={[
          ...(list.data.pages[0]?.pinned ?? []),
          ...list.data.pages.flatMap((page) => page.items),
        ]}
        labelledBy={labelledBy}
        currentId={currentId}
        now={new Date()}
        showProject={false}
      />
      {list.hasNextPage ? (
        <ShowMore
          inset={1.25}
          loading={list.isFetchingNextPage}
          onMore={() => void list.fetchNextPage()}
        />
      ) : null}
    </>
  )
}

interface ChatFolder {
  project: { id: string; name: string } | null
  archived: boolean
  count: number
  attention: boolean
}

/**
 * A folder of «По проектам»: its line opens and closes it, and says how many chats it holds. A
 * live project folder carries «+» beside it to open a new chat with that project chosen.
 */
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
  const activeProject = folder.project !== null && !folder.archived ? folder.project : null
  const newChatLabel = activeProject !== null ? chatsText.newProjectChat(activeProject.name) : null
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
        <ButtonBase
          aria-expanded={open}
          data-chat-folder=""
          onClick={onToggle}
          sx={{
            flex: '1 1 auto',
            minWidth: 0,
            minHeight: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: 1,
            pl: 0.75,
            pr: activeProject !== null ? 0.75 : 1.25,
            borderRadius: '10px',
            fontSize: 14,
            fontWeight: 500,
            textAlign: 'left',
            color: 'text.primary',
            '&:hover': { bgcolor: 'action.hover' },
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: 2,
            },
          }}
        >
          <AppIcon name={open ? 'down' : 'chevron'} size={16} />
          <Box component="span" sx={{ display: 'flex', color: 'text.secondary' }}>
            <AppIcon name={folder.project === null ? 'chat' : 'projects'} size={16} />
          </Box>
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
            {folder.project?.name ?? chatsText.noProject}
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
        {activeProject !== null && newChatLabel !== null ? (
          <Tooltip title={newChatLabel}>
            <IconButton
              component={Link}
              href={newChatHref(activeProject.id)}
              aria-label={newChatLabel}
              data-folder-new-chat=""
              sx={{
                width: 44,
                height: 44,
                flex: 'none',
                borderRadius: '10px',
                color: 'text.secondary',
                '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
                '&:focus-visible': {
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                  outlineOffset: 2,
                },
              }}
            >
              <AppIcon name="plus" size={16} />
            </IconButton>
          </Tooltip>
        ) : null}
      </Box>
      {open ? children(labelId) : null}
    </Box>
  )
}

/**
 * «По проектам» (owner's request of 19.11.2026, after docs/plan/61-chats-first.md, К23): the
 * folders the server counted, «Без проекта» the last; a folder reads its chats only once it is
 * open. The folder of the open chat is open, and so is the only one there is. A new chat in view —
 * «Новый чат», or the root of the section, where it stands beside the list from `md` — opens the
 * folder of its pill as an open chat does: of the project `?project=` names, which the pill writes
 * there, or «Без проекта» (owner's answers of 19.11.2026). Without a chat in view the folder of
 * `?project=` opens all the same. The client's own press wins.
 */
function Folders({ currentId }: { currentId: string | null }) {
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
  const addressed =
    projectOfSearch(useSearchParams().get('project') ?? undefined)?.toLowerCase() ?? null
  const wide = useMediaQuery(useTheme().breakpoints.up('md'))
  const newChat = currentId === NEW_CHAT_SEGMENT || (currentId === null && wide)
  const current =
    openChat !== null
      ? shown.data
        ? (shown.data.project?.id ?? NO_PROJECT)
        : null
      : (addressed ?? (newChat ? NO_PROJECT : null))
  const [pressed, setPressed] = useState<Readonly<Record<string, boolean>>>({})
  // Moving to a chat — or a choice of the pill — of a folder the client closed opens it again: the
  // chat in view stays in sight.
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
  const all = folders.data.folders
  if (all.length === 0) return <EmptyList />
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mx: { md: -1.5 } }}>
      {all.map((folder) => {
        const key = folder.project?.id ?? NO_PROJECT
        const open = pressed[key] ?? (key === current || all.length === 1)
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

/**
 * «Чаты проекта» on the page of a project (docs/plan/84-projects.md, ПР6): its chats as rows of the
 * list, latest changed first, without the name of the project they all share. `empty` stands for
 * a project without chats.
 */
export function ProjectChats({
  projectId,
  labelledBy,
  empty,
}: {
  projectId: string
  labelledBy: string
  empty: ReactNode
}) {
  const list = useChatPages('active', projectId)
  if (list.isPending) return <ListLoading />
  if (list.isError)
    return <ListFailed retrying={list.isFetching} onRetry={() => void list.refetch()} />
  const pinned = list.data.pages[0]?.pinned ?? []
  const items = [...pinned, ...list.data.pages.flatMap((page) => page.items)]
  if (items.length === 0) return <>{empty}</>
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mx: { md: -1.25 } }}>
      <DialogRows
        items={items}
        labelledBy={labelledBy}
        currentId={null}
        now={new Date()}
        showProject={false}
      />
      {list.hasNextPage ? (
        <ShowMore
          inset={1.25}
          loading={list.isFetchingNextPage}
          onMore={() => void list.fetchNextPage()}
        />
      ) : null}
    </Box>
  )
}

/**
 * The chats of the user in the column of «Чаты», one list or folders of projects, each with its
 * status in a sign and a word and its time. The open chat is the current page. The list follows
 * the statuses while the page is shown.
 */
export function DialogList({
  grouped = false,
}: {
  /** «По проектам»; otherwise one list. */
  grouped?: boolean
}) {
  const segment = useSelectedLayoutSegment()
  const currentId = segment === null ? null : segment.toLowerCase()
  return grouped ? <Folders currentId={currentId} /> : <OneList currentId={currentId} />
}
