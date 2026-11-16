'use client'

import { projectFileTypeByName } from '@repo/domain/projects'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import { useState, type DragEvent, type ReactNode } from 'react'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'
import { fileSizeText } from '@/components/chat/chat-format'

import { contextText } from './project-texts'
import { droppedFiles, type ChosenFile, type ContextUpload } from './use-context-uploads'

// The pieces «Контекст» draws in its three places — the window of a new project, the row of the
// page of a project and its window (docs/plan/84-projects.md, §4.8): the sign of a file, what it
// is and its size, the room taken, and the files on their way.

/** A text the client wrote is kept as «<название>.md»: the client reads its name without it. */
export const contextShownName = (name: string, kind: 'file' | 'text') =>
  kind === 'text' ? name.replace(/\.md$/u, '') : name

/** The sign of a file of the context: a picture, a text, or a sheet. */
export function contextIcon(name: string, kind: 'file' | 'text'): AppIconName {
  if (kind === 'text') return 'text'
  return projectFileTypeByName(name)?.kind === 'image' ? 'image' : 'file'
}

/** «XLSX · 84 КБ», «Текст · 4 КБ»: what the file is and how big. */
export function contextMeta(name: string, kind: 'file' | 'text', bytes: number): string {
  const extension = /\.([^./]+)$/u.exec(name)?.[1]
  const what =
    kind === 'text' || extension === undefined ? contextText.kindText : extension.toUpperCase()
  return `${what} · ${fileSizeText(bytes)}`
}

/** The square with the sign of a file. */
export function ContextTile({ icon, failed = false }: { icon: AppIconName; failed?: boolean }) {
  return (
    <Box
      aria-hidden="true"
      sx={{
        width: 40,
        height: 40,
        flex: 'none',
        borderRadius: '8px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: failed ? 'action.hover' : 'action.selected',
        color: failed ? 'error.main' : 'text.secondary',
      }}
    >
      <AppIcon name={failed ? 'warning' : icon} size={20} />
    </Box>
  )
}

/** «Занято 9 % места · 9 из 100 МБ» and its bar. `compact` — the row of the page: the words only. */
export function ContextUsage({
  bytes,
  limitBytes,
  percent,
  compact = false,
}: {
  bytes: number
  limitBytes: number
  percent: number
  compact?: boolean
}) {
  const shown = Math.max(0, Math.min(100, percent))
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Box
        role="progressbar"
        aria-label={contextText.usedLabel}
        aria-valuenow={shown}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={contextText.used(shown)}
        sx={{ height: 4, borderRadius: '999px', bgcolor: 'divider', overflow: 'hidden' }}
      >
        <Box
          sx={{
            width: `${shown}%`,
            minWidth: bytes > 0 ? 4 : 0,
            height: '100%',
            borderRadius: '999px',
            bgcolor: shown >= 90 ? 'warning.main' : 'primary.main',
          }}
        />
      </Box>
      <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
        {contextText.used(shown)}
        {compact ? null : ` · ${contextText.usedOf(bytes, limitBytes)}`}
      </Typography>
    </Box>
  )
}

/** The files on their way: progress, a failure with «Повторить», a cross that takes them out. */
export function ContextUploadChips({
  uploads,
  onRetry,
  onRemove,
}: {
  uploads: readonly ContextUpload[]
  onRetry: (key: string) => void
  onRemove: (key: string) => void
}) {
  if (uploads.length === 0) return null
  return (
    <Box
      component="ul"
      aria-label={contextText.list}
      sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: 1 }}
    >
      {uploads.map((item) => {
        const failed = item.state === 'failed'
        const busy = item.state === 'queued' || item.state === 'uploading'
        const percent = Math.round(item.progress * 100)
        const name = contextShownName(item.name, item.kind)
        return (
          <Box
            component="li"
            key={item.key}
            data-context-upload={item.state}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.25,
              minHeight: 56,
              maxWidth: '100%',
              minWidth: 0,
              pl: 1,
              py: 0.75,
              border: 1,
              borderColor: failed ? 'error.main' : 'divider',
              borderRadius: '12px',
              bgcolor: 'background.paper',
            }}
          >
            <ContextTile icon={contextIcon(item.name, item.kind)} failed={failed} />
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
              <Box
                component="span"
                title={item.name}
                sx={{
                  fontSize: 14,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: { xs: 180, sm: 240 },
                }}
              >
                {name}
              </Box>
              {failed ? (
                <Box
                  component="span"
                  role="alert"
                  sx={{ fontSize: 12.5, color: 'error.main', maxWidth: 280 }}
                >
                  {item.error ?? contextText.failed}{' '}
                  <Box
                    component="button"
                    type="button"
                    onClick={() => onRetry(item.key)}
                    aria-label={contextText.retryNamed(name)}
                    sx={{
                      minHeight: 44,
                      my: '-12px',
                      px: '2px',
                      border: 0,
                      bgcolor: 'transparent',
                      color: 'inherit',
                      font: 'inherit',
                      fontWeight: 600,
                      textDecoration: 'underline',
                      textUnderlineOffset: '3px',
                      cursor: 'pointer',
                    }}
                  >
                    {contextText.retry}
                  </Box>
                </Box>
              ) : busy ? (
                <>
                  <Box component="span" sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                    {contextText.uploading(percent)}
                  </Box>
                  <Box
                    component="span"
                    role="progressbar"
                    aria-label={contextText.progress(name)}
                    aria-valuenow={percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    sx={{
                      display: 'block',
                      width: 120,
                      height: 4,
                      borderRadius: '999px',
                      bgcolor: 'divider',
                      overflow: 'hidden',
                    }}
                  >
                    <Box
                      component="span"
                      sx={{
                        display: 'block',
                        width: `${percent}%`,
                        height: '100%',
                        bgcolor: 'primary.main',
                      }}
                    />
                  </Box>
                </>
              ) : (
                <Box component="span" sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                  {contextMeta(item.name, item.kind, item.size)}
                </Box>
              )}
            </Box>
            <IconButton
              aria-label={contextText.remove(name)}
              onClick={() => onRemove(item.key)}
              sx={{ width: 44, height: 44, flex: 'none' }}
            >
              <AppIcon name="close" size={16} />
            </IconButton>
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * The soft field of «Контекст» files can be dropped on (P-create): files, and folders with their
 * paths. While files are over it its border is the accent's.
 */
export function ContextDropArea({
  onFiles,
  labelledBy,
  disabled = false,
  children,
}: {
  onFiles: (files: ChosenFile[]) => void
  labelledBy?: string
  disabled?: boolean
  children: ReactNode
}) {
  const [over, setOver] = useState(false)
  const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')
  return (
    <Box
      role="group"
      aria-labelledby={labelledBy}
      data-context-drop=""
      onDragOver={(event: DragEvent) => {
        if (disabled || !carriesFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event: DragEvent) => {
        if (disabled || !carriesFiles(event)) return
        event.preventDefault()
        setOver(false)
        void droppedFiles(event.dataTransfer).then((files) => {
          if (files.length > 0) onFiles(files)
        })
      }}
      sx={{
        borderRadius: '16px',
        bgcolor: 'action.hover',
        border: 1,
        borderStyle: 'dashed',
        borderColor: over ? 'primary.main' : 'divider',
        p: 1.75,
        display: 'flex',
        flexDirection: 'column',
        gap: 1.75,
      }}
    >
      {children}
    </Box>
  )
}
