'use client'

import { runMomentText } from '@repo/domain/schedule'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import IconButton from '@mui/material/IconButton'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useQuery } from '@tanstack/react-query'
import NextLink from 'next/link'
import { useId, useRef, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import {
  ScheduleNoticeBar,
  useScheduleActions,
  type ScheduleNotice,
} from '@/components/scheduled/schedule-actions'
import {
  ScheduleDialog,
  type FixedProject,
  type ScheduleDialogOpening,
} from '@/components/scheduled/schedule-dialog'
import {
  scheduleStateText,
  sortSchedules,
  type ScheduleItem,
} from '@/components/scheduled/schedule-model'
import { ScheduleRow } from '@/components/scheduled/schedule-row'
import { projectScheduleTexts, scheduleDialogTexts } from '@/components/scheduled/schedule-texts'
import { useNow } from '@/components/scheduled/use-now'
import { useTRPC } from '@/trpc/client'

import type { ProjectDetails } from './project-types'

/** The lines «<name> · <when>» the column shows before «и ещё N задач». */
const LINES = 3

/** When a task runs next, short, or why it does not (Зп5). */
function whenOf(item: ScheduleItem, now: Date): string {
  if (item.enabled && item.nextRunAt !== null)
    return runMomentText(item.nextRunAt, item.timezone, now)
  return scheduleStateText(item, now)
}

const fixedOf = (project: Pick<ProjectDetails, 'id' | 'name' | 'repository'>): FixedProject => ({
  id: project.id,
  name: project.name,
  repository: project.repository !== null,
})

/**
 * «Запланировано» of the column of a project (docs/plan/84-projects.md, ПР19; P-schedule-list): up
 * to three of its tasks, «<name> · <when>»; the title opens the window of its tasks, «Добавить» —
 * «Новая запланированная задача» with the project fixed (P-schedule). A project in «Архив» takes
 * no new task.
 */
export function ProjectSchedulesRow({
  project,
  userId,
}: {
  project: Pick<ProjectDetails, 'id' | 'name' | 'archived' | 'repository'>
  userId: string
}) {
  const trpc = useTRPC()
  const now = useNow()
  const list = useQuery(trpc.schedule.list.queryOptions({ projectId: project.id }))
  const [listOpen, setListOpen] = useState(false)
  const [opening, setOpening] = useState<ScheduleDialogOpening | null>(null)
  const [notice, setNotice] = useState<ScheduleNotice>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const items = sortSchedules(list.data?.schedules ?? [], 'next')
  const fixed = fixedOf(project)

  return (
    <Box
      component="section"
      aria-labelledby={titleId}
      data-project-schedules=""
      sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ display: 'flex', color: 'text.secondary' }} aria-hidden>
          <AppIcon name="timer" size={18} />
        </Box>
        <Typography
          id={titleId}
          component="h2"
          sx={{ flex: '1 1 auto', fontSize: 15, fontWeight: 600 }}
        >
          <ButtonBase
            aria-haspopup="dialog"
            aria-label={projectScheduleTexts.openLabel}
            onClick={() => setListOpen(true)}
            sx={{
              font: 'inherit',
              borderRadius: '6px',
              '&:hover': { textDecoration: 'underline' },
              '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' },
            }}
          >
            {projectScheduleTexts.title}
          </ButtonBase>
        </Typography>
        {project.archived ? null : (
          <Button
            ref={addButton}
            size="small"
            aria-haspopup="dialog"
            aria-label={projectScheduleTexts.addLabel}
            onClick={() => setOpening({ kind: 'new', project: fixed })}
            sx={{ minHeight: 44 }}
          >
            {projectScheduleTexts.add}
          </Button>
        )}
      </Box>
      {items.length === 0 ? (
        <Typography sx={{ color: 'text.secondary', fontSize: 14 }}>
          {list.isPending ? null : projectScheduleTexts.empty}
        </Typography>
      ) : (
        <Box
          component="ul"
          sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 0.5 }}
        >
          {items.slice(0, LINES).map((item) => (
            <Typography
              key={item.id}
              component="li"
              sx={{ fontSize: 14, color: 'text.secondary', overflowWrap: 'anywhere' }}
            >
              <Link
                component={NextLink}
                href={`/scheduled/${item.id}`}
                color="text.primary"
                underline="hover"
              >
                {item.name}
              </Link>
              {` · ${whenOf(item, now)}`}
            </Typography>
          ))}
          {items.length > LINES ? (
            <Typography component="li" sx={{ fontSize: 14, color: 'text.secondary' }}>
              {projectScheduleTexts.more(items.length - LINES)}
            </Typography>
          ) : null}
        </Box>
      )}
      <ProjectSchedulesDialog
        project={project}
        open={listOpen}
        onClose={() => setListOpen(false)}
        onAdd={() => {
          setListOpen(false)
          setOpening({ kind: 'new', project: fixed })
        }}
        onEdit={(schedule) => {
          setListOpen(false)
          setOpening({ kind: 'edit', schedule, project: fixed })
        }}
        onNotice={setNotice}
      />
      <ScheduleDialog
        opening={opening}
        userId={userId}
        onClose={() => setOpening(null)}
        onSaved={(_, created) =>
          setNotice({ text: created ? scheduleDialogTexts.created : scheduleDialogTexts.saved })
        }
        returnFocus={() => addButton.current}
      />
      <ScheduleNoticeBar notice={notice} onClose={() => setNotice(null)} />
    </Box>
  )
}

/**
 * The window «Запланировано» of a project (P-schedule-list): its tasks — the schedules in words,
 * when they run next, the last run, the switch and «⋯» with «Запустить сейчас» —, and the way to
 * all the tasks in «Задачи». Full screen on a phone.
 */
export function ProjectSchedulesDialog({
  project,
  open,
  onClose,
  onAdd,
  onEdit,
  onNotice,
}: {
  project: Pick<ProjectDetails, 'id' | 'archived'>
  open: boolean
  onClose: () => void
  onAdd: () => void
  onEdit: (schedule: ScheduleItem) => void
  onNotice: (notice: ScheduleNotice) => void
}) {
  const trpc = useTRPC()
  const now = useNow()
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'))
  const titleId = useId()
  const actions = useScheduleActions(onNotice)
  const list = useQuery({
    ...trpc.schedule.list.queryOptions({ projectId: project.id }),
    enabled: open,
  })
  const items = sortSchedules(list.data?.schedules ?? [], 'next')
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={fullScreen}
      aria-labelledby={titleId}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: '100%',
            maxWidth: { sm: 640 },
            m: { sm: 2 },
            border: { sm: 1 },
            borderColor: { sm: 'divider' },
            borderRadius: { xs: 0, sm: '14px' },
          },
        },
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, p: { xs: 2.5, sm: 3 } }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
          <Typography
            id={titleId}
            component="h2"
            sx={{ flex: '1 1 auto', fontSize: 20, fontWeight: 600 }}
          >
            {projectScheduleTexts.title}
          </Typography>
          {project.archived ? null : (
            <Button size="small" onClick={onAdd} sx={{ minHeight: 44 }}>
              {projectScheduleTexts.add}
            </Button>
          )}
          <IconButton
            aria-label={projectScheduleTexts.close}
            onClick={onClose}
            sx={{ width: 44, height: 44, mt: -1, mr: -1 }}
          >
            <AppIcon name="close" size={20} />
          </IconButton>
        </Box>
        <Typography sx={{ color: 'text.secondary', fontSize: 14 }}>
          {projectScheduleTexts.lead}
        </Typography>
        {project.archived ? <Alert severity="info">{projectScheduleTexts.archived}</Alert> : null}
        {list.isPending ? (
          <Box role="status" sx={{ py: 2, display: 'flex' }}>
            <CircularProgress size={20} />
          </Box>
        ) : list.isError ? (
          <Alert severity="error">{projectScheduleTexts.failed}</Alert>
        ) : items.length === 0 ? (
          <Typography sx={{ fontSize: 15 }}>{projectScheduleTexts.none}</Typography>
        ) : (
          <Box
            component="ul"
            aria-label={projectScheduleTexts.title}
            sx={{
              listStyle: 'none',
              m: 0,
              p: 0,
              border: 1,
              borderColor: 'divider',
              borderRadius: '14px',
              overflow: 'hidden',
            }}
          >
            {items.map((item) => (
              <ScheduleRow
                key={item.id}
                item={item}
                now={now}
                actions={actions}
                showProject={false}
                onEdit={(schedule) => onEdit(schedule)}
              />
            ))}
          </Box>
        )}
        <Typography sx={{ color: 'text.secondary', fontSize: 14 }}>
          {`${projectScheduleTexts.allIn} `}
          <Link component={NextLink} href="/scheduled">
            {projectScheduleTexts.allLink}
          </Link>
        </Typography>
      </Box>
    </Dialog>
  )
}
