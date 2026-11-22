'use client'

import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Typography from '@mui/material/Typography'
import { artifactRefusalTexts, artifactRoleAtLeast } from '@repo/domain/artifacts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { artifactErrorData } from './artifact-access-error'
import type { CabinetArtifact } from './use-artifact'

export const moveTexts = Object.freeze({
  open: 'Перенести в проект…',
  title: 'Перенести в проект',
  personal: 'Личный — без проекта',
  hint: 'Артефакт проекта видят чаты проекта. Личный — только чаты, где он создан или прикреплён.',
  noProjects: 'Проектов пока нет.',
  save: 'Перенести',
  cancel: 'Отмена',
  failed: 'Не удалось перенести артефакт. Попробуйте ещё раз.',
})

const PERSONAL = 'personal'

/**
 * «Перенести в проект…» and «Сделать личным» (docs/plan/88-artifacts.md, Ар42): only the owner;
 * the projects are the owner's live ones out of «Архив» — the server checks them again.
 */
export function ArtifactMoveButton({
  artifact,
  onChanged,
}: {
  artifact: CabinetArtifact
  onChanged: () => void
}) {
  const trpc = useTRPC()
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<string>(artifact.project?.id ?? PERSONAL)
  const [error, setError] = useState<string | null>(null)
  const labelId = useId()
  const projects = useQuery({ ...trpc.project.list.queryOptions(), enabled: open })
  const move = useMutation(trpc.artifact.move.mutationOptions())
  if (!artifactRoleAtLeast(artifact.role, 'owner')) return null
  const shown = (projects.data?.items ?? []).filter((project) => !project.archived)

  const close = () => {
    if (move.isPending) return
    setOpen(false)
    setError(null)
  }
  async function save() {
    setError(null)
    try {
      await move.mutateAsync({
        artifactId: artifact.id,
        projectId: choice === PERSONAL ? null : choice,
      })
      setOpen(false)
      onChanged()
    } catch (failure) {
      const code = artifactErrorData(failure)?.domainCode
      setError(
        code === 'ARTIFACT_PROJECT_UNAVAILABLE' ? artifactRefusalTexts[code] : moveTexts.failed,
      )
    }
  }

  return (
    <>
      <Button
        variant="text"
        color="inherit"
        startIcon={<AppIcon name="layers" size={16} />}
        aria-haspopup="dialog"
        onClick={() => {
          setChoice(artifact.project?.id ?? PERSONAL)
          setOpen(true)
        }}
      >
        {moveTexts.open}
      </Button>
      <Dialog open={open} onClose={close} fullWidth maxWidth="xs" aria-labelledby={labelId}>
        <DialogTitle id={labelId}>{moveTexts.title}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {moveTexts.hint}
          </Typography>
          <RadioGroup
            aria-labelledby={labelId}
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
          >
            <FormControlLabel value={PERSONAL} control={<Radio />} label={moveTexts.personal} />
            {shown.map((project) => (
              <FormControlLabel
                key={project.id}
                value={project.id}
                control={<Radio />}
                label={project.name}
              />
            ))}
          </RadioGroup>
          {projects.isSuccess && shown.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              {moveTexts.noProjects}
            </Typography>
          )}
          {error && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={close} disabled={move.isPending}>
            {moveTexts.cancel}
          </Button>
          <Button
            variant="contained"
            onClick={() => void save()}
            disabled={move.isPending || choice === (artifact.project?.id ?? PERSONAL)}
          >
            {moveTexts.save}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
