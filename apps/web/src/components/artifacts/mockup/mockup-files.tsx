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
import { useRef, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import type { CabinetArtifact } from '../use-artifact'
import { mockupTexts } from './mockup-texts'

const ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.avif,.svg,.woff2,.woff'

/** «Файлы» of a mockup (Ар12): its pictures and fonts, and «Загрузить файл» for an editor. */
export function MockupFilesButton({
  artifact,
  canEdit,
}: {
  artifact: CabinetArtifact
  canEdit: boolean
}) {
  const trpc = useTRPC()
  const [open, setOpen] = useState(false)
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
        throw new Error(body?.message ?? mockupTexts.uploadFailed)
      }
      setState('idle')
      await files.refetch()
    } catch (error) {
      setState('failed')
      setFailure(error instanceof Error ? error.message : mockupTexts.uploadFailed)
    }
  }

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        startIcon={<AppIcon name="image" size={16} />}
        onClick={() => setOpen(true)}
      >
        {mockupTexts.files}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        aria-labelledby="mockup-files-title"
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle id="mockup-files-title">{mockupTexts.filesTitle}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {mockupTexts.filesHint}
          </Typography>
          {(files.data ?? []).length === 0 && files.isSuccess && (
            <Typography variant="body2">{mockupTexts.filesEmpty}</Typography>
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
                <Tooltip title={copied === file.id ? mockupTexts.copied : mockupTexts.copyRef}>
                  <IconButton
                    aria-label={`${mockupTexts.copyRef}: ${file.name}`}
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
                aria-label={mockupTexts.upload}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) void upload(file)
                }}
              />
              <Button disabled={state === 'uploading'} onClick={() => input.current?.click()}>
                {state === 'uploading' ? mockupTexts.uploading : mockupTexts.upload}
              </Button>
            </>
          )}
          <Button onClick={() => setOpen(false)}>{mockupTexts.close}</Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
