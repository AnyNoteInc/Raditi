'use client'

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'

import type { CabinetArtifact } from '../use-artifact'
import { frameTexts } from './frame-texts'

/** «Код» of a screen (§7.7): its parts to read, never to edit here — that is the agent's work. */
export function FrameCode({
  artifact,
  frame,
}: {
  artifact: CabinetArtifact
  /** The frame block: its own parts and the common ones at the top (slice 88.15). */
  frame: string
}) {
  const groups = [
    { kind: 'html', label: frameTexts.codeHtml },
    { kind: 'style', label: frameTexts.codeStyle },
    { kind: 'script', label: frameTexts.codeScript },
    { kind: 'settings', label: frameTexts.codeSettings },
  ]
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, p: 1 }}>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {frameTexts.codeReadOnly}
      </Typography>
      {groups.map((group) => {
        const blocks = artifact.blocks.filter(
          (block) =>
            block.kind === group.kind &&
            block.content &&
            (block.parent === null || block.parent === frame),
        )
        if (blocks.length === 0) return null
        return (
          <Box key={group.kind} component="section" aria-label={group.label}>
            <Typography component="h3" sx={{ fontSize: 14, fontWeight: 650, mb: 0.5 }}>
              {group.label}
            </Typography>
            {blocks.map((block) => (
              <Box
                key={block.key}
                component="pre"
                tabIndex={0}
                sx={{
                  m: 0,
                  mb: 1,
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
                {block.content}
              </Box>
            ))}
          </Box>
        )
      })}
    </Box>
  )
}
