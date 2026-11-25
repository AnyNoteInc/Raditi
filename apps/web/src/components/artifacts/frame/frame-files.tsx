'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import type { CabinetArtifact } from '../use-artifact'
import { frameTexts } from './frame-texts'

const ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.avif,.svg,.woff2,.woff'

/**
 * «Файлы» of an artifact (Ар12): its pictures and fonts, and «Загрузить файл» for an editor. Opened
 * from a menu «⋯» of a screen or of a canvas, so the dialog alone, its opener is the host's.
 */
export function FrameFilesDialog({
  artifact,
  canEdit,
  open,
  onClose,
}: {
  artifact: CabinetArtifact
  canEdit: boolean
  open: boolean
  onClose: () => void
}) {
  const trpc = useTRPC()
  const titleId = useId()
  const [state, setState] = useState<'idle' | 'uploading' | 'failed'>('idle')
  const [failure, setFailure] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const files = useQuery({
    ...trpc.artifact.files.queryOptions({ artifactId: artifact.id }),
    enabled: open,
  })
  const start = useMutation(trpc.artifact.fileStart.mutationOptions())

  async function upload(file: File) {
    setState('uploading')
    setFailure(null)
    try {
      const target = await start.mutateAsync({
        artifactId: artifact.id,
        name: file.name,
        sizeBytes: file.size,
      })
      const response = await fetch(target.uploadUrl, { method: 'PUT', body: file })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null
        throw new Error(body?.message ?? frameTexts.uploadFailed)
      }
      setState('idle')
      await files.refetch()
    } catch (error) {
      setState('failed')
      setFailure(error instanceof Error ? error.message : frameTexts.uploadFailed)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} aria-labelledby={titleId} fullWidth maxWidth="sm">
      <DialogTitle id={titleId}>{frameTexts.filesTitle}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {frameTexts.filesHint}
        </Typography>
        {(files.data ?? []).length === 0 && files.isSuccess && (
          <Typography variant="body2">{frameTexts.filesEmpty}</Typography>
        )}
        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {(files.data ?? []).map((file) => (
            <Box
              component="li"
              key={file.id}
              sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5 }}
            >
              <AppIcon name={file.type.startsWith('font/') ? 'text' : 'image'} size={16} />
              <Typography
                sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
              >
                {file.name}
              </Typography>
              <Tooltip title={copied === file.id ? frameTexts.copied : frameTexts.copyRef}>
                <IconButton
                  aria-label={`${frameTexts.copyRef}: ${file.name}`}
                  onClick={() =>
                    void navigator.clipboard.writeText(file.ref).then(() => setCopied(file.id))
                  }
                >
                  <AppIcon name="copy" size={16} />
                </IconButton>
              </Tooltip>
            </Box>
          ))}
        </Box>
        {failure && <Alert severity="error">{failure}</Alert>}
      </DialogContent>
      <DialogActions>
        {canEdit && (
          <>
            <input
              ref={input}
              type="file"
              accept={ACCEPT}
              hidden
              aria-label={frameTexts.upload}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void upload(file)
              }}
            />
            <Button disabled={state === 'uploading'} onClick={() => input.current?.click()}>
              {state === 'uploading' ? frameTexts.uploading : frameTexts.upload}
            </Button>
          </>
        )}
        <Button onClick={onClose}>{frameTexts.close}</Button>
      </DialogActions>
    </Dialog>
  )
}
