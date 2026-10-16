'use client'

import Box from '@mui/material/Box'

type Offset = number | string

/**
 * The first link of a cabinet shell: hidden above the screen until the keyboard reaches it,
 * then shown beside the navigation it lets the reader skip.
 */
export function SkipLink({
  target,
  left,
}: {
  /** The id of the element that holds the page's content. */
  target: string
  /** Where the shown link stands from the left edge: past the rail or the sidebar. */
  left: Offset | { xs: Offset; sm?: Offset; md?: Offset }
}) {
  return (
    <Box
      component="a"
      href={`#${target}`}
      sx={{
        position: 'fixed',
        top: -100,
        left,
        zIndex: 1500,
        p: 1.5,
        bgcolor: 'background.paper',
        color: 'text.primary',
        '&:focus': { top: 8 },
      }}
    >
      Перейти к содержимому
    </Box>
  )
}
