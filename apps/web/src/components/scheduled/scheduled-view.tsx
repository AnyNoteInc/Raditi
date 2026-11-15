'use client'

import type { ScheduleTemplate } from '@repo/domain/schedule'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import ListItemIcon from '@mui/material/ListItemIcon'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Skeleton from '@mui/material/Skeleton'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useTheme, type Theme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type RefObject } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { SectionHeading } from '@/components/application/section-heading'
import { newChatHref } from '@/components/chat/chat-address'
import { keepChatDraft } from '@/components/chat/chat-draft'
import { SectionTabs } from '@/components/application/section-tabs'
import { useTRPC } from '@/trpc/client'

import { ScheduleNoticeBar, useScheduleActions, type ScheduleNotice } from './schedule-actions'
import { ScheduleDialog, type ScheduleDialogOpening } from './schedule-dialog'
import { takeScheduleNotice } from './schedule-notice'
import {
  chatDraftOf,
  inScheduleTag,
  matchesSearch,
  scheduleOrders,
  scheduleTags,
  sortSchedules,
  type ScheduleItem,
  type ScheduleOrder,
  type ScheduleTag,
} from './schedule-model'
import { ScheduleRow } from './schedule-row'
import { ScheduleTemplateGrid } from './schedule-templates'
import {
  scheduleDialogTexts,
  scheduledTexts,
  scheduleRowTexts,
  scheduleSortLabels,
  scheduleTagLabels,
} from './schedule-texts'
import { ScheduledEmpty } from './scheduled-empty'
import { useNow } from './use-now'

/** A list this long is read at a glance: search only above it (Зп3, К24). */
const SEARCH_ABOVE = 6

const ROOT = '/scheduled'
const tabs = [
  { label: scheduledTexts.yours, href: ROOT, segments: [''] },
  { label: scheduledTexts.templates, href: `${ROOT}/templates`, segments: ['templates'] },
] as const

const iconButtonSx = {
  width: 44,
  height: 44,
  borderRadius: '12px',
  color: 'text.secondary',
  '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
  '&[aria-pressed="true"]': { color: 'text.primary', bgcolor: 'action.selected' },
} as const

// A chip keeps its width: on a phone its row scrolls instead (`chipRowSx`).
const pillSx = { borderRadius: 999, minHeight: 36, px: 1.75, flexShrink: 0 } as const

/**
 * A row of filter chips: wraps from `sm`; on a phone one line that scrolls sideways, without a
 * scrollbar drawn, so the list stays in sight. A chip that gets the focus is scrolled to by the
 * browser; the padding keeps its focus ring inside the row.
 */
const chipRowSx = (theme: Theme) => ({
  display: 'flex',
  flexWrap: 'wrap',
  gap: 1,
  [theme.breakpoints.down('sm')]: {
    flexWrap: 'nowrap',
    overflowX: 'auto',
    scrollbarWidth: 'none',
    '&::-webkit-scrollbar': { display: 'none' },
    p: 0.5,
    m: -0.5,
  },
})

const LINE = '1px solid var(--mui-palette-divider)'

/** Out of sight on a phone, by the width alone: at first paint, before any script. */
const offOnPhone = (theme: Theme) => ({ [theme.breakpoints.down('sm')]: { display: 'none' } })

/** «Новая задача ▾» (Зп2): «Настроить вручную» or «Настроить в чате». */
function NewTaskButton({
  onByHand,
  onInChat,
  buttonRef,
}: {
  onByHand: (opener: HTMLElement | null) => void
  onInChat: () => void
  buttonRef: RefObject<HTMLButtonElement | null>
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const button = buttonRef
  return (
    <>
      <Button
        ref={button}
        variant="contained"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(event) => setAnchor(event.currentTarget)}
        startIcon={<AppIcon name="plus" size={16} />}
        endIcon={<AppIcon name="down" size={16} />}
        sx={{ minHeight: 40, width: { xs: '100%', sm: 'auto' }, whiteSpace: 'nowrap' }}
      >
        {scheduledTexts.newTask}
      </Button>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: { sx: { borderRadius: '14px', minWidth: 240, mt: 0.5 } },
          list: { 'aria-label': scheduledTexts.newTaskMenu },
        }}
      >
        <MenuItem
          onClick={() => {
            setAnchor(null)
            onByHand(button.current)
          }}
          sx={{ minHeight: 44, fontSize: 14 }}
        >
          <ListItemIcon>
            <AppIcon name="pencil" size={18} />
          </ListItemIcon>
          {scheduledTexts.byHand}
        </MenuItem>
        <MenuItem
          onClick={() => {
            setAnchor(null)
            onInChat()
          }}
          sx={{ minHeight: 44, fontSize: 14 }}
        >
          <ListItemIcon>
            <AppIcon name="chat" size={18} />
          </ListItemIcon>
          {scheduledTexts.inChat}
        </MenuItem>
      </Menu>
    </>
  )
}

/** The order of «Ваши» (Зп3), a menu of three. */
function SortButton({
  order,
  onChange,
}: {
  order: ScheduleOrder
  onChange: (order: ScheduleOrder) => void
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <IconButton
        aria-label={scheduledTexts.sort}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={iconButtonSx}
      >
        <AppIcon name="sort" size={20} />
      </IconButton>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: { sx: { borderRadius: '14px', minWidth: 240 } },
          list: { 'aria-label': scheduledTexts.sort },
        }}
      >
        {scheduleOrders.map((key) => (
          <MenuItem
            key={key}
            role="menuitemradio"
            aria-checked={order === key}
            selected={order === key}
            onClick={() => {
              onChange(key)
              setAnchor(null)
            }}
            sx={{ minHeight: 44, fontSize: 14, justifyContent: 'space-between', gap: 2 }}
          >
            {scheduleSortLabels[key]}
            <Box
              component="span"
              aria-hidden
              sx={{ display: 'flex', visibility: order === key ? 'visible' : 'hidden' }}
            >
              <AppIcon name="check" size={18} />
            </Box>
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}

/**
 * «Запланированные задачи» (docs/plan/82-scheduled-tasks.md, Зп2–Зп5, Зп9, Зп10): the heading with
 * what the section is in its tooltip; the tabs «Ваши» and «Шаблоны»; the search above six tasks,
 * the filters with their counts, the order and «Новая задача ▾». Before the first task — the
 * stopwatch and the templates; on «Шаблоны» — the six of §4.6, the used ones marked.
 */
export function ScheduledView({ userId, tab }: { userId: string; tab: 'yours' | 'templates' }) {
  const trpc = useTRPC()
  const router = useRouter()
  const now = useNow()
  const list = useQuery(trpc.schedule.list.queryOptions())
  const [notice, setNotice] = useState<ScheduleNotice>(null)
  const actions = useScheduleActions(setNotice)
  const [opening, setOpening] = useState<ScheduleDialogOpening | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const [tag, setTag] = useState<ScheduleTag>('all')
  const [order, setOrder] = useState<ScheduleOrder>('next')
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const newTaskButton = useRef<HTMLButtonElement>(null)
  // «Настроить вручную» of the empty list, which stands for «Новая задача» on a phone (Зп4).
  const byHandButton = useRef<HTMLButtonElement>(null)
  const theme = useTheme()
  const phone = useMediaQuery(theme.breakpoints.down('sm'))
  // «⋯» of each row by its task, and the row whose «⋯» takes the focus after a deletion: the row
  // the focus was in is gone (null — «Новая задача»).
  const moreButtons = useRef(new Map<string, HTMLButtonElement>())
  const [refocus, setRefocus] = useState<{ id: string | null } | null>(null)

  // What the page of a task said as the client left it for here: «Задача удалена».
  useEffect(() => {
    const later = setTimeout(() => {
      const kept = takeScheduleNotice()
      if (kept !== null) setNotice({ text: kept })
    }, 0)
    return () => clearTimeout(later)
  }, [])

  // After the confirmation closed and gave the focus back to «⋯» of the row that goes away.
  useEffect(() => {
    if (refocus === null) return
    const row = refocus.id === null ? undefined : moreButtons.current.get(refocus.id)
    const target = row ?? newTaskButton.current
    target?.focus()
  }, [refocus])

  const all: readonly ScheduleItem[] = list.data?.schedules ?? []
  const empty = list.isSuccess && all.length === 0

  // The last task deleted on a phone: «Новая задача» under the tabs goes with the list, so the
  // focus it had goes to «Настроить вручную» of the empty list.
  useEffect(() => {
    if (!empty || !phone || document.activeElement !== newTaskButton.current) return
    byHandButton.current?.focus()
  }, [empty, phone])
  const searchable = all.length > SEARCH_ABOVE
  const query = searchable && searchOpen ? search : ''
  const shownTag = filterOpen ? tag : 'all'
  // The buttons of the states alone: a task has no project to filter by (Зп57).
  const fits = (item: ScheduleItem) => matchesSearch(item, query)
  const shown = sortSchedules(
    all.filter((item) => fits(item) && inScheduleTag(item, shownTag)),
    order,
  )
  const filtered = shownTag !== 'all' || query.trim() !== ''
  const used = new Set(
    all.flatMap((item) => (item.templateSlug === null ? [] : [item.templateSlug])),
  )

  function open(next: ScheduleDialogOpening, from: HTMLElement | null) {
    opener.current = from
    setOpening(next)
  }
  function inChat() {
    keepChatDraft(userId, chatDraftOf(null))
    router.push(newChatHref())
  }
  function reset() {
    setTag('all')
    setSearch('')
    searchInput.current?.focus()
  }
  const openTemplate = (template: ScheduleTemplate, from: HTMLElement) =>
    open({ kind: 'new', template }, from)
  /** A task deleted from its row: said, and the focus to the row after it, or before it. */
  function deleted(item: ScheduleItem) {
    setNotice({ text: scheduleRowTexts.deleted })
    const at = shown.findIndex((each) => each.id === item.id)
    const next = at < 0 ? undefined : (shown[at + 1] ?? shown[at - 1])
    setRefocus({ id: next?.id ?? null })
  }
  // What opened the window may be gone when it closes — the card of a template over an empty list
  // that is not empty any more: then «Новая задача» takes the focus.
  const returnFocus = () => (opener.current?.isConnected ? opener.current : newTaskButton.current)

  const yours = tab === 'yours'
  const tools = yours && list.isSuccess && !empty

  return (
    <Box
      sx={{
        width: '100%',
        maxWidth: 1200,
        mx: 'auto',
        flex: '1 0 auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', minHeight: 48, mb: 2 }}>
        <SectionHeading title={scheduledTexts.title} about={scheduledTexts.about} />
      </Box>

      {/*
        One line under the tabs, the tools and, from `sm`, «Новая задача»: the line of the row, which
        the tabs lie on; on a phone «Новая задача» goes the whole width under it (Зп2).
      */}
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          // Whole values: a responsive `borderBottom: 1` resets the colour to the text's.
          borderBottom: { xs: 'none', sm: LINE },
        }}
      >
        <Box sx={{ flex: '1 1 auto', minWidth: 0, mb: { xs: 0, sm: '-1px' } }}>
          <SectionTabs label={scheduledTexts.tabs} root={ROOT} tabs={tabs} />
        </Box>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            alignSelf: 'stretch',
            borderBottom: { xs: LINE, sm: 'none' },
          }}
        >
          {tools && searchable ? (
            <IconButton
              aria-label={scheduledTexts.search}
              aria-pressed={searchOpen}
              onClick={() => {
                setSearchOpen(!searchOpen)
                if (searchOpen) setSearch('')
              }}
              sx={iconButtonSx}
            >
              <AppIcon name="search" size={20} />
            </IconButton>
          ) : null}
          {tools && all.length > 1 ? (
            <>
              <IconButton
                aria-label={scheduledTexts.filter}
                aria-pressed={filterOpen}
                onClick={() => setFilterOpen(!filterOpen)}
                sx={iconButtonSx}
              >
                <AppIcon name="filter" size={20} />
              </IconButton>
              <SortButton order={order} onChange={setOrder} />
            </>
          ) : null}
        </Box>
        {/*
          On a phone the empty «Ваши» has its own «Настроить вручную» and «Настроить в чате» right
          under it: no second orange button of the whole width for the same thing.
        */}
        <Box
          data-new-task=""
          sx={[
            {
              display: 'flex',
              flex: { xs: '1 1 100%', sm: 'none' },
              alignSelf: 'center',
              mt: { xs: 1.5, sm: 0 },
              py: { sm: 0.5 },
              pl: { sm: 1 },
            },
            ...(yours && empty ? [offOnPhone] : []),
          ]}
        >
          <NewTaskButton
            buttonRef={newTaskButton}
            onByHand={(from) => open({ kind: 'new' }, from)}
            onInChat={inChat}
          />
        </Box>
      </Box>

      {tools && searchable && searchOpen ? (
        <TextField
          inputRef={searchInput}
          autoFocus
          size="small"
          placeholder={scheduledTexts.search}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          slotProps={{
            htmlInput: { 'aria-label': scheduledTexts.searchField },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <AppIcon name="search" size={18} />
                </InputAdornment>
              ),
              endAdornment: search ? (
                <InputAdornment position="end">
                  <IconButton
                    size="small"
                    aria-label={scheduledTexts.clearSearch}
                    onClick={() => {
                      setSearch('')
                      searchInput.current?.focus()
                    }}
                    edge="end"
                    sx={{ width: 44, height: 44 }}
                  >
                    <AppIcon name="close" size={16} />
                  </IconButton>
                </InputAdornment>
              ) : undefined,
            },
          }}
          sx={{ mt: 2, width: { xs: '100%', sm: 320 }, '& .MuiInputBase-root': { minHeight: 48 } }}
        />
      ) : null}

      {tools && filterOpen ? (
        <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
          <Box role="group" aria-label={scheduledTexts.showGroup} sx={chipRowSx}>
            {scheduleTags.map((each) => (
              <Button
                key={each}
                aria-pressed={tag === each}
                onClick={() => setTag(each)}
                variant={tag === each ? 'contained' : 'outlined'}
                size="small"
                sx={pillSx}
              >
                {scheduleTagLabels[each]}
                <Box
                  component="span"
                  sx={{ ml: 1, opacity: 0.75, fontVariantNumeric: 'tabular-nums' }}
                >
                  {all.filter((item) => fits(item) && inScheduleTag(item, each)).length}
                </Box>
              </Button>
            ))}
          </Box>
        </Box>
      ) : null}

      <Box sx={{ mt: 3, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {list.isPending ? (
          <Box
            role="status"
            aria-label={scheduledTexts.loading}
            sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}
          >
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} variant="rounded" height={96} sx={{ borderRadius: '14px' }} />
            ))}
          </Box>
        ) : list.isError && list.data === undefined ? (
          <Alert
            severity="error"
            action={
              <Button color="inherit" onClick={() => void list.refetch()}>
                {scheduledTexts.retry}
              </Button>
            }
          >
            {scheduledTexts.failed}
          </Alert>
        ) : !yours ? (
          <ScheduleTemplateGrid used={used} onOpen={openTemplate} wide />
        ) : empty ? (
          <ScheduledEmpty
            byHandRef={byHandButton}
            onByHand={(from) => open({ kind: 'new' }, from)}
            onInChat={inChat}
            onTemplate={openTemplate}
          />
        ) : shown.length === 0 ? (
          <Box sx={{ py: 4, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
            <Typography sx={{ color: 'text.secondary' }}>{scheduledTexts.nothingFound}</Typography>
            {filtered ? (
              <Button size="small" onClick={reset}>
                {scheduledTexts.reset}
              </Button>
            ) : null}
          </Box>
        ) : (
          <Box
            component="ul"
            aria-label={scheduledTexts.list}
            sx={{
              listStyle: 'none',
              m: 0,
              p: 0,
              border: 1,
              borderColor: 'divider',
              borderRadius: '14px',
              bgcolor: 'background.paper',
              overflow: 'hidden',
            }}
          >
            {shown.map((item) => (
              <ScheduleRow
                key={item.id}
                item={item}
                now={now}
                actions={actions}
                onEdit={(schedule, from) => open({ kind: 'edit', schedule }, from)}
                onDeleted={deleted}
                moreRef={(element) => {
                  if (element === null) moreButtons.current.delete(item.id)
                  else moreButtons.current.set(item.id, element)
                }}
              />
            ))}
          </Box>
        )}
      </Box>

      <ScheduleDialog
        opening={opening}
        userId={userId}
        onClose={() => setOpening(null)}
        onSaved={(_, created) =>
          setNotice({ text: created ? scheduleDialogTexts.created : scheduleDialogTexts.saved })
        }
        returnFocus={returnFocus}
      />
      <ScheduleNoticeBar notice={notice} onClose={() => setNotice(null)} />
    </Box>
  )
}
