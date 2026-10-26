'use client'

import { attachmentSizeText } from '@repo/domain/attachments/labels'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'

import { AppIcon } from '@/components/application/app-icon'

import { attachmentText } from './chat-texts'
import type { AttachmentItem } from './use-attachments'

// The chips of attached files (docs/plan/57-browser-tasks.md, Б26): under the field while a
// message is written — with the progress of each file, a failure and «Повторить», a cross that
// takes the file out — and in the bubble of a message that sent them.

const chipSx = {
  display: 'flex',
  alignItems: 'center',
  gap: 1.25,
  minHeight: 56,
  maxWidth: '100%',
  pl: 0.75,
  border: 1,
  borderColor: 'divider',
  borderRadius: '12px',
  bgcolor: 'background.paper',
  minWidth: 0,
} as const

function Tile({ kind, failed }: { kind: 'image' | 'document'; failed?: boolean }) {
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
      <AppIcon name={failed ? 'warning' : kind === 'image' ? 'image' : 'file'} size={20} />
    </Box>
  )
}

const nameSx = {
  fontSize: 14,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: { xs: 140, sm: 180 },
} as const
const metaSx = { fontSize: 12.5, color: 'text.secondary', whiteSpace: 'nowrap' } as const

/** The files of the message being written. */
export function AttachmentChips({
  items,
  onRetry,
  onRemove,
}: {
  items: readonly AttachmentItem[]
  onRetry: (key: string) => void
  onRemove: (key: string) => void
}) {
  if (items.length === 0) return null
  return (
    <Box
      component="ul"
      aria-label={attachmentText.list}
      sx={{ m: 0, p: '4px 4px 0', listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: 1 }}
    >
      {items.map((item) => {
        const failed = item.state === 'failed'
        const busy = item.state === 'queued' || item.state === 'uploading'
        const percent = Math.round(item.progress * 100)
        return (
          <Box
            component="li"
            key={item.key}
            sx={{
              ...chipSx,
              ...(failed && { borderColor: 'error.main' }),
            }}
          >
            <Tile kind={item.kind} failed={failed} />
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
              <Box component="span" sx={nameSx} title={item.name}>
                {item.name}
              </Box>
              {failed ? (
                <Box
                  component="span"
                  role="alert"
                  sx={{ ...metaSx, color: 'error.main', whiteSpace: 'normal', maxWidth: 260 }}
                >
                  {item.error ?? attachmentText.failed}{' '}
                  <Box
                    component="button"
                    type="button"
                    onClick={() => onRetry(item.key)}
                    aria-label={attachmentText.retryNamed(item.name)}
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
                    {attachmentText.retry}
                  </Box>
                </Box>
              ) : busy ? (
                <>
                  <Box component="span" sx={metaSx}>
                    {attachmentText.uploading(percent)}
                  </Box>
                  <Box
                    component="span"
                    role="progressbar"
                    aria-label={attachmentText.progress(item.name)}
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
                        bgcolor: 'var(--chat-text, var(--raditi-accent))',
                      }}
                    />
                  </Box>
                </>
              ) : (
                <Box component="span" sx={metaSx}>
                  {attachmentSizeText(item.size)}
                </Box>
              )}
            </Box>
            <IconButton
              aria-label={
                busy ? attachmentText.cancelNamed(item.name) : attachmentText.removeNamed(item.name)
              }
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

/** A file a message sent, as its bubble names it. */
export interface SentFile {
  id: string
  name: string | null
  size: number | null
  kind: 'image' | 'document'
}

/** The files of a sent message: names and sizes, nothing to press. */
export function SentFiles({ files }: { files: readonly SentFile[] }) {
  if (files.length === 0) return null
  return (
    <Box
      component="ul"
      aria-label={attachmentText.sent}
      sx={{
        m: 0,
        p: 0,
        listStyle: 'none',
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        gap: 1,
      }}
    >
      {files.map((file) => (
        <Box component="li" key={file.id} sx={{ ...chipSx, pr: 1.5, minHeight: 52 }}>
          <Tile kind={file.kind} />
          <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <Box component="span" sx={nameSx} title={file.name ?? undefined}>
              {file.name ?? attachmentText.unnamed}
            </Box>
            {file.size === null ? null : (
              <Box component="span" sx={metaSx}>
                {attachmentSizeText(file.size)}
              </Box>
            )}
          </Box>
        </Box>
      ))}
    </Box>
  )
}
