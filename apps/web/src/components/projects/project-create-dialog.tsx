'use client'

import { projectLimits } from '@repo/domain/projects'
import { parseRepositoryLink, repoRefusalTexts } from '@repo/domain/repo'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { callErrorText } from '@/components/chat/call-error'
import { uuidv7 } from '@/components/chat/uuid'
import { useTRPC } from '@/trpc/client'

import { ContextAddMenu } from './context-add-menu'
import { ContextDropArea, ContextUploadChips } from './context-parts'
import { ContextTextDialog } from './context-text-dialog'
import { contextText, projectCreateText } from './project-texts'
import type { PickedProject } from './project-types'
import { LinkRefusal, RepoLinkDialog } from './project-repository'
import { repoText } from './repo-texts'
import { useContextUploads } from './use-context-uploads'

/**
 * «Создание проекта» (docs/plan/84-projects.md, ПР5; P-create): «Над чем вы работаете?» — the name,
 * «Чего вы хотите достичь?» — the goal, and «Создать проект». 600px wide, the whole screen on a
 * phone. The id comes from the browser, so a repeat after a lost answer finds the same project.
 * «Контекст» (84.10; P-create, P-create-menu): files dropped or chosen and texts are uploaded at
 * once, before the project exists, and `project.create({ fileIds })` takes them with the project in
 * one transaction. A window closed without a project removes the files it uploaded.
 */
export function ProjectCreateDialog({
  open,
  onClose,
  onCreated,
  initial,
}: {
  open: boolean
  onClose: () => void
  /**
   * The server took it: the new project, to open or to choose; `connectRepository` — «Подключить
   * GitLab» was chosen in the window (ПР5): the page opens «Подключить репозиторий».
   */
  onCreated: (project: PickedProject, then?: { connectRepository: boolean }) => void
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
  onCreated: (project: PickedProject, then?: { connectRepository: boolean }) => void
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
  const contextId = useId()
  const uploads = useContextUploads({ projectId: null })
  const [writing, setWriting] = useState(false)
  // «Ссылка на GitHub» is saved with the project; «Подключить GitLab» waits for it (ПР5).
  const [link, setLink] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)
  const [connectRepository, setConnectRepository] = useState(false)
  const discard = useRef(uploads.discardAll)
  useEffect(() => {
    discard.current = uploads.discardAll
  })
  // Closed without a project — by «Отмена», Escape or a press beside it: its files go too.
  useEffect(() => () => discard.current(), [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const shownName = name.replace(/\s+/gu, ' ').trim()
    if (shownName === '') {
      setMissing(true)
      return
    }
    if (uploads.uploading) {
      setError(contextText.waitUploads)
      return
    }
    pending.current ??= uuidv7()
    setError(null)
    try {
      const created = await create.mutateAsync({
        projectId: pending.current,
        name: shownName,
        ...(goal.trim() === '' ? {} : { goal }),
        ...(uploads.readyIds.length === 0 ? {} : { fileIds: [...uploads.readyIds] }),
        ...(link === null ? {} : { publicRepositoryUrl: link }),
      })
      pending.current = null
      uploads.keepAll()
      void queryClient.invalidateQueries({ queryKey: trpc.project.pathKey() })
      onCreated(
        {
          id: created.projectId,
          name: shownName,
          goal: goal.trim() === '' ? null : goal.trim(),
          hasInstructions: false,
        },
        { connectRepository: connectRepository && link === null },
      )
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
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1 }}>
          <Typography id={contextId} component="span" sx={{ fontSize: 14, fontWeight: 500 }}>
            {contextText.title}
          </Typography>
          <Typography component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
            {contextText.optional}
          </Typography>
        </Box>
        <ContextDropArea onFiles={uploads.add} labelledBy={contextId}>
          <ContextUploadChips
            uploads={uploads.items}
            onRetry={uploads.retry}
            onRemove={uploads.remove}
          />
          {link !== null || connectRepository ? (
            <Chip
              icon={<AppIcon name={link !== null ? 'github' : 'gitlab'} size={16} />}
              label={link ?? repoText.connectAfterCreate}
              onDelete={() => {
                setLink(null)
                setConnectRepository(false)
              }}
              sx={{ alignSelf: 'flex-start', maxWidth: '100%' }}
            />
          ) : null}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.75, flexWrap: 'wrap' }}>
            <ContextAddMenu
              variant="pill"
              onFiles={uploads.add}
              onText={() => setWriting(true)}
              onLink={() => setLinking(true)}
              onGitlab={() => setConnectRepository(true)}
              repositoryAttached={link !== null || connectRepository}
            />
            <Typography sx={{ flex: '1 1 200px', fontSize: 13, color: 'text.secondary' }}>
              {contextText.createHint}
            </Typography>
          </Box>
        </ContextDropArea>
      </Box>
      <ContextTextDialog open={writing} onClose={() => setWriting(false)} onAdd={uploads.addText} />
      <RepoLinkDialog
        open={linking}
        onClose={() => setLinking(false)}
        onAdd={async (url) => {
          // The server checks it with the project; here only that it reads as a repository.
          try {
            parseRepositoryLink(url)
          } catch {
            throw new LinkRefusal(repoRefusalTexts.REPO_LINK_INVALID)
          }
          setLink(url)
        }}
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
