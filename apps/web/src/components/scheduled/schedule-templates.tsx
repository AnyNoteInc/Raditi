'use client'

import {
  DEFAULT_SCHEDULE_TIMEZONE,
  scheduleTemplates,
  scheduleText,
  type ScheduleTemplate,
} from '@repo/domain/schedule'
import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Typography from '@mui/material/Typography'
import { useId } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { nbsp } from '@/lib/nbsp'

import { scheduleTemplateTexts } from './schedule-texts'

/** One template: its icon, name, when it runs, and whether it is set up already. */
function TemplateCard({
  template,
  used,
  onOpen,
}: {
  template: ScheduleTemplate
  used: boolean
  onOpen: (template: ScheduleTemplate, opener: HTMLElement) => void
}) {
  const nameId = useId()
  const aboutId = useId()
  return (
    <Box component="li" sx={{ minWidth: 0, display: 'flex' }}>
      <ButtonBase
        aria-labelledby={nameId}
        aria-describedby={aboutId}
        onClick={(event) => onOpen(template, event.currentTarget)}
        sx={{
          flex: '1 1 auto',
          minWidth: 0,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'flex-start',
          gap: 1.5,
          p: 2,
          textAlign: 'left',
          border: 1,
          borderColor: 'divider',
          borderRadius: '14px',
          bgcolor: 'background.paper',
          transition: 'border-color 150ms ease, background-color 150ms ease',
          '&:hover': { borderColor: 'text.secondary' },
          '&.Mui-focusVisible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2,
          },
          '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
        }}
      >
        <Box
          aria-hidden
          sx={{
            flexShrink: 0,
            width: 40,
            height: 40,
            display: 'grid',
            placeItems: 'center',
            borderRadius: '12px',
            bgcolor: 'action.hover',
            color: 'text.primary',
          }}
        >
          <AppIcon name={template.icon} size={20} />
        </Box>
        <Box sx={{ minWidth: 0, flex: '1 1 auto' }}>
          <Typography
            id={nameId}
            component="span"
            sx={{ display: 'block', fontSize: 15, fontWeight: 600, lineHeight: 1.35 }}
          >
            {template.name}
          </Typography>
          <Box id={aboutId} component="span" sx={{ display: 'block' }}>
            <Typography
              component="span"
              variant="body2"
              sx={{ display: 'block', mt: 0.5, color: 'text.secondary', lineHeight: 1.45 }}
            >
              {nbsp(scheduleText(template.triggers, DEFAULT_SCHEDULE_TIMEZONE))}
            </Typography>
            {used ? (
              <Box component="span" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 1 }}>
                <Box
                  component="span"
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.5,
                    px: 1,
                    py: 0.25,
                    borderRadius: 999,
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'success.main',
                    bgcolor: 'action.hover',
                  }}
                >
                  <AppIcon name="check" size={13} />
                  {scheduleTemplateTexts.used}
                </Box>
              </Box>
            ) : null}
          </Box>
        </Box>
      </ButtonBase>
    </Box>
  )
}

/**
 * The templates of a task (docs/plan/82-scheduled-tasks.md, Зп9, §4.6): six, one column on a
 * phone and two from `sm` (Зп4). A click opens the window filled in — nothing is created before
 * «Создать»; one already used is marked «Уже настроен».
 */
export function ScheduleTemplateGrid({
  used,
  onOpen,
  wide = false,
}: {
  /** The slugs of the templates the user's tasks were made from. */
  used: ReadonlySet<string>
  /** `opener` — the card pressed: the window gives the focus back to it. */
  onOpen: (template: ScheduleTemplate, opener: HTMLElement) => void
  /** The tab «Шаблоны»: three columns on a wide screen. */
  wide?: boolean
}) {
  return (
    <Box
      component="ul"
      aria-label={scheduleTemplateTexts.list}
      sx={{
        listStyle: 'none',
        m: 0,
        p: 0,
        display: 'grid',
        gridTemplateColumns: {
          xs: 'minmax(0, 1fr)',
          sm: 'repeat(2, minmax(0, 1fr))',
          ...(wide ? { lg: 'repeat(3, minmax(0, 1fr))' } : {}),
        },
        gap: 1.5,
      }}
    >
      {scheduleTemplates.map((template) => (
        <TemplateCard
          key={template.slug}
          template={template}
          used={used.has(template.slug)}
          onOpen={onOpen}
        />
      ))}
    </Box>
  )
}
