'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'
import { useMemo, useState } from 'react'

import { downloadBlob, pictureFileName, svgDataUrl, svgToPng } from '@/lib/svg-picture'

// A diagram the server drew, as the cabinet shows it — of «Схема» (docs/plan/88-artifacts.md, §7.7)
// and of an answer in the chat (docs/plan/91-chat-diagrams.md, Д1): the clean SVG as `<img>` sized
// by its viewBox on white, «Скачать SVG», «Скачать PNG» and its text; no engine runs here.

/**
 * How often the cabinet asks again while core draws a diagram: every 1.5 s for the first minute,
 * then every 30 s for half an hour — the server puts the job again after its window, so a diagram
 * the worker could not draw then is drawn when it is back. Then it stops until the page is opened
 * again (docs/plan/91-chat-diagrams.md, Д5).
 */
export const DIAGRAM_FAST_POLLS = 40
const FAST_POLL_MS = 1500
const SLOW_POLLS = 60
const SLOW_POLL_MS = 30_000

/** The wait before the next ask after `polls` answers of «drawing»; false — no more asks. */
export function diagramPollDelay(polls: number): number | false {
  if (polls < DIAGRAM_FAST_POLLS) return FAST_POLL_MS
  if (polls < DIAGRAM_FAST_POLLS + SLOW_POLLS) return SLOW_POLL_MS
  return false
}

export const diagramPictureText = Object.freeze({
  drawing: 'Рисуем схему…',
  showText: 'Показать текст',
  hideText: 'Скрыть текст',
  svg: 'Скачать SVG',
  png: 'Скачать PNG',
  text: 'Текст схемы',
})

export function DiagramDrawing() {
  return (
    <Box
      role="status"
      sx={{ display: 'flex', alignItems: 'center', gap: 1.5, color: 'text.secondary' }}
    >
      <CircularProgress size={18} />
      <Typography variant="body2">{diagramPictureText.drawing}</Typography>
    </Box>
  )
}

/** The text of a diagram to read, its line of an error marked. */
export function DiagramText({
  text,
  line,
  label = diagramPictureText.text,
}: {
  text: string
  line: number | null
  label?: string
}) {
  return (
    <Box
      component="pre"
      tabIndex={0}
      aria-label={label}
      sx={{
        m: 0,
        p: 1.5,
        maxHeight: 420,
        overflow: 'auto',
        borderRadius: '8px',
        bgcolor: 'background.paper',
        fontFamily: '"JetBrains Mono Variable", monospace',
        fontSize: 12,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text.split('\n').map((each, index) => (
        <Box
          key={index}
          component="span"
          data-error={index + 1 === line ? 'true' : undefined}
          sx={{
            display: 'block',
            ...(index + 1 === line
              ? { bgcolor: 'warning.light', color: 'warning.contrastText' }
              : {}),
          }}
        >
          {each || ' '}
        </Box>
      ))}
    </Box>
  )
}

export function DiagramImage({
  svg,
  width,
  height,
  alt,
  fileTitle,
  text,
  textLabel,
}: {
  svg: string
  width: number
  height: number
  alt: string
  /** The name of the downloaded files, without the extension. */
  fileTitle: string
  /** The text of the diagram, shown under «Показать текст». */
  text: string
  textLabel?: string
}) {
  const [showText, setShowText] = useState(false)
  // Up to 512 KiB encoded once per picture, not on every render.
  const src = useMemo(() => svgDataUrl(svg), [svg])
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Box sx={{ overflowX: 'auto', bgcolor: '#ffffff', borderRadius: '12px', p: 2 }}>
        <Box
          component="img"
          src={src}
          width={width}
          height={height}
          alt={alt}
          sx={{ display: 'block', maxWidth: '100%', height: 'auto', mx: 'auto' }}
        />
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <Button
          size="small"
          variant="outlined"
          onClick={() =>
            downloadBlob(
              pictureFileName(fileTitle, 'svg'),
              new Blob([svg], { type: 'image/svg+xml' }),
            )
          }
        >
          {diagramPictureText.svg}
        </Button>
        <Button
          size="small"
          variant="outlined"
          onClick={async () => {
            const png = await svgToPng(svg, width, height)
            if (png) downloadBlob(pictureFileName(fileTitle, 'png'), png)
          }}
        >
          {diagramPictureText.png}
        </Button>
        <Button size="small" onClick={() => setShowText((shown) => !shown)}>
          {showText ? diagramPictureText.hideText : diagramPictureText.showText}
        </Button>
      </Box>
      {showText && <DiagramText text={text} line={null} label={textLabel} />}
    </Box>
  )
}
