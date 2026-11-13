'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import {
  documentOfFile,
  documentVersionOf,
  type ChatDocument,
} from '@repo/domain/tasks/chat-documents'
import { useParams } from 'next/navigation'

import { AppIcon } from '@/components/application/app-icon'

import { documentText } from './chat-texts'
import { documentWindowHref } from './documents-pane'
import { taskFileHref } from './feed-file'

// A page or a text document the agent made, in the feed (docs/plan/67-agent-documents.md, Д4): a
// card with its title, its kind and version, «Открыть» — the tab «Страницы» on this version, or
// without the tab a window of its own — and «Скачать». Several documents of one turn are one card.

const cardSx = {
  alignSelf: 'stretch',
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  px: { xs: 2, sm: 2.5 },
  py: 1.5,
  border: 1,
  borderColor: 'divider',
  borderRadius: '18px',
  bgcolor: 'background.paper',
  minWidth: 0,
} as const

function DocumentLine({
  taskId,
  document,
  fileId,
  onOpen,
}: {
  taskId: string
  document: ChatDocument
  fileId: string
  onOpen?: (fileId: string) => void
}) {
  const number = documentVersionOf(document, fileId)?.number ?? document.versions.length
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
      <Box sx={{ display: 'flex', color: 'text.secondary', flexShrink: 0 }} aria-hidden>
        <AppIcon name={document.kind === 'page' ? 'globe' : 'document'} size={20} />
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography
          sx={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere', lineHeight: 1.35 }}
        >
          {document.title}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {`${documentText.kind[document.kind]} · ${documentText.version(number)}`}
        </Typography>
      </Box>
      {onOpen ? (
        <Button
          size="small"
          variant="outlined"
          onClick={() => onOpen(fileId)}
          aria-label={documentText.openLabel(document.title)}
          sx={{ flexShrink: 0, minHeight: 44 }}
        >
          {documentText.open}
        </Button>
      ) : (
        <Button
          size="small"
          variant="outlined"
          href={documentWindowHref(taskId, fileId)}
          target="_blank"
          aria-label={documentText.openLabel(document.title)}
          sx={{ flexShrink: 0, minHeight: 44 }}
        >
          {documentText.open}
        </Button>
      )}
      <Link
        href={taskFileHref(taskId, fileId)}
        download={document.name}
        aria-label={documentText.downloadLabel(document.title)}
        variant="body2"
        sx={{
          flexShrink: 0,
          fontWeight: 600,
          minHeight: 44,
          display: 'inline-flex',
          alignItems: 'center',
        }}
      >
        {documentText.download}
      </Link>
    </Box>
  )
}

/** One document, or the documents of one turn (`fileIds`, two or more). */
export function FeedDocuments({
  fileIds,
  documents,
  onOpen,
}: {
  fileIds: readonly string[]
  documents: readonly ChatDocument[]
  onOpen?: (fileId: string) => void
}) {
  const { taskId } = useParams<{ taskId?: string }>()
  if (typeof taskId !== 'string') return null
  const lines = fileIds.flatMap((fileId) => {
    const document = documentOfFile(documents, fileId)
    return document ? [{ fileId, document }] : []
  })
  if (lines.length === 0) return null
  return (
    <Box sx={cardSx}>
      {lines.length > 1 ? (
        <Typography sx={{ fontWeight: 600 }}>{documentText.group(lines.length)}</Typography>
      ) : null}
      {lines.map(({ fileId, document }) => (
        <DocumentLine
          key={fileId}
          taskId={taskId}
          document={document}
          fileId={fileId}
          {...(onOpen ? { onOpen } : {})}
        />
      ))}
    </Box>
  )
}
