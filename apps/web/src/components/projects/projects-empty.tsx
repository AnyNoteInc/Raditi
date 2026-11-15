'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Typography from '@mui/material/Typography'
import { AnimatedBrandSymbol } from '@repo/ui/animated-brand-symbol'

import { AppIcon } from '@/components/application/app-icon'

import { projectsEmptyText } from './project-texts'

/**
 * A folder with its sheets and the mark of Радити over it (P-empty), in the colours of the theme;
 * the sheets come up once unless the viewer asked for less motion.
 */
function FolderMark() {
  return (
    <Box
      aria-hidden
      sx={{
        position: 'relative',
        width: 150,
        height: 112,
        '@keyframes projectsSheet': {
          from: { transform: 'translateY(10px)', opacity: 0 },
          to: { transform: 'none', opacity: 1 },
        },
        '@media (prefers-reduced-motion: no-preference)': {
          '& .sheet': { animation: 'projectsSheet 520ms var(--raditi-ease-out) both' },
          '& .sheet + .sheet': { animationDelay: '120ms' },
        },
      }}
    >
      {[
        { left: 38, top: 6, rotate: -6 },
        { left: 58, top: 2, rotate: 5 },
      ].map((sheet) => (
        <Box
          key={sheet.left}
          className="sheet"
          sx={{
            position: 'absolute',
            left: sheet.left,
            top: sheet.top,
            width: 54,
            height: 66,
            borderRadius: '8px',
            border: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
            rotate: `${sheet.rotate}deg`,
            p: 1,
            display: 'grid',
            alignContent: 'start',
            gap: 0.75,
          }}
        >
          {[70, 90, 55].map((width) => (
            <Box
              key={width}
              sx={{ height: 4, width: `${width}%`, borderRadius: 2, bgcolor: 'divider' }}
            />
          ))}
        </Box>
      ))}
      <Box
        sx={{
          position: 'absolute',
          left: 12,
          right: 12,
          bottom: 0,
          height: 66,
          borderRadius: '12px',
          border: 1.5,
          borderColor: 'text.secondary',
          bgcolor: 'background.default',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <AnimatedBrandSymbol size={34} />
      </Box>
    </Box>
  )
}

/**
 * «Проекты» before the first project (docs/plan/84-projects.md, ПР4; P-empty): what a project is
 * for, «Новый проект» and three examples that fill the window of a new project.
 */
export function ProjectsEmpty({
  onCreate,
}: {
  /** Opens «Создание проекта», filled by an example or empty. */
  onCreate: (initial: { name: string; goal: string } | null) => void
}) {
  return (
    <Box
      component="section"
      aria-labelledby="projects-empty-title"
      sx={{
        maxWidth: 560,
        mx: 'auto',
        mt: { xs: 6, md: 10 },
        mb: 6,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
      }}
    >
      <FolderMark />
      <Typography
        id="projects-empty-title"
        component="h2"
        sx={{ mt: 3, fontSize: { xs: 22, md: 26 }, fontWeight: 600, lineHeight: 1.3 }}
      >
        {projectsEmptyText.title}
      </Typography>
      <Typography sx={{ mt: 1.25, color: 'text.secondary', fontSize: { xs: 15, md: 16 } }}>
        {projectsEmptyText.lead}
      </Typography>
      <Button
        variant="contained"
        onClick={() => onCreate(null)}
        startIcon={<AppIcon name="plus" size={16} />}
        sx={{ mt: 3, minHeight: 44, px: 3 }}
      >
        {projectsEmptyText.start}
      </Button>
      <Typography variant="caption" sx={{ mt: 4, mb: 1.25, color: 'text.secondary' }}>
        {projectsEmptyText.examplesTitle}
      </Typography>
      <Box
        component="ul"
        sx={{
          listStyle: 'none',
          m: 0,
          p: 0,
          width: '100%',
          border: 1,
          borderColor: 'divider',
          borderRadius: '12px',
          overflow: 'hidden',
          bgcolor: 'background.paper',
        }}
      >
        {projectsEmptyText.examples.map((example, index) => (
          <Box
            component="li"
            key={example.name}
            sx={index > 0 ? { borderTop: 1, borderColor: 'divider' } : undefined}
          >
            <ButtonBase
              aria-haspopup="dialog"
              onClick={() => onCreate({ name: example.name, goal: example.goal })}
              sx={{
                width: '100%',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 1.5,
                px: 2,
                py: 1.5,
                minHeight: 48,
                textAlign: 'left',
                justifyContent: 'flex-start',
                '&:hover, &.Mui-focusVisible': { bgcolor: 'action.hover' },
              }}
            >
              <Box sx={{ display: 'flex', color: 'text.secondary', pt: '2px' }} aria-hidden>
                <AppIcon name={example.icon} size={18} />
              </Box>
              <Typography component="span" sx={{ fontSize: 15, lineHeight: 1.45 }}>
                {example.name}
              </Typography>
            </ButtonBase>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
