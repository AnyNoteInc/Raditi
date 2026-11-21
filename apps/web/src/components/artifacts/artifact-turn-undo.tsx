'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { useTRPC } from '@/trpc/client'

import { historyTexts } from './artifact-history'

// `/undo` of a turn that changed artifacts (docs/plan/88-artifacts.md, Ар13): the conversation goes
// back, the edits in the artifacts stay — the row says so and offers «Отменить правки этого хода»
// for each; what changed since is left as it is.

export const turnUndoTexts = Object.freeze({
  stayed: (title: string) => `Правки в артефакте «${title}» остались.`,
})

export function ArtifactTurnUndo({ taskId, turn }: { taskId: string; turn: number }) {
  const trpc = useTRPC()
  const changed = useQuery(trpc.artifact.turnArtifacts.queryOptions({ taskId, turnNo: turn }))
  const undo = useMutation(trpc.artifact.undoTurn.mutationOptions())
  const [done, setDone] = useState<Record<string, string>>({})
  if (!changed.data || changed.data.length === 0) return null
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mt: 0.75 }}>
      {changed.data.map((artifact) => (
        <Box
          key={artifact.id}
          sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}
        >
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {done[artifact.id] ?? turnUndoTexts.stayed(artifact.title)}
          </Typography>
          {done[artifact.id] === undefined && (
            <Button
              size="small"
              disabled={undo.isPending}
              onClick={() =>
                void undo
                  .mutateAsync({ artifactId: artifact.id, taskId, turnNo: turn })
                  .then((answer) =>
                    setDone((before) => ({
                      ...before,
                      [artifact.id]: historyTexts.undone(answer.undone, answer.kept),
                    })),
                  )
                  .catch(() =>
                    setDone((before) => ({ ...before, [artifact.id]: historyTexts.failed })),
                  )
              }
            >
              {historyTexts.undoTurn}
            </Button>
          )}
        </Box>
      ))}
    </Box>
  )
}
