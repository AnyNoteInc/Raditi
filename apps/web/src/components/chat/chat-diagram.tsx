'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'
import { diagramErrorRu } from '@repo/domain/artifacts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { downloadBlob, pictureFileName, svgDataUrl, svgToPng } from '@/lib/svg-picture'
import { useTRPC } from '@/trpc/client'

import { chatDiagramText } from './chat-texts'
import { CodeBlock } from './code-block'

// A diagram in an answer of the agent (docs/plan/91-chat-diagrams.md, Д1): the picture the server
// drew of the text — Mermaid or PlantUML in the render pool, an SVG cleaned by DOMPurify, shown as
// `<img>`; no engine runs in the cabinet. The chat names the row and the place of the diagram, the
// server reads its text. While it draws — «Рисуем схему…»; a text that did not parse shows its
// line and the text; a diagram the server cannot find, or one drawn too long, stays code.

/** How often the chat asks again while core draws: every 1.5 s, for a minute at most. */
const DRAWING_POLL_MS = 1500
const DRAWING_POLLS = 40

export interface ChatDiagramPlace {
  taskId: string
  /** `task_events.id` of the answer. */
  row: string
  /** The place of the diagram among the diagrams of the answer. */
  index: number
}

export function ChatDiagram({
  place,
  language,
  text,
}: {
  place: ChatDiagramPlace
  language: string
  text: string
}) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const options = trpc.task.diagram.queryOptions(place)
  const picture = useQuery({
    ...options,
    staleTime: Infinity,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.state === 'drawing' && query.state.dataUpdateCount < DRAWING_POLLS
        ? DRAWING_POLL_MS
        : false,
  })
  const [showText, setShowText] = useState(false)
  const data = picture.data
  const code = <CodeBlock language={language} text={text} />

  if (picture.isError) return code
  if (!data || data.state === 'drawing') {
    const polls = queries.getQueryState(options.queryKey)?.dataUpdateCount ?? 0
    if (data && polls >= DRAWING_POLLS)
      return (
        <Box>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {chatDiagramText.slow}
          </Typography>
          {code}
        </Box>
      )
    return (
      <Box
        role="status"
        sx={{ display: 'flex', alignItems: 'center', gap: 1.5, my: 1.5, color: 'text.secondary' }}
      >
        <CircularProgress size={18} />
        <Typography variant="body2">{chatDiagramText.drawing}</Typography>
      </Box>
    )
  }
  if (data.state === 'failed')
    return (
      <Box sx={{ my: 1.5 }}>
        <Alert severity="warning">{diagramErrorRu(data.line)}</Alert>
        {code}
      </Box>
    )
  const name = pictureFileName(chatDiagramText.fileName, 'svg')
  return (
    <Box data-chat-diagram="" sx={{ my: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box sx={{ overflowX: 'auto', bgcolor: '#ffffff', borderRadius: '12px', p: 2 }}>
        <Box
          component="img"
          src={svgDataUrl(data.svg)}
          width={data.width}
          height={data.height}
          alt={chatDiagramText.alt}
          sx={{ display: 'block', maxWidth: '100%', height: 'auto', mx: 'auto' }}
        />
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <Button size="small" onClick={() => setShowText((shown) => !shown)}>
          {showText ? chatDiagramText.hideText : chatDiagramText.showText}
        </Button>
        <Button
          size="small"
          onClick={() => downloadBlob(name, new Blob([data.svg], { type: 'image/svg+xml' }))}
        >
          {chatDiagramText.svg}
        </Button>
        <Button
          size="small"
          onClick={async () => {
            const png = await svgToPng(data.svg, data.width, data.height)
            if (png) downloadBlob(pictureFileName(chatDiagramText.fileName, 'png'), png)
          }}
        >
          {chatDiagramText.png}
        </Button>
      </Box>
      {showText && code}
    </Box>
  )
}
