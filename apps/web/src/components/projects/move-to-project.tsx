'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Dialog from '@mui/material/Dialog'
import Typography from '@mui/material/Typography'
import { useId, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { useProjectChoices } from './project-picker'
import { moveText } from './project-texts'
import { useMoveToProject } from './use-move-to-project'

/**
 * The window of «Перенести в проект…»: the projects of «Все», the one the chat is in marked; a
 * press moves the chat there. A refusal stays in the window.
 */
export function MoveToProjectDialog({
  taskId,
  title,
  currentProjectId,
  open,
  onClose,
  onMoved,
}: {
  taskId: string
  /** The name of the chat. */
  title: string
  currentProjectId: string | null
  open: boolean
  onClose: () => void
  onMoved?: () => void
}) {
  const titleId = useId()
  const { choices, loaded } = useProjectChoices(open)
  const move = useMoveToProject()
  const [error, setError] = useState<string | null>(null)

  async function choose(projectId: string) {
    setError(null)
    const refused = await move.to(taskId, projectId)
    if (refused !== null) {
      setError(refused)
      return
    }
    onClose()
    onMoved?.()
  }

  return (
    <Dialog
      open={open}
      onClose={move.busy ? undefined : onClose}
      aria-labelledby={titleId}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: '100%',
            maxWidth: 480,
            m: 2,
            p: 3,
            border: 1,
            borderColor: 'divider',
            borderRadius: '14px',
          },
        },
      }}
    >
      <Typography
        component="h2"
        id={titleId}
        sx={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3, overflowWrap: 'anywhere' }}
      >
        {moveText.title}
      </Typography>
      <Typography sx={{ mt: 1, color: 'text.secondary', overflowWrap: 'anywhere' }}>
        «{title}». {moveText.lead}
      </Typography>
      {loaded && choices.length === 0 ? (
        <Typography sx={{ mt: 2 }}>{moveText.noProjects}</Typography>
      ) : (
        <Box
          component="ul"
          aria-label={moveText.title}
          sx={{ listStyle: 'none', m: 0, mt: 2, p: 0, display: 'grid', gap: 0.5 }}
        >
          {choices.map((project) => {
            const current = project.id === currentProjectId
            return (
              <li key={project.id}>
                <ButtonBase
                  disabled={current || move.busy}
                  onClick={() => void choose(project.id)}
                  sx={{
                    width: '100%',
                    minHeight: 44,
                    display: 'flex',
                    justifyContent: 'flex-start',
                    gap: 1.5,
                    px: 1.5,
                    py: 1,
                    borderRadius: '10px',
                    textAlign: 'left',
                    fontSize: 15,
                    '&:hover': { bgcolor: 'action.hover' },
                    '&.Mui-disabled': { color: 'text.secondary' },
                    '&.Mui-focusVisible': {
                      outline: '2px solid',
                      outlineColor: 'primary.main',
                    },
                  }}
                >
                  <AppIcon name="projects" size={18} />
                  <Box component="span" sx={{ flex: '1 1 auto', overflowWrap: 'anywhere' }}>
                    {project.name}
                  </Box>
                  {current ? (
                    <Typography component="span" variant="caption" color="text.secondary">
                      {moveText.current}
                    </Typography>
                  ) : null}
                </ButtonBase>
              </li>
            )
          })}
        </Box>
      )}
      {error ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      ) : null}
      <Box sx={{ mt: 3, display: 'flex', justifyContent: 'flex-end' }}>
        <Button onClick={onClose} disabled={move.busy} sx={{ minHeight: 44 }}>
          {moveText.cancel}
        </Button>
      </Box>
    </Dialog>
  )
}
