'use client'

import { runMomentText, timezoneLabel, timezoneSuffix } from '@repo/domain/schedule'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Link from '@mui/material/Link'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import NextLink from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { isNotFound } from '@/components/chat/call-error'
import { effortText } from '@/components/chat/chat-texts'
import { BrowserPushControl } from '@/components/notifications/browser-push-control'
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
  liveProjectId,
  missedText,
  projectText,
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

/** A line of the runs (Зп6): when, by the schedule or by hand, what came of it, and its chat. */
function RunRow({ line, task, now }: { line: RunLine; task: ScheduleDetail; now: Date }) {
  const run = line.kind === 'run' ? line.run : line.runs[0]
  if (run === undefined) return null
  const when = runMomentText(line.kind === 'run' ? run.dueAt : line.from, task.timezone, now)
  return (
    <Box
      component="li"
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: 'minmax(0, 1fr) auto',
          // The same columns on every line: each line is a grid of its own.
          md: '210px 110px minmax(0, 1fr) auto',
        },
        alignItems: 'center',
        columnGap: 2,
        rowGap: 0.5,
        px: { xs: 1.75, sm: 2.5 },
        py: 1.5,
        fontSize: 14,
        '& + &': { borderTop: 1, borderColor: 'divider' },
      }}
    >
      <Box sx={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
        {when}
        {/* On a phone how it was started follows the time; from `md` it has a column. */}
        <Box
          component="span"
          sx={{ display: { xs: 'inline', md: 'none' }, fontWeight: 400, color: 'text.secondary' }}
        >
          {` · ${run.trigger === 'manual' ? schedulePageTexts.byHand : schedulePageTexts.bySchedule}`}
        </Box>
      </Box>
      <Box sx={{ color: 'text.secondary', display: { xs: 'none', md: 'block' } }}>
        {run.trigger === 'manual' ? schedulePageTexts.byHand : schedulePageTexts.bySchedule}
      </Box>
      <Box sx={{ gridColumn: { xs: '1 / 2', md: 'auto' }, gridRow: { xs: 2, md: 'auto' } }}>
        <RunStateMark
          state={run.state}
          {...(line.kind === 'missed' ? { text: missedText(line, task.timezone, now) } : {})}
        />
      </Box>
      <Box
        sx={{
          gridColumn: { xs: '2 / 3', md: 'auto' },
          gridRow: { xs: '1 / 3', md: 'auto' },
          justifySelf: 'end',
        }}
      >
        {line.kind === 'run' && run.chat !== null ? (
          <Link
            component={NextLink}
            href={`/chats/${run.chat.id}`}
            aria-label={schedulePageTexts.openChatOf(when)}
            sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}
          >
            {schedulePageTexts.openChat}
          </Link>
        ) : null}
      </Box>
    </Box>
  )
}

/**
 * The page of a scheduled task (docs/plan/82-scheduled-tasks.md, Зп6): its name and state, the
 * switch, «Запустить сейчас», «Изменить» and «⋯ Удалить»; the exact instructions, the schedules
 * with the zone, the project, «Размышление», the notices and the cost; then the last 50 runs, the
 * missed ones in a row as one line. Loading — a frame of it; a failure — «Повторить». A failed
 * reading of a task already shown keeps the page, and the window open over it, as they were.
 */
export function SchedulePage({ scheduleId, userId }: { scheduleId: string; userId: string }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  const now = useNow()
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
            <Typography sx={{ mt: 1, color: data.enabled ? 'text.primary' : 'text.secondary' }}>
              {scheduleStateText(data, now)}
            </Typography>
          </Box>
          <Box
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 1,
              width: { xs: '100%', sm: 'auto' },
            }}
          >
            <ScheduleSwitch task={data} actions={actions} />
            <Button
              variant="contained"
              onClick={() => actions.start(data)}
              loading={actions.runNow.isPending}
              startIcon={<AppIcon name="send" size={16} />}
              sx={{ minHeight: 40 }}
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
              sx={{ minHeight: 40, borderColor: 'divider' }}
            >
              {scheduleRowTexts.edit}
            </Button>
            <ScheduleMoreMenu
              task={data}
              actions={actions}
              items={['delete']}
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
          <Fact term={schedulePageTexts.project}>
            {/* A deleted project has no page to lead to (Зп22). */}
            {data.project === null || data.project.deleted ? (
              projectText(data)
            ) : (
              <Link component={NextLink} href={`/projects/${data.project.id}`}>
                {data.project.name}
              </Link>
            )}
          </Fact>
          <Fact term={schedulePageTexts.effort}>{effortText[data.effort]}</Fact>
          <Fact term={schedulePageTexts.notify}>
            {data.notify ? schedulePageTexts.notifyOn : schedulePageTexts.notifyOff}
            <BrowserPushControl sx={{ mt: 1 }} />
          </Fact>
          <Fact term={schedulePageTexts.cost}>
            <ScheduleCostLine
              siteId={liveProjectId(data)}
              triggers={data.triggers}
              timezone={data.timezone}
            />
          </Fact>
        </Box>

        <Box component="section" aria-labelledby="schedule-runs" sx={{ mt: 4 }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.25, flexWrap: 'wrap' }}>
            <Typography id="schedule-runs" component="h2" sx={{ fontSize: 18, fontWeight: 600 }}>
              {schedulePageTexts.runs}
            </Typography>
            {data.runs.length > 0 ? (
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
