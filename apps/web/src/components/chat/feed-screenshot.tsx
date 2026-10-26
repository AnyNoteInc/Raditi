'use client'

import Box from '@mui/material/Box'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { useParams } from 'next/navigation'

/** The words of a snapshot in the dialog. */
export const feedScreenshotText = Object.freeze({
  title: (number: number) => `Снимок экрана № ${number}`,
  alt: (number: number) => `Снимок экрана сайта № ${number}, сделанный агентом в браузере задачи`,
  open: 'Открыть в полном размере',
})

/** Where the cabinet serves a snapshot of a task: its own origin, for a member of the task. */
export const taskScreenshotHref = (taskId: string, screenshotId: string): string =>
  `/api/tasks/${encodeURIComponent(taskId)}/screenshots/${encodeURIComponent(screenshotId)}`

/**
 * A snapshot the agent took of the task's browser for the client (`feed.screenshot`, owner's
 * request of 26.10.2026): the image in the dialog, at its own proportions, and a link to it full
 * size. The task is the one of the page (`/projects/{id}/chat/{taskId}`).
 */
export function FeedScreenshot({
  screenshotId,
  number,
  width,
  height,
}: {
  screenshotId: string
  number: number
  width: number
  height: number
}) {
  const { taskId } = useParams<{ taskId?: string }>()
  if (typeof taskId !== 'string') return null
  const href = taskScreenshotHref(taskId, screenshotId)
  return (
    <Box
      component="figure"
      sx={{
        alignSelf: 'stretch',
        m: 0,
        p: { xs: 2, sm: 2.5 },
        border: 1,
        borderColor: 'divider',
        borderRadius: '18px',
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.25,
      }}
    >
      <Typography component="figcaption" sx={{ fontSize: 15, fontWeight: 600 }}>
        {feedScreenshotText.title(number)}
      </Typography>
      <Box
        component="a"
        href={href}
        target="_blank"
        rel="noopener"
        sx={{
          display: 'block',
          borderRadius: '12px',
          overflow: 'hidden',
          border: 1,
          borderColor: 'divider',
          lineHeight: 0,
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2,
          },
        }}
      >
        <Box
          component="img"
          src={href}
          alt={feedScreenshotText.alt(number)}
          width={width}
          height={height}
          loading="lazy"
          sx={{ display: 'block', width: '100%', height: 'auto' }}
        />
      </Box>
      <Link
        href={href}
        target="_blank"
        rel="noopener"
        variant="body2"
        sx={{ alignSelf: 'flex-start' }}
      >
        {feedScreenshotText.open}
      </Link>
    </Box>
  )
}
