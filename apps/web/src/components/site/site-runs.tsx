import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'

import { moscowClock } from '@/components/chat/chat-format'
import { formatMoscowDay, formatMoscowMoment } from '@/lib/moscow-date'
import { plural } from '@/lib/plural'

import type { HistoryItem } from './history-list'
import {
  durationText,
  runLineText,
  runListNote,
  runOutcomeText,
  runStateText,
  runTitle,
  stepNameText,
  stepStateText,
  type RunView,
  type StepName,
  type StepState,
} from './history-text'
import { SectionTitle } from './section-empty'
import { SiteCard } from './site-cards'
import { SiteLink } from './site-link'
import { siteHref } from './site-nav'

export interface RunDetailView extends RunView {
  steps: { step: StepName; state: StepState; startedAt: Date; finishedAt: Date | null }[]
  lines: { at: Date; step: StepName; event: StepState | 'files'; files?: number; bytes?: number }[]
}

const tone = (state: RunView['state']): HistoryItem['tone'] =>
  state === 'installed' ? 'ok' : state === 'running' ? 'running' : 'error'

/** The items of the list of «Запуски»: the newest first. */
export function runItems(runs: readonly RunView[]): HistoryItem[] {
  return runs.map((run) => ({
    segment: run.id,
    title: `№ ${run.number} · ${runTitle(run)}`,
    note: runListNote(run),
    ...(run.state === 'running' ? { badge: 'идёт' } : {}),
    tone: tone(run.state),
    filters:
      run.state === 'running' ? ['running'] : run.state === 'installed' ? [] : ['errors'],
  }))
}

const stepTone = { started: 'warning.main', succeeded: 'success.main', failed: 'error.main', unknown: 'text.disabled' } as const

/**
 * One run of «Запуски»: who started it and when, how it ended, its steps, and its journal across
 * the full width — made of the platform's own reports, never of the output of a program.
 */
export function RunDetail({
  siteId,
  run,
  now,
  nested = false,
}: {
  siteId: string
  run: RunDetailView
  now: Date
  /** At the root of the section the list holds the page's heading: this one is the next level. */
  nested?: boolean
}) {
  const outcome = runOutcomeText(run)
  const took = durationText(run.startedAt, run.finishedAt ?? now)
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <SectionTitle {...(nested ? { level: 'h2' as const } : {})}>
          Запуск № {run.number} · {runTitle(run)}
        </SectionTitle>
        <Typography sx={{ fontWeight: 600 }}>{runStateText[run.state]}</Typography>
        <Typography color="text.secondary">
          {run.kind === 'import' ? 'Запуск: подключение сайта' : `Запуск: ${run.approvedBy ?? 'владелец сайта'}, после «Выпустить»`}
          {' · '}
          <time dateTime={run.startedAt.toISOString()}>{formatMoscowMoment(run.startedAt)}</time>
          {' · '}
          {run.finishedAt ? `длился ${took}` : `идёт ${took}`}
          {run.state === 'installed' && run.version ? ` · версия ${run.version}` : ''}
        </Typography>
        {run.taskId ? (
          <Box sx={{ pt: 0.5 }}>
            <SiteLink href={`${siteHref(siteId, 'chat')}/${run.taskId}`}>Открыть диалог</SiteLink>
          </Box>
        ) : null}
      </Box>

      {outcome ? (
        <Box
          role={run.state === 'running' ? 'status' : undefined}
          sx={{
            border: 1,
            borderColor: run.state === 'running' ? 'divider' : 'error.main',
            borderRadius: '14px',
            px: { xs: 2, sm: 2.75 },
            py: 2,
          }}
        >
          <Typography>{outcome}</Typography>
        </Box>
      ) : null}

      <SiteCard title="Шаги">
        {run.steps.length === 0 ? (
          <Typography color="text.secondary" sx={{ px: { xs: 2, sm: 2.75 }, py: 2.25 }}>
            Шагов пока нет: обновление ещё не началось.
          </Typography>
        ) : (
          <Box component="ol" sx={{ m: 0, p: 0, listStyle: 'none' }}>
            {run.steps.map((step, index) => (
              <Box
                component="li"
                key={`${step.step}-${index}`}
                sx={{
                  px: { xs: 2, sm: 2.75 },
                  py: 1.5,
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '4px 16px',
                  borderTop: index === 0 ? 0 : 1,
                  borderColor: 'divider',
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <Box
                    component="span"
                    aria-hidden="true"
                    sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: stepTone[step.state] }}
                  />
                  <Typography sx={{ fontWeight: 600 }}>{stepNameText[step.step]}</Typography>
                </Box>
                <Typography variant="body2" color="text.secondary">
                  {stepStateText[step.state]} · {durationText(step.startedAt, step.finishedAt ?? now)}
                </Typography>
              </Box>
            ))}
          </Box>
        )}
      </SiteCard>

      <SiteCard
        title="Журнал"
        note={`${formatMoscowDay(run.startedAt)} · время московское · ${run.lines.length} ${plural(run.lines.length, 'строка', 'строки', 'строк')}`}
      >
        <Box sx={{ overflowX: 'auto' }}>
          <Box
            component="ol"
            sx={{
              m: 0,
              px: { xs: 2, sm: 2.75 },
              py: 1.5,
              listStyle: 'none',
              display: 'grid',
              gridTemplateColumns: 'auto auto minmax(0, 1fr)',
              gap: '6px 16px',
              fontSize: 14,
            }}
          >
            {run.lines.map((line, index) => (
              <Box component="li" key={index} sx={{ display: 'contents' }}>
                <Typography component="span" variant="body2" color="text.secondary" sx={{ textAlign: 'right' }}>
                  {index + 1}
                </Typography>
                <Typography component="span" variant="body2" color="text.secondary">
                  <time dateTime={line.at.toISOString()}>{moscowClock(line.at)}</time>
                </Typography>
                <Typography
                  component="span"
                  variant="body2"
                  sx={{ color: line.event === 'failed' ? 'error.main' : 'text.primary' }}
                >
                  {runLineText(line)}
                </Typography>
              </Box>
            ))}
          </Box>
        </Box>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', px: { xs: 2, sm: 2.75 }, py: 1.5, borderTop: 1, borderColor: 'divider' }}
        >
          Журнал составлен из сообщений Радити о шагах. Вывод служебных программ в него не попадает.
        </Typography>
      </SiteCard>
    </Box>
  )
}

/** «Запуски» of a site that has none yet. */
export function NoRuns() {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <SectionTitle>Запуски</SectionTitle>
      <Typography color="text.secondary">
        Запусков пока нет. Здесь появится каждое обновление сайта: его шаги и журнал.
      </Typography>
    </Box>
  )
}
