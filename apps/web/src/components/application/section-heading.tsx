'use client'

import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useState } from 'react'

/**
 * The heading of a section of the cabinet with what the section is in a tooltip — «Страницы»
 * (docs/plan/73-pages-sites.md, Дер7, §7.2) and «Запланированные задачи» (docs/plan/82, Зп2): it
 * lights up under the pointer and the keyboard focus, and opens on a hover, a focus and a tap — a
 * tap comes as a click, Tooltip's own touch listener loses a short one.
 */
export function SectionHeading({ title, about }: { title: string; about: string }) {
  const [open, setOpen] = useState(false)
  const [touch, setTouch] = useState(false)
  return (
    <Typography
      variant="h2"
      component="h1"
      sx={{ flex: '1 1 auto', minWidth: 0, fontSize: { xs: 26, md: 30 }, lineHeight: 1.2 }}
    >
      <Tooltip
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
        <Box
          component="span"
          tabIndex={0}
          onPointerDown={(event) => setTouch(event.pointerType === 'touch')}
          // A tap toggles it; a click of a mouse keeps open what its hover opened.
          onClick={() => setOpen((was) => (touch ? !was : true))}
          sx={{
            cursor: 'help',
            borderRadius: '6px',
            outline: 'none',
            textDecorationLine: 'underline',
            textDecorationStyle: 'dotted',
            textDecorationThickness: '1.5px',
            textUnderlineOffset: '6px',
            textDecorationColor: 'transparent',
            transition: 'color 150ms ease, text-decoration-color 150ms ease',
            '&:hover, &:focus-visible': {
              color: 'primary.main',
              textDecorationColor: 'currentColor',
            },
            '&:focus-visible': { boxShadow: (theme) => `0 0 0 2px ${theme.palette.primary.main}` },
            '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
          }}
        >
          {title}
        </Box>
      </Tooltip>
    </Typography>
  )
}
