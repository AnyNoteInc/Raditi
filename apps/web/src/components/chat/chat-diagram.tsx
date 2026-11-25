'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import type { ChatDiagramJob } from '@repo/domain'
import { diagramErrorRu } from '@repo/domain/artifacts'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import {
  DIAGRAM_FAST_POLLS,
  DiagramDrawing,
  DiagramImage,
  DiagramText,
  diagramPollDelay,
} from '@/components/diagram/diagram-picture'
import { useTRPC } from '@/trpc/client'

import { chatDiagramText } from './chat-texts'
import { CodeBlock } from './code-block'

// A diagram in an answer of the agent (docs/plan/91-chat-diagrams.md, Д1): the picture the server
// drew of the text — Mermaid or PlantUML in the render pool, an SVG cleaned by DOMPurify, shown as
// `<img>`; no engine runs in the cabinet. The chat names the row and the place of the diagram, the
// server reads its text. While it draws — «Рисуем схему…», after a minute its text until the
// picture comes (`diagramPollDelay`); a text that did not parse shows its line and the text; a
// diagram the server cannot find stays code.

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
      query.state.data?.state === 'drawing' ? diagramPollDelay(query.state.dataUpdateCount) : false,
  })
  const data = picture.data
  const code = <CodeBlock language={language} text={text} />

  if (picture.isError) return code
  if (!data || data.state === 'drawing') {
    const polls = queries.getQueryState(options.queryKey)?.dataUpdateCount ?? 0
    if (data && polls >= DIAGRAM_FAST_POLLS)
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
