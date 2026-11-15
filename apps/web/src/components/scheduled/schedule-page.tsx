'use client'

import { runMomentText, timezoneLabel, timezoneSuffix } from '@repo/domain/schedule'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import FormControlLabel from '@mui/material/FormControlLabel'
import Link from '@mui/material/Link'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { useTheme, type Theme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import NextLink from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { isNotFound } from '@/components/chat/call-error'
import { effortText } from '@/components/chat/chat-texts'
import { BrowserPushControl } from '@/components/notifications/browser-push-control'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import {
  ScheduleMoreMenu,
  ScheduleNoticeBar,
  ScheduleSwitch,
  useScheduleActions,
  type ScheduleNotice,
} from './schedule-actions'
import { ScheduleCostLine } from './schedule-cost'
import { ScheduleDialog, type ScheduleDialogOpening } from './schedule-dialog'
import { keepScheduleNotice } from './schedule-notice'
import {
  missedText,
  runLines,
  scheduleStateText,
  scheduleWords,
  type RunLine,
  type ScheduleDetail,
} from './schedule-model'
import { RunStateMark } from './schedule-row'
import {
  scheduleDialogTexts,
  scheduledTexts,
  schedulePageTexts,
  scheduleRowTexts,
} from './schedule-texts'
import { useNow } from './use-now'

/** As many runs as the server gives with a task (Зп6): fewer are all the task has had. */
const RUNS_KEPT = 50

/** Out of sight on a phone, by the width alone: at first paint, before any script. */
const offOnPhone = (theme: Theme) => ({ [theme.breakpoints.down('sm')]: { display: 'none' } })

/** The visible label of the switch of a task: on, paused, or off for a reason its state names. */
function switchWords(task: ScheduleDetail): string {
  if (task.enabled) return schedulePageTexts.switchOn
  return task.pausedReason === null ? schedulePageTexts.switchPaused : schedulePageTexts.switchOff
}

/** One fact of the task: its name on the left on a wide screen, above it on a phone. */
function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: '180px minmax(0, 1fr)' },
        gap: { xs: 0.5, sm: 2 },
        py: 1.75,
        '& + &': { borderTop: 1, borderColor: 'divider' },
      }}
    >
      <Typography component="dt" variant="body2" sx={{ color: 'text.secondary', pt: '1px' }}>
        {term}
      </Typography>
      <Box component="dd" sx={{ m: 0, minWidth: 0, fontSize: 15, lineHeight: 1.5 }}>
        {children}
      </Box>
    </Box>
  )
}

/**
 * A line of the runs (Зп6): when, by the schedule or by hand, what came of it, and its chat. From
 * `md` a line is a row of the list's columns (a subgrid): the date as wide as the longest one, on
 * one line. On a phone the date takes a line of its own, with how the run began after it; what
 * came of it and «Открыть чат» go under it.
 */
function RunRow({ line, task, now }: { line: RunLine; task: ScheduleDetail; now: Date }) {
  const run = line.kind === 'run' ? line.run : line.runs[0]
  if (run === undefined) return null
  const when = runMomentText(line.kind === 'run' ? run.dueAt : line.from, task.timezone, now)
  const how = run.trigger === 'manual' ? schedulePageTexts.byHand : schedulePageTexts.bySchedule
  return (
    <Box
      component="li"
      sx={{
        display: 'grid',
        gridColumn: { md: '1 / -1' },
        gridTemplateColumns: { xs: 'minmax(0, 1fr) auto', md: 'subgrid' },
        alignItems: 'center',
        columnGap: 2,
        rowGap: 0.5,
        px: { xs: 1.75, sm: 2.5 },
        py: 1.5,
        fontSize: 14,
        '& + &': { borderTop: 1, borderColor: 'divider' },
      }}
    >
      <Box
        data-run-when=""
        sx={{
          gridColumn: { xs: '1 / -1', md: 'auto' },
          fontWeight: 500,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: { md: 'nowrap' },
        }}
      >
        {when}
        {/*
          On a phone how it was started follows the time; from `md` it has a column. A line that
          wraps keeps «·» after the time and «по расписанию» whole (nbsp).
        */}
        <Box
          component="span"
          sx={{ display: { xs: 'inline', md: 'none' }, fontWeight: 400, color: 'text.secondary' }}
        >
          {nbsp(` · ${how}`)}
        </Box>
      </Box>
      <Box sx={{ color: 'text.secondary', display: { xs: 'none', md: 'block' } }}>{how}</Box>
      <Box sx={{ gridColumn: { xs: 1, md: 'auto' }, gridRow: { xs: 2, md: 'auto' }, minWidth: 0 }}>
        <RunStateMark
          state={run.state}
          {...(line.kind === 'missed' ? { text: missedText(line, task.timezone, now) } : {})}
        />
      </Box>
      {line.kind === 'run' && run.chat !== null ? (
        <Box
          sx={{
            gridColumn: { xs: 2, md: 'auto' },
            gridRow: { xs: 2, md: 'auto' },
            justifySelf: 'end',
            alignSelf: { xs: 'start', md: 'center' },
          }}
        >
          <Link
            component={NextLink}
            href={`/chats/${run.chat.id}`}
            aria-label={schedulePageTexts.openChatOf(when)}
            sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}
          >
            {schedulePageTexts.openChat}
          </Link>
        </Box>
      ) : null}
    </Box>
  )
}

/**
 * The page of a scheduled task (docs/plan/82-scheduled-tasks.md, Зп6): its name and state, the
 * switch, «Запустить сейчас», «Изменить» and «⋯ Удалить»; the exact instructions, the schedules
 * with the zone, «Размышление», the notices and the cost; then the last 50 runs, the
 * missed ones in a row as one line. Loading — a frame of it; a failure — «Повторить». A failed
 * reading of a task already shown keeps the page, and the window open over it, as they were.
 */
export function SchedulePage({ scheduleId, userId }: { scheduleId: string; userId: string }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  const now = useNow()
  const theme = useTheme()
  // On a phone «Изменить» goes into «⋯»: «Запустить сейчас» takes the line with it alone.
  const phone = useMediaQuery(theme.breakpoints.down('sm'))
  const task = useQuery(trpc.schedule.get.queryOptions({ scheduleId }))
  const [notice, setNotice] = useState<ScheduleNotice>(null)
  const actions = useScheduleActions(setNotice)
  const [opening, setOpening] = useState<ScheduleDialogOpening | null>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  // The task deleted here: its reading is dropped as the page is left, not under its eyes.
  const dropOnLeave = useRef<QueryKey | null>(null)
  useEffect(
    () => () => {
      const key = dropOnLeave.current
      if (key !== null) queryClient.removeQueries({ queryKey: key })
    },
    [queryClient],
  )
  const gone = task.isError && isNotFound(task.error)

  const back = (
    <Link
      component={NextLink}
      href="/scheduled"
      underline="hover"
      color="text.secondary"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        minHeight: 44,
        fontSize: 14,
        fontWeight: 500,
        alignSelf: 'flex-start',
      }}
    >
      <AppIcon name="back" size={16} />
      {schedulePageTexts.back}
    </Link>
  )

  let content: ReactNode
  if (task.isPending)
    content = (
      <Box role="status" aria-label={schedulePageTexts.loading} sx={{ mt: 1 }}>
        <Skeleton variant="text" width="50%" height={44} />
        <Skeleton variant="text" width="30%" />
        <Skeleton variant="rounded" height={220} sx={{ mt: 3, borderRadius: '14px' }} />
        <Skeleton variant="rounded" height={140} sx={{ mt: 3, borderRadius: '14px' }} />
      </Box>
    )
  // A task gone while its window is open stays under the window: the window says so on «Сохранить».
  else if (gone && (task.data === undefined || opening === null))
    content = (
      <Box sx={{ py: 6, textAlign: 'center' }}>
        <Typography component="h1" sx={{ fontSize: 22, fontWeight: 600 }}>
          {schedulePageTexts.notFound}
        </Typography>
        <Typography sx={{ mt: 1, color: 'text.secondary' }}>
          {schedulePageTexts.notFoundLead}
        </Typography>
        <Button href="/scheduled" variant="outlined" color="inherit" sx={{ mt: 2.5 }}>
          {schedulePageTexts.toList}
        </Button>
      </Box>
    )
  else if (task.data === undefined)
    content = (
      <Alert
        severity="error"
        sx={{ mt: 2 }}
        action={
          <Button color="inherit" onClick={() => void task.refetch()}>
            {scheduledTexts.retry}
          </Button>
        }
      >
        {schedulePageTexts.failed}
      </Alert>
    )
  else {
    const data = task.data
    const lines = runLines(data.runs)
    const state = scheduleStateText(data, now)
    const switchLabel = switchWords(data)
    content = (
      <>
        {task.isError && !gone ? (
          <Alert
            severity="warning"
            sx={{ mt: 2 }}
            action={
              <Button color="inherit" onClick={() => void task.refetch()}>
                {scheduledTexts.retry}
              </Button>
            }
          >
            {schedulePageTexts.stale}
          </Alert>
        ) : null}
        <Box
          sx={{
            mt: 1,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            columnGap: 2,
            rowGap: 1.5,
          }}
        >
          <Box sx={{ minWidth: 0, flex: '1 1 320px' }}>
            <Typography
              variant="h2"
              component="h1"
              sx={{ fontSize: { xs: 26, md: 30 }, lineHeight: 1.2, overflowWrap: 'anywhere' }}
            >
              {data.name}
            </Typography>
            {/*
              The state of the task and its switch, labelled with what it is set to; the state is
              not said twice when it is the label itself — «На паузе».
            */}
            <Box
              sx={{
                mt: 0.5,
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                columnGap: 2,
                rowGap: 0,
              }}
            >
              {state === switchLabel ? null : (
                <Typography sx={{ color: data.enabled ? 'text.primary' : 'text.secondary' }}>
                  {state}
                </Typography>
              )}
              <FormControlLabel
                control={<ScheduleSwitch task={data} actions={actions} />}
                label={switchLabel}
                sx={{
                  ml: -1,
                  mr: 0,
                  '& .MuiFormControlLabel-label': { fontSize: 15, color: 'text.secondary' },
                }}
              />
            </Box>
          </Box>
          <Box
            sx={{
              display: 'flex',
              flexWrap: { xs: 'nowrap', sm: 'wrap' },
              alignItems: 'center',
              gap: 1,
              width: { xs: '100%', sm: 'auto' },
            }}
          >
            <Button
              variant="contained"
              onClick={() => actions.start(data)}
              loading={actions.runNow.isPending}
              startIcon={<AppIcon name="send" size={16} />}
              sx={{ minHeight: 40, flex: { xs: '1 1 auto', sm: 'none' } }}
            >
              {scheduleRowTexts.runNow}
            </Button>
            <Button
              ref={editButton}
              variant="outlined"
              color="inherit"
              onClick={() => {
                opener.current = editButton.current
                setOpening({ kind: 'edit', schedule: data })
              }}
              startIcon={<AppIcon name="pencil" size={16} />}
              sx={[{ minHeight: 40, borderColor: 'divider' }, offOnPhone]}
            >
              {scheduleRowTexts.edit}
            </Button>
            <ScheduleMoreMenu
              task={data}
              actions={actions}
              items={phone ? ['edit', 'delete'] : ['delete']}
              onEdit={(from) => {
                opener.current = from
                setOpening({ kind: 'edit', schedule: data })
              }}
              label={schedulePageTexts.more}
              onDeleted={() => {
                dropOnLeave.current = trpc.schedule.get.queryKey({ scheduleId })
                // Said on «Ваши»: this page is gone the moment it is left.
                keepScheduleNotice('deleted')
                router.push('/scheduled')
              }}
            />
          </Box>
        </Box>

        <Box
          component="dl"
          sx={{
            m: 0,
            mt: 3,
            px: { xs: 1.75, sm: 2.5 },
            border: 1,
            borderColor: 'divider',
            borderRadius: '14px',
            bgcolor: 'background.paper',
          }}
        >
          <Fact term={schedulePageTexts.instructions}>
            <Box sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{data.instructions}</Box>
          </Fact>
          <Fact term={schedulePageTexts.schedule}>
            {scheduleWords(data)}
            {timezoneSuffix(data.timezone) === '' ? null : (
              <Box
                component="span"
                sx={{ display: 'block', color: 'text.secondary', fontSize: 14 }}
              >
                {`${scheduleDialogTexts.timezone}: ${timezoneLabel(data.timezone)}`}
              </Box>
            )}
          </Fact>
          <Fact term={schedulePageTexts.effort}>{effortText[data.effort]}</Fact>
          <Fact term={schedulePageTexts.notify}>
            {data.notify ? schedulePageTexts.notifyOn : schedulePageTexts.notifyOff}
            <BrowserPushControl sx={{ mt: 1 }} />
          </Fact>
          <Fact term={schedulePageTexts.cost}>
            <ScheduleCostLine triggers={data.triggers} timezone={data.timezone} tone="value" />
          </Fact>
        </Box>

        <Box component="section" aria-labelledby="schedule-runs" sx={{ mt: 4 }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.25, flexWrap: 'wrap' }}>
            <Typography id="schedule-runs" component="h2" sx={{ fontSize: 18, fontWeight: 600 }}>
              {schedulePageTexts.runs}
            </Typography>
            {data.runs.length >= RUNS_KEPT ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {schedulePageTexts.runsNote}
              </Typography>
            ) : null}
          </Box>
          {lines.length === 0 ? (
            <Typography sx={{ mt: 1.5, color: 'text.secondary' }}>
              {schedulePageTexts.noRuns}
            </Typography>
          ) : (
            <Box
              component="ul"
              aria-label={schedulePageTexts.runs}
              sx={{
                listStyle: 'none',
                m: 0,
                mt: 1.5,
                p: 0,
                border: 1,
                borderColor: 'divider',
                borderRadius: '14px',
                bgcolor: 'background.paper',
                overflow: 'hidden',
                // The columns of every line from `md`: each line is a subgrid of them (RunRow).
                display: { md: 'grid' },
                gridTemplateColumns: { md: 'max-content max-content minmax(0, 1fr) auto' },
                columnGap: 2,
              }}
            >
              {lines.map((line) => (
                <RunRow
                  key={line.kind === 'run' ? line.run.id : line.key}
                  line={line}
                  task={data}
                  now={now}
                />
              ))}
            </Box>
          )}
        </Box>

        <ScheduleDialog
          opening={opening}
          userId={userId}
          onClose={() => setOpening(null)}
          onSaved={() => setNotice({ text: scheduleDialogTexts.saved })}
          returnFocus={() => opener.current}
        />
      </>
    )
  }

  return (
    <Box
      sx={{
        width: '100%',
        maxWidth: 960,
        mx: 'auto',
        flex: '1 0 auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {back}
      {content}
      <ScheduleNoticeBar notice={notice} onClose={() => setNotice(null)} />
    </Box>
  )
}
