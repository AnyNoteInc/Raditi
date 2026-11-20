'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import {
  artifactKindCreatable,
  artifactKinds,
  artifactKindSpecs,
  artifactTemplates,
  type ArtifactKind,
  type ArtifactTemplate,
} from '@repo/domain/artifacts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'

import { keepChatDraft } from '@/components/chat/chat-draft'
import { useTRPC } from '@/trpc/client'

import { ArtifactKindIcon } from './artifact-kind-icon'
import { createTexts } from './artifact-texts'

/** The kinds of the window in the order of the board A-create: what ships first, then «Скоро». */
const order: readonly ArtifactKind[] = [
  'document',
  'canvas',
  'mockup',
  'table',
  'diagram',
  'slides',
  'image',
  'brand',
]

type Start = 'empty' | 'template' | 'agent'

const NEW_CHAT = '/chats/new'

/**
 * «Новый артефакт» (docs/plan/88-artifacts.md, Ар50, board A-create): the kind — those whose view
 * has not shipped are shown and marked «Скоро» —, the title, where it is kept (a project or none)
 * and how it starts: empty, from a template of the kind, or by the agent in a new chat — then the
 * request goes into the draft of the new chat, not sent by itself.
 */
export function ArtifactCreateDialog({
  open,
  userId,
  template: initial = null,
  onClose,
}: {
  open: boolean
  userId: string
  /** A template chosen on the empty screen: the window opens on it. */
  template?: ArtifactTemplate | null
  onClose: () => void
}) {
  const trpc = useTRPC()
  const router = useRouter()
  const formId = useId()
  const [kind, setKind] = useState<ArtifactKind>(initial?.kind ?? 'document')
  const [title, setTitle] = useState(initial?.title ?? '')
  const [projectId, setProjectId] = useState<string>('')
  const [start, setStart] = useState<Start>(initial ? 'template' : 'empty')
  const [templateId, setTemplateId] = useState<string>(initial?.id ?? '')
  const [request, setRequest] = useState('')
  const [touched, setTouched] = useState(false)
  const projects = useQuery({ ...trpc.project.list.queryOptions(), enabled: open })
  const create = useMutation(trpc.artifact.create.mutationOptions())
  const templates = artifactTemplates.filter((each) => each.kind === kind)
  const named = title.trim().length > 0
  const shownProjects = (projects.data?.items ?? []).filter((project) => !project.archived)

  async function submit() {
    setTouched(true)
    if (start === 'agent') {
      const what = request.trim()
      if (what === '') return
      const words = named ? `${artifactKindSpecs[kind].label} «${title.trim()}»: ${what}` : what
      keepChatDraft(userId, words)
      router.push(projectId ? `${NEW_CHAT}?project=${projectId}` : NEW_CHAT)
      onClose()
      return
    }
    if (!named) return
    const created = await create.mutateAsync({
      kind,
      title: title.trim(),
      projectId: projectId || null,
      templateId: start === 'template' && templateId ? templateId : null,
    })
    router.push(`/artifacts/${created.id}`)
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby={`${formId}-t`}>
      <DialogTitle id={`${formId}-t`}>{createTexts.title}</DialogTitle>
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
          <Box component="fieldset" sx={{ border: 0, m: 0, p: 0 }}>
            <Typography component="legend" variant="subtitle2" sx={{ mb: 1 }}>
              {createTexts.kind}
            </Typography>
            <Box
              role="radiogroup"
              aria-label={createTexts.kind}
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                gap: 1,
              }}
            >
              {order
                .filter((each) => artifactKinds.includes(each))
                .map((each) => {
                  const ready = artifactKindCreatable(each)
                  const chosen = kind === each
                  return (
                    <ButtonBase
                      key={each}
                      role="radio"
                      aria-checked={chosen}
                      aria-disabled={!ready}
                      disabled={!ready}
                      onClick={() => {
                        setKind(each)
                        setTemplateId('')
                      }}
                      sx={{
                        justifyContent: 'flex-start',
                        textAlign: 'left',
                        gap: 1.25,
                        px: 1.5,
                        py: 1.25,
                        minHeight: 56,
                        borderRadius: '12px',
                        border: 1,
                        borderColor: chosen ? 'primary.main' : 'divider',
                        bgcolor: chosen ? 'action.selected' : 'background.paper',
                        opacity: ready ? 1 : 0.6,
                      }}
                    >
                      <Box
                        sx={{ display: 'flex', color: chosen ? 'primary.main' : 'text.secondary' }}
                      >
                        <ArtifactKindIcon kind={each} size={20} />
                      </Box>
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Typography sx={{ fontWeight: 600, fontSize: 14 }}>
                          {artifactKindSpecs[each].label}
                        </Typography>
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                          {createTexts.kindHints[each] ?? ''}
                        </Typography>
                      </Box>
                      {!ready && (
                        <Typography
                          variant="caption"
                          sx={{
                            px: 1,
                            borderRadius: 999,
                            bgcolor: 'action.hover',
                            color: 'text.secondary',
                          }}
                        >
                          {createTexts.soon}
                        </Typography>
                      )}
                    </ButtonBase>
                  )
                })}
            </Box>
          </Box>

          <TextField
            label={createTexts.name}
            placeholder={createTexts.namePlaceholder}
            value={title}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
            error={touched && !named && start !== 'agent'}
            helperText={touched && !named && start !== 'agent' ? createTexts.nameRequired : ' '}
            slotProps={{ htmlInput: { maxLength: 200 } }}
          />

          <TextField
            select
            label={createTexts.place}
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <MenuItem value="">{createTexts.personal}</MenuItem>
            {shownProjects.map((project) => (
              <MenuItem key={project.id} value={project.id}>
                {project.name}
              </MenuItem>
            ))}
          </TextField>

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }} id={`${formId}-start`}>
              {createTexts.start}
            </Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={start}
              aria-labelledby={`${formId}-start`}
              onChange={(_, value: Start | null) => {
                if (value) setStart(value)
              }}
              sx={{ flexWrap: 'wrap' }}
            >
              <ToggleButton value="empty">{createTexts.empty}</ToggleButton>
              <ToggleButton value="template" disabled={templates.length === 0}>
                {createTexts.fromTemplate}
              </ToggleButton>
              <ToggleButton value="agent">{createTexts.askAgent}</ToggleButton>
            </ToggleButtonGroup>
          </Box>

          {start === 'template' && (
            <TextField
              select
              label={createTexts.template}
              value={templateId}
              onChange={(event) => {
                setTemplateId(event.target.value)
                const chosen = templates.find((each) => each.id === event.target.value)
                if (chosen && !named) setTitle(chosen.title)
              }}
            >
              {templates.map((each) => (
                <MenuItem key={each.id} value={each.id}>
                  {each.title}
                </MenuItem>
              ))}
            </TextField>
          )}

          {start === 'agent' && (
            <TextField
              label={createTexts.whatToDo}
              placeholder={createTexts.askPlaceholder}
              multiline
              minRows={3}
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              helperText={createTexts.askNote}
            />
          )}

          {create.isError && <Alert severity="error">{createTexts.failed}</Alert>}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose}>{createTexts.cancel}</Button>
        <Button
          type="submit"
          form={formId}
          variant="contained"
          disabled={create.isPending || (start === 'agent' && request.trim() === '')}
        >
          {createTexts.submit}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
