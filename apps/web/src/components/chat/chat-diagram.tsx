'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import type { ChatDiagramJob } from '@repo/domain'
import { diagramErrorRu } from '@repo/domain/artifacts'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { DiagramDrawing, DiagramImage, DiagramText } from '@/components/diagram/diagram-picture'
import { useTRPC } from '@/trpc/client'

import { chatDiagramText } from './chat-texts'
import { CodeBlock } from './code-block'

// A diagram in an answer of the agent (docs/plan/91-chat-diagrams.md, Д1): the picture the server
// drew of the text — Mermaid or PlantUML in the render pool, an SVG cleaned by DOMPurify, shown as
// `<img>`; no engine runs in the cabinet. The chat names the row and the place of the diagram, the
// server reads its text. While it draws — «Рисуем схему…»; a text that did not parse shows its
// line and the text; a diagram the server cannot find, or one drawn too long, stays code.

/**
 * How often the chat asks again while core draws: every 1.5 s for the first minute, then every 30 s
 * for half an hour — the server puts the job again after its window, so a diagram the worker could
 * not draw then is drawn when it is back, and its picture replaces the text. Then it stops until
 * the chat is opened again.
 */
const DRAWING_POLL_MS = 1500
const DRAWING_POLLS = 40
const SLOW_POLL_MS = 30_000
const SLOW_POLLS = 60

/** The wait before the next ask after `polls` answers of «drawing»; false — no more asks. */
function pollDelay(polls: number): number | false {
  if (polls < DRAWING_POLLS) return DRAWING_POLL_MS
  if (polls < DRAWING_POLLS + SLOW_POLLS) return SLOW_POLL_MS
  return false
}

export function ChatDiagram({
  place,
  language,
  text,
}: {
  place: ChatDiagramJob
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
      query.state.data?.state === 'drawing' ? pollDelay(query.state.dataUpdateCount) : false,
  })
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
      <Box sx={{ my: 1.5 }}>
        <DiagramDrawing />
      </Box>
    )
  }
  if (data.state === 'failed')
    return (
      <Box sx={{ my: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Alert severity="warning">{diagramErrorRu(data.line)}</Alert>
        <DiagramText text={text.replace(/\n$/, '')} line={data.line} />
      </Box>
    )
  return (
    <Box data-chat-diagram="" sx={{ my: 1.5 }}>
      <DiagramImage
        svg={data.svg}
        width={data.width}
        height={data.height}
        alt={chatDiagramText.alt}
        fileTitle={chatDiagramText.fileName}
        text={text.replace(/\n$/, '')}
      />
    </Box>
  )
}
