'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import NextLink from 'next/link'
import { useId, useState } from 'react'

import { useTRPC } from '@/trpc/client'

/** As `scheduledTaskArtifactLimit` of the server. */
export const SCHEDULE_ARTIFACTS_MAX = 10

export const scheduleArtifactTexts = Object.freeze({
  none: 'Не выбраны: без вас задача меняет только ваши личные артефакты.',
  change: 'Выбрать',
  title: 'Артефакты задачи',
  hint: 'Задача сможет менять их, пока вас нет. Удалять и публиковать — только с вами.',
  empty: 'Подходящих артефактов нет: личных или из проекта задачи.',
  max: `Не больше ${SCHEDULE_ARTIFACTS_MAX}.`,
  save: 'Сохранить',
  cancel: 'Отмена',
  failed: 'Не удалось сохранить. Попробуйте ещё раз.',
})

/**
 * «Артефакты задачи» of the page of a scheduled task (docs/plan/88-artifacts.md, Ар24, slice
 * 88.20б): what a run without the client may change beside the client's own artifacts without a
 * project — the owner's, personal or of the task's project. Only here, never by `schedule_*`.
 */
export function ScheduleArtifacts({
  scheduleId,
  projectId,
}: {
  scheduleId: string
  projectId: string | null
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const named = useQuery(trpc.schedule.artifacts.queryOptions({ scheduleId }))
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<string[]>([])
  const [error, setError] = useState(false)
  const titleId = useId()
  const candidates = useQuery({
    ...trpc.artifact.list.queryOptions({ filter: 'all', sort: 'newest' }),
    enabled: open,
  })
  const save = useMutation(trpc.schedule.setArtifacts.mutationOptions())
  const shown = (candidates.data ?? []).filter(
    (artifact) => artifact.project === null || artifact.project.id === projectId,
  )
  const rows = named.data ?? []

  async function submit() {
    setError(false)
    try {
      await save.mutateAsync({ scheduleId, artifactIds: chosen })
      await queryClient.invalidateQueries({
        queryKey: trpc.schedule.artifacts.queryKey({ scheduleId }),
      })
      setOpen(false)
    } catch {
      setError(true)
    }
  }

  return (
    <Box sx={{ display: 'grid', gap: 0.75 }}>
      {named.isPending ? null : rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {scheduleArtifactTexts.none}
        </Typography>
      ) : (
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
          {rows.map((artifact) => (
            <li key={artifact.id}>
              <Link component={NextLink} href={`/artifacts/${artifact.id}`} underline="hover">
                {artifact.title}
              </Link>
            </li>
          ))}
        </Box>
      )}
      <Box>
        <Button
          size="small"
          aria-haspopup="dialog"
          disabled={named.isPending}
          onClick={() => {
            setChosen(rows.map((artifact) => artifact.id))
            setOpen(true)
          }}
        >
          {scheduleArtifactTexts.change}
        </Button>
      </Box>
      <Dialog
        open={open}
        onClose={() => !save.isPending && setOpen(false)}
        aria-labelledby={titleId}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle id={titleId}>{scheduleArtifactTexts.title}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {scheduleArtifactTexts.hint}
          </Typography>
          {candidates.isSuccess && shown.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              {scheduleArtifactTexts.empty}
            </Typography>
          )}
          <Box sx={{ display: 'grid' }}>
            {shown.map((artifact) => {
              const checked = chosen.includes(artifact.id)
              return (
                <FormControlLabel
                  key={artifact.id}
                  label={artifact.title}
                  control={
                    <Checkbox
                      checked={checked}
                      disabled={!checked && chosen.length >= SCHEDULE_ARTIFACTS_MAX}
                      onChange={() =>
                        setChosen((list) =>
                          checked
                            ? list.filter((id) => id !== artifact.id)
                            : [...list, artifact.id],
                        )
                      }
                    />
                  }
                />
              )
            })}
          </Box>
          {chosen.length >= SCHEDULE_ARTIFACTS_MAX && (
            <Typography variant="caption" color="text.secondary">
              {scheduleArtifactTexts.max}
            </Typography>
          )}
          {error && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {scheduleArtifactTexts.failed}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)} disabled={save.isPending}>
            {scheduleArtifactTexts.cancel}
          </Button>
          <Button variant="contained" onClick={() => void submit()} disabled={save.isPending}>
            {scheduleArtifactTexts.save}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
