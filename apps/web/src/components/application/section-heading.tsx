'use client'

import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useId, useState } from 'react'

import { AppIcon } from './app-icon'

/**
 * The size of the title of a section of the rail — «Запланированные задачи», «Страницы»,
 * «Проекты»: one on a phone for all of them. 22 px there: «Запланированные» is 302 px at 26 px
 * of the heading face, over the line a phone of 375 px leaves beside the rail.
 */
export const sectionTitleSize = { xs: 22, sm: 26, md: 30 } as const

/** The name of «i» beside the title. */
export const sectionAboutLabel = 'Что это за раздел'

/**
 * The heading of a section of the cabinet with what the section is in a tooltip — «Страницы»
 * (docs/plan/73-pages-sites.md, Дер7, §7.2) and «Запланированные задачи» (docs/plan/82, Зп2).
 * «i» after the title says there is something to read, and is the way to it from the keyboard;
 * the title itself lights up under the pointer. Both open the tooltip on a hover and a tap — a tap
 * comes as a click, Tooltip's own touch listener loses a short one — and «i» on a focus.
 *
 * The title and «i» are one line of text, so «i» follows the last word, on a second line too; «i»
 * stays outside the `h1`, whose name is the title alone. A word longer than the line of a narrow
 * phone breaks: the page never scrolls sideways. Beside an action, the row of the heading wraps
 * (`flexWrap`), so the action moves under the title before a word breaks.
 */
export function SectionHeading({ title, about }: { title: string; about: string }) {
  const [open, setOpen] = useState(false)
  const [touch, setTouch] = useState(false)
  const tooltipId = useId()
  return (
    // Grows, so an action beside the heading stands at the right edge; the tooltip hangs on what
    // is inside, which is as wide as its words.
    <Box sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex' }}>
      <Tooltip
        id={tooltipId}
        describeChild
        title={about}
        placement="bottom-start"
        open={open}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        disableTouchListener
        slotProps={{
          tooltip: { sx: { maxWidth: 360, p: 1.5, fontSize: 13, lineHeight: 1.45 } },
        }}
      >
        <Typography
          variant="h2"
          component="div"
          onPointerDown={(event) => setTouch(event.pointerType === 'touch')}
          // A tap toggles it; a click of a mouse keeps open what its hover opened.
          onClick={() => setOpen((was) => (touch ? !was : true))}
          sx={{
            minWidth: 0,
            fontSize: sectionTitleSize,
            lineHeight: 1.2,
            overflowWrap: 'break-word',
          }}
        >
          <Box
            component="h1"
            sx={{ display: 'inline', m: 0, font: 'inherit', letterSpacing: 'inherit' }}
          >
            <Box
              component="span"
              sx={{
                cursor: 'help',
                textDecorationLine: 'underline',
                textDecorationStyle: 'dotted',
                textDecorationThickness: '1.5px',
                textUnderlineOffset: '6px',
                textDecorationColor: 'transparent',
                transition: 'color 150ms ease, text-decoration-color 150ms ease',
                '&:hover': { color: 'primary.main', textDecorationColor: 'currentColor' },
                '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
              }}
            >
              {title}
            </Box>
          </Box>
          <IconButton
            aria-label={sectionAboutLabel}
            aria-describedby={open ? tooltipId : undefined}
            sx={{
              width: { xs: 28, sm: 32 },
              height: { xs: 28, sm: 32 },
              p: 0,
              ml: 0.75,
              // Out of the height of the line: a second line of the title keeps its spacing.
              my: -0.5,
              verticalAlign: 'middle',
              color: open ? 'primary.main' : 'text.secondary',
              '&:hover': { color: 'primary.main', bgcolor: 'action.hover' },
              // A target of 40–44 px for a finger, drawn at 28–32.
              '&::before': { content: '""', position: 'absolute', inset: -6 },
            }}
          >
            <AppIcon name="info" size={18} />
          </IconButton>
        </Typography>
      </Tooltip>
    </Box>
  )
}
