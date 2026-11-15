'use client'

import type { ScheduleTemplate } from '@repo/domain/schedule'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'

import { AppIcon } from '@/components/application/app-icon'
import { nbsp } from '@/lib/nbsp'

import { ScheduleTemplateGrid } from './schedule-templates'
import { scheduledEmptyTexts, scheduledTexts } from './schedule-texts'
import { StopwatchMark } from './stopwatch-mark'

const NONE: ReadonlySet<string> = new Set()

/**
 * «Ваши» before the first task (docs/plan/82-scheduled-tasks.md, Зп4): no filters, no search —
 * the stopwatch, what will be here, «Настроить вручную» and «Настроить в чате», and the templates
 * to begin with under a dashed line.
 */
export function ScheduledEmpty({
  onByHand,
  onInChat,
  onTemplate,
}: {
  onByHand: (opener: HTMLElement) => void
  onInChat: () => void
  onTemplate: (template: ScheduleTemplate, opener: HTMLElement) => void
}) {
  return (
    <Box
      component="section"
      aria-labelledby="scheduled-empty-title"
      sx={{
        width: '100%',
        maxWidth: 720,
        mx: 'auto',
        mt: { xs: 4, md: 7 },
        mb: 6,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
      }}
    >
      <StopwatchMark />
      <Typography
        id="scheduled-empty-title"
        component="h2"
        sx={{ mt: 2.5, fontSize: { xs: 22, md: 26 }, fontWeight: 600, lineHeight: 1.3 }}
      >
        {scheduledEmptyTexts.title}
      </Typography>
      <Typography
        sx={{
          mt: 1.25,
          maxWidth: 480,
          color: 'text.secondary',
          fontSize: { xs: 15, md: 16 },
          textWrap: 'pretty',
        }}
      >
        {nbsp(scheduledEmptyTexts.lead)}
      </Typography>
      <Box
        sx={{
          mt: 3,
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: 1.25,
          width: { xs: '100%', sm: 'auto' },
          '& > *': { flex: { xs: '1 1 100%', sm: '0 0 auto' } },
        }}
      >
        <Button
          variant="contained"
          onClick={(event) => onByHand(event.currentTarget)}
          startIcon={<AppIcon name="plus" size={16} />}
          sx={{ minHeight: 44, px: 3 }}
        >
          {scheduledTexts.byHand}
        </Button>
        <Button
          variant="outlined"
          color="inherit"
          onClick={onInChat}
          startIcon={<AppIcon name="chat" size={16} />}
          sx={{ minHeight: 44, px: 3, borderColor: 'divider' }}
        >
          {scheduledTexts.inChat}
        </Button>
      </Box>
      <Box
        sx={{
          mt: 5,
          mb: 2.5,
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          color: 'text.secondary',
          '&::before, &::after': {
            content: '""',
            flex: '1 1 auto',
            borderTop: '1px dashed var(--mui-palette-divider)',
          },
        }}
      >
        <Typography component="h3" variant="body2" sx={{ color: 'inherit', flex: 'none' }}>
          {scheduledEmptyTexts.orTemplate}
        </Typography>
      </Box>
      <Box sx={{ width: '100%', textAlign: 'left' }}>
        <ScheduleTemplateGrid used={NONE} onOpen={onTemplate} />
      </Box>
    </Box>
  )
}
