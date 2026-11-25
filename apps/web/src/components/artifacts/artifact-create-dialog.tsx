'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { artifactKinds, artifactKindSpecs, type ArtifactKind } from '@repo/domain/artifacts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { keepChatDraft } from '@/components/chat/chat-draft'
import { useTRPC } from '@/trpc/client'

import { ArtifactKindIcon } from './artifact-kind-icon'
import { createTexts } from './artifact-texts'

/** How the artifact starts: the agent makes it from a request, or the user opens an empty one. */
type Start = 'agent' | 'empty'

const NEW_CHAT = '/chats/new'

/**
 * «Новый артефакт» (docs/plan/93-artifacts-trim.md, АТ9): one of the four kinds, then one request
 * «Что сделать?» for the agent — it goes into the draft of a new chat, never sent by itself.
 * «Создать пустой» asks only for a name. «Где хранить» stands only when the user has projects.
 * Templates live on the empty screen of the gallery, not here.
 */
export function ArtifactCreateDialog({
  open,
  userId,
  projectId: initialProjectId = '',
  onClose,
}: {
  open: boolean
  userId: string
  /** The project the gallery shows: the new artifact is kept there unless the user chooses. */
  projectId?: string
  onClose: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  const formId = useId()
  const [kind, setKind] = useState<ArtifactKind>('document')
  const [start, setStart] = useState<Start>('agent')
  const [title, setTitle] = useState('')
  const [request, setRequest] = useState('')
  const [projectId, setProjectId] = useState<string>(initialProjectId)
  const [touched, setTouched] = useState(false)
  const projects = useQuery({ ...trpc.project.list.queryOptions(), enabled: open })
  const create = useMutation(trpc.artifact.create.mutationOptions())
  const shownProjects = (projects.data?.items ?? []).filter((project) => !project.archived)
  const named = title.trim().length > 0
  const asked = request.trim().length > 0

  async function submit() {
    setTouched(true)
    if (start === 'agent') {
      if (!asked) return
      keepChatDraft(userId, createTexts.draft(artifactKindSpecs[kind].label, request.trim()))
      router.push(projectId ? `${NEW_CHAT}?project=${projectId}` : NEW_CHAT)
      onClose()
      return
    }
    if (!named) return
    const created = await create.mutateAsync({
      kind,
      title: title.trim(),
      projectId: projectId || null,
      templateId: null,
    })
    // The gallery reads itself again: the new one is in it on the way back.
    void queryClient.invalidateQueries({ queryKey: trpc.artifact.list.pathKey() })
    router.push(`/artifacts/${created.id}`)
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby={`${formId}-t`}
      slotProps={{ paper: { sx: { borderRadius: { xs: '16px', sm: '20px' } } } }}
    >
      <DialogTitle
        id={`${formId}-t`}
        sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1.5, pb: 1 }}
      >
        <Box component="span" sx={{ flex: 1 }}>
          {createTexts.title}
        </Box>
        <Tooltip title={createTexts.close}>
          <IconButton aria-label={createTexts.close} onClick={onClose} size="small">
            <AppIcon name="close" size={18} />
          </IconButton>
        </Tooltip>
      </DialogTitle>
      <DialogContent>
        <Box
          component="form"
          id={formId}
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
          sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pt: 0.5 }}
        >
          <Box
            role="radiogroup"
            aria-label={createTexts.kind}
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(4, 1fr)' },
              gap: 1,
            }}
          >
            {artifactKinds.map((each) => {
              const chosen = kind === each
              return (
                <ButtonBase
                  key={each}
                  role="radio"
                  aria-checked={chosen}
                  onClick={() => setKind(each)}
                  sx={{
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    justifyContent: 'flex-start',
                    textAlign: 'left',
                    gap: 0.5,
                    p: 1.25,
                    borderRadius: '12px',
                    border: 1,
                    borderColor: chosen ? 'primary.main' : 'divider',
                    bgcolor: chosen ? 'action.selected' : 'transparent',
                    transition: 'border-color 120ms ease, background-color 120ms ease',
                    '&:hover': { bgcolor: chosen ? 'action.selected' : 'action.hover' },
                    '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' },
                    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
                  }}
                >
                  <Box
                    aria-hidden
                    sx={{ display: 'flex', color: chosen ? 'primary.main' : 'text.secondary' }}
                  >
                    <ArtifactKindIcon kind={each} size={20} />
                  </Box>
                  <Typography component="span" sx={{ fontWeight: 600, fontSize: 14 }}>
                    {artifactKindSpecs[each].label}
                  </Typography>
                  <Typography
                    component="span"
                    variant="caption"
                    sx={{ color: 'text.secondary', lineHeight: 1.35 }}
                  >
                    {createTexts.kindHints[each]}
                  </Typography>
                </ButtonBase>
              )
            })}
          </Box>

          {start === 'agent' ? (
            <TextField
              label={createTexts.whatToDo}
              placeholder={createTexts.askPlaceholder[kind]}
              multiline
              minRows={3}
              autoFocus
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              onKeyDown={(event) => {
                // Ctrl/⌘+Enter asks the agent, as in the chat.
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void submit()
                }
              }}
              helperText={createTexts.askNote}
              slotProps={{ htmlInput: { maxLength: 4000 } }}
            />
          ) : (
            <TextField
              label={createTexts.name}
              placeholder={createTexts.namePlaceholder}
              value={title}
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
              error={touched && !named}
              helperText={touched && !named ? createTexts.nameRequired : ' '}
              slotProps={{ htmlInput: { maxLength: 200 } }}
            />
          )}

          {shownProjects.length > 0 && (
            <TextField
              select
              size="small"
              label={createTexts.place}
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              sx={{ maxWidth: { sm: 280 } }}
            >
              <MenuItem value="">{createTexts.personal}</MenuItem>
              {shownProjects.map((project) => (
                <MenuItem key={project.id} value={project.id}>
                  {project.name}
                </MenuItem>
              ))}
            </TextField>
          )}

          {create.isError && <Alert severity="error">{createTexts.failed}</Alert>}
        </Box>
      </DialogContent>
      <DialogActions
        sx={{ px: 3, pb: 2.5, pt: 0, justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}
      >
        <Button
          variant="text"
          onClick={() => {
            setTouched(false)
            setStart(start === 'agent' ? 'empty' : 'agent')
          }}
          sx={{ ml: -1 }}
        >
          {start === 'agent' ? createTexts.empty : createTexts.backToAgent}
        </Button>
        <Button
          type="submit"
          form={formId}
          variant="contained"
          disabled={create.isPending || (start === 'agent' && !asked)}
          sx={{ minHeight: 40, px: 2.5 }}
        >
          {start === 'agent' ? createTexts.askAgent : createTexts.submit}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
