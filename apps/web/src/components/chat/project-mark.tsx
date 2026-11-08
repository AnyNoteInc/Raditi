import Box from '@mui/material/Box'
import type { ReactNode } from 'react'

/** The first letter of a name, whole: a name may start with one that takes two UTF-16 units. */
const letterOf = (name: string) => Array.from(name.trim())[0]?.toLocaleLowerCase('ru') || '•'

/** The small square that stands for a project: its letter, or a sign given instead. */
export function ProjectMark({
  name,
  sign,
  size = 20,
}: {
  name?: string
  sign?: ReactNode
  size?: number
}) {
  return (
    <Box
      component="span"
      aria-hidden="true"
      sx={{
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: `${Math.round(size * 0.29)}px`,
        bgcolor: 'action.selected',
        color: 'text.primary',
        fontSize: Math.round(size * 0.5),
        fontWeight: 600,
        lineHeight: 1,
      }}
    >
      {sign ?? letterOf(name ?? '')}
    </Box>
  )
}
