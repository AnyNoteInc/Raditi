'use client'

import { projectLimits } from '@repo/domain/projects'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState, type FormEvent } from 'react'

import { callErrorText } from '@/components/chat/call-error'
import { uuidv7 } from '@/components/chat/uuid'
import { useTRPC } from '@/trpc/client'

import { projectCreateText } from './project-texts'
import type { PickedProject } from './project-types'

/**
 * «Создание проекта» (docs/plan/84-projects.md, ПР5; P-create): «Над чем вы работаете?» — the name,
 * «Чего вы хотите достичь?» — the goal, and «Создать проект». 600px wide, the whole screen on a
 * phone. The id comes from the browser, so a repeat after a lost answer finds the same project.
 * The context of the board comes with slice 84.10: it is not here yet.
 */
export function ProjectCreateDialog({
  open,
  onClose,
  onCreated,
  initial,
}: {
  open: boolean
  onClose: () => void
  /** The server took it: the new project, to open or to choose. */
  onCreated: (project: PickedProject) => void
  /** «Начать с примера» fills the form. */
  initial?: { name: string; goal: string } | null
}) {
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'))
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={fullScreen}
      maxWidth={false}
      aria-labelledby="project-create-title"
      slotProps={{
        paper: {
          sx: {
            width: '100%',
            maxWidth: { sm: 600 },
            m: { sm: 2 },
            border: { sm: 1 },
            borderColor: { sm: 'divider' },
            borderRadius: { xs: 0, sm: '14px' },
          },
        },
      }}
    >
      {/* A new form for every opening: nothing of the last one stays. */}
      {open ? (
        <CreateForm onClose={onClose} onCreated={onCreated} initial={initial ?? null} />
      ) : null}
    </Dialog>
  )
}

function CreateForm({
  onClose,
  onCreated,
  initial,
}: {
  onClose: () => void
  onCreated: (project: PickedProject) => void
  initial: { name: string; goal: string } | null
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const create = useMutation(trpc.project.create.mutationOptions())
  const [name, setName] = useState(initial?.name ?? '')
  const [goal, setGoal] = useState(initial?.goal ?? '')
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  // One id per project being created, kept for the repeats of the same press.
  const pending = useRef<string | null>(null)
  const nameId = useId()

  async function submit(event: FormEvent) {
    event.preventDefault()
    const shownName = name.replace(/\s+/gu, ' ').trim()
    if (shownName === '') {
      setMissing(true)
      return
    }
    pending.current ??= uuidv7()
    setError(null)
    try {
      const created = await create.mutateAsync({
        projectId: pending.current,
        name: shownName,
        ...(goal.trim() === '' ? {} : { goal }),
      })
      pending.current = null
      void queryClient.invalidateQueries({ queryKey: trpc.project.pathKey() })
      onCreated({
        id: created.projectId,
        name: shownName,
        goal: goal.trim() === '' ? null : goal.trim(),
        hasInstructions: false,
      })
    } catch (failure) {
      setError(callErrorText(failure))
    }
  }

  return (
    <Box
      component="form"
      noValidate
      onSubmit={(event: FormEvent) => void submit(event)}
      sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, p: { xs: 2.5, sm: 3 } }}
    >
      <Typography
        id="project-create-title"
        component="h2"
        sx={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3 }}
      >
        {projectCreateText.title}
      </Typography>
      <TextField
        id={nameId}
        label={projectCreateText.name}
        placeholder={projectCreateText.namePlaceholder}
        value={name}
        required
        autoFocus
        error={missing}
        helperText={missing ? projectCreateText.nameRequired : undefined}
        onChange={(event) => {
          setName(event.target.value)
          setMissing(false)
        }}
        slotProps={{ htmlInput: { maxLength: projectLimits.nameChars } }}
      />
      <TextField
        label={projectCreateText.goal}
        placeholder={projectCreateText.goalPlaceholder}
        helperText={projectCreateText.goalHint}
        value={goal}
        multiline
        minRows={2}
        maxRows={6}
        onChange={(event) => setGoal(event.target.value)}
        slotProps={{ htmlInput: { maxLength: projectLimits.goalChars } }}
      />
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, flexWrap: 'wrap' }}>
        <Button onClick={onClose} disabled={create.isPending} sx={{ minHeight: 44 }}>
          {projectCreateText.cancel}
        </Button>
        <Button type="submit" variant="contained" loading={create.isPending} sx={{ minHeight: 44 }}>
          {projectCreateText.create}
        </Button>
      </Box>
    </Box>
  )
}
