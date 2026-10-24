'use client'

import { attachmentAcceptAttribute } from '@repo/domain/attachments/rules'
import { attachmentSizeText, attachmentTypeLabel } from '@repo/domain/attachments/labels'
import type { BrowserChooser, BrowserDialog } from '@repo/domain/browser/session'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Radio from '@mui/material/Radio'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { AttachmentChips } from './attachment-chips'
import { callErrorText } from './call-error'
import { browserText } from './chat-texts'
import type { TaskAttachment } from './chat-types'
import { useAttachments } from './use-attachments'

// What a page of the cloud browser asks while the client controls it (docs/plan/57-browser-
// tasks.md, Б27): a JavaScript dialog — answered in a window of Радити, the page's words apart
// from ours —, and a file chooser — filled from the files of the task, or a new one uploaded and
// kept with the task.

const dialogWords = browserText.dialog

/** A JavaScript dialog of the page; its id keys it, so a new one starts clean. */
export function PageDialog({
  dialog,
  onAnswer,
}: {
  dialog: BrowserDialog
  onAnswer: (accept: boolean, text?: string) => void
}) {
  const titleId = useId()
  const [text, setText] = useState(dialog.defaultValue ?? '')
  const leave = dialog.kind === 'beforeunload'
  const message =
    dialog.message.trim() !== '' ? dialog.message : leave ? dialogWords.leaveQuestion : ''
  // The safe answer — stay, cancel — is the default and what Escape gives.
  const cancel = () => onAnswer(dialog.kind === 'alert')
  return (
    <Dialog open onClose={cancel} aria-labelledby={titleId} fullWidth maxWidth="xs">
      <DialogTitle id={titleId}>{dialogWords.title}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {message !== '' ? (
          <Box
            component="blockquote"
            sx={{
              m: 0,
              px: 2,
              py: 1.25,
              borderLeft: 3,
              borderColor: 'divider',
              bgcolor: 'action.hover',
              borderRadius: '0 8px 8px 0',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {message}
          </Box>
        ) : null}
        {dialog.kind === 'prompt' ? (
          <TextField
            autoFocus
            label={dialogWords.answer}
            value={text}
            onChange={(event) => setText(event.target.value)}
            fullWidth
            slotProps={{ htmlInput: { maxLength: 1000 } }}
          />
        ) : null}
        <Typography variant="body2" color="text.secondary">
          {dialogWords.note}
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5, gap: 1, flexWrap: 'wrap' }}>
        {leave ? (
          <>
            <Button variant="outlined" onClick={() => onAnswer(true)}>
              {dialogWords.leave}
            </Button>
            <Button variant="contained" autoFocus onClick={() => onAnswer(false)}>
              {dialogWords.stay}
            </Button>
          </>
        ) : dialog.kind === 'alert' ? (
          <Button variant="contained" autoFocus onClick={() => onAnswer(true)}>
            {dialogWords.ok}
          </Button>
        ) : (
          <>
            <Button variant="outlined" onClick={() => onAnswer(false)}>
              {dialogWords.cancel}
            </Button>
            <Button
              variant="contained"
              autoFocus={dialog.kind !== 'prompt'}
              onClick={() => onAnswer(true, dialog.kind === 'prompt' ? text : undefined)}
            >
              {dialogWords.ok}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  )
}

/**
 * Whether a file fits the `accept` of the page's input: `image/*`, `application/pdf`, `.pdf`.
 * An empty list takes any file.
 */
export function acceptsFile(
  accept: readonly string[],
  file: { name: string; type: string },
): boolean {
  if (accept.length === 0) return true
  const type = file.type.toLowerCase()
  const name = file.name.toLowerCase()
  return accept.some((raw) => {
    const entry = raw.trim().toLowerCase()
    if (entry.startsWith('.')) return name.endsWith(entry)
    if (entry.endsWith('/*')) return type.startsWith(entry.slice(0, -1))
    return entry === type
  })
}

const chooserWords = browserText.chooser

/** The file chooser of the page: files of the task, or a new one. */
export function FileChooserDialog({
  chooser,
  taskId,
  siteId,
  onAnswer,
}: {
  chooser: BrowserChooser
  taskId: string
  siteId: string
  onAnswer: (attachmentIds: string[]) => void
}) {
  const trpc = useTRPC()
  const titleId = useId()
  const files = useQuery(trpc.attachment.list.queryOptions({ taskId }))
  const bind = useMutation(trpc.attachment.bind.mutationOptions())
  const uploads = useAttachments(siteId)
  const input = useRef<HTMLInputElement>(null)
  const [chosen, setChosen] = useState<readonly string[]>([])
  const [error, setError] = useState<string | null>(null)

  const listed: readonly TaskAttachment[] = files.data ?? []
  const fits = (file: { name: string; type: string }) => acceptsFile(chooser.accept, file)
  const fresh = uploads.readyIds
  const total = chosen.length + fresh.length
  const tooMany = !chooser.multiple && total > 1
  const canSend = total > 0 && !uploads.uploading && !tooMany && !bind.isPending

  function toggle(id: string) {
    setError(null)
    setChosen((previous) =>
      chooser.multiple
        ? previous.includes(id)
          ? previous.filter((known) => known !== id)
          : [...previous, id]
        : [id],
    )
  }

  async function send() {
    if (!canSend) return
    setError(null)
    try {
      // A file uploaded here belongs to the task before the page may get it.
      if (fresh.length > 0) await bind.mutateAsync({ taskId, attachmentIds: [...fresh] })
      onAnswer([...chosen, ...fresh])
    } catch (failure) {
      setError(callErrorText(failure))
    }
  }

  return (
    <Dialog open onClose={() => onAnswer([])} aria-labelledby={titleId} fullWidth maxWidth="sm">
      <DialogTitle id={titleId}>{chooserWords.title}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Typography color="text.secondary">{chooserWords.note}</Typography>
        <Typography component="h3" sx={{ fontSize: 15, fontWeight: 600 }}>
          {chooserWords.files}
        </Typography>
        {files.isPending ? (
          <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CircularProgress size={16} aria-hidden="true" />
            <Typography variant="body2">{chooserWords.loading}</Typography>
          </Box>
        ) : files.isError ? (
          <Typography role="alert" variant="body2" color="error.main">
            {chooserWords.loadFailed}
          </Typography>
        ) : listed.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {chooserWords.none}
          </Typography>
        ) : (
          <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 0.5 }}>
            {listed.map((file) => {
              const allowed = fits(file)
              const checked = chosen.includes(file.id)
              const Control = chooser.multiple ? Checkbox : Radio
              return (
                <Box component="li" key={file.id}>
                  <Box
                    component="label"
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1,
                      minHeight: 48,
                      px: 1,
                      borderRadius: '10px',
                      cursor: allowed ? 'pointer' : 'not-allowed',
                      color: allowed ? 'text.primary' : 'text.disabled',
                      '&:hover': { bgcolor: allowed ? 'action.hover' : undefined },
                    }}
                  >
                    <Control
                      checked={checked}
                      disabled={!allowed}
                      onChange={() => toggle(file.id)}
                      slotProps={{ input: { 'aria-label': file.name } }}
                    />
                    <AppIcon name={file.kind === 'image' ? 'image' : 'file'} size={20} />
                    <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <Box
                        component="span"
                        sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {file.name}
                      </Box>
                      <Box component="span" sx={{ fontSize: 13, color: 'text.secondary' }}>
                        {chooserWords.meta(
                          attachmentTypeLabel(file.type),
                          attachmentSizeText(file.size),
                        )}
                      </Box>
                    </Box>
                  </Box>
                </Box>
              )
            })}
          </Box>
        )}
        <AttachmentChips items={uploads.items} onRetry={uploads.retry} onRemove={uploads.remove} />
        {uploads.notice ? (
          <Typography role="alert" variant="body2" color="error.main">
            {uploads.notice}
          </Typography>
        ) : null}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5 }}>
          <Button
            variant="outlined"
            startIcon={<AppIcon name="attach" size={18} />}
            onClick={() => input.current?.click()}
          >
            {chooserWords.upload}
          </Button>
          <Typography variant="body2" color="text.secondary">
            {chooserWords.newNote}
          </Typography>
          <input
            ref={input}
            type="file"
            hidden
            multiple={chooser.multiple}
            accept={attachmentAcceptAttribute}
            data-testid="chooser-files"
            onChange={(event) => {
              const picked = event.target.files
              if (picked && picked.length > 0) uploads.add(Array.from(picked))
              event.target.value = ''
            }}
          />
        </Box>
        {error ? (
          <Typography role="alert" variant="body2" color="error.main">
            {error}
          </Typography>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5, gap: 1 }}>
        <Button variant="outlined" onClick={() => onAnswer([])}>
          {chooserWords.cancel}
        </Button>
        <Button
          variant="contained"
          disabled={!canSend}
          loading={bind.isPending}
          onClick={() => void send()}
        >
          {chooserWords.confirm}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
