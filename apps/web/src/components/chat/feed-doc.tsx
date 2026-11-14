'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'

import { AppIcon } from '@/components/application/app-icon'

import {
  agentDocTexts,
  DocProgress,
  docStatusOf,
  documentDownloadHref,
  useAgentDocument,
} from './agent-document'

export { DocRevisions, docRevisionsOf } from './agent-document'

/** The words of the card of a document in the feed (docs/plan/69-pages.md, Ст22; plan 74). */
export const feedDocTexts = agentDocTexts

/**
 * A document the agent writes (`feed.doc`; docs/plan/74-doc-live-panel.md): one compact line in
 * the feed — its title, «пишется · N из M» with the bar of the sections, or «готов · vN». The
 * document itself is in the tab «Документы» beside the chat: «Открыть» shows it there. Where the
 * chat has no tab to open (`onOpen` absent), «Скачать» once it has a version.
 */
export function FeedDoc({
  docId,
  onOpen,
  open = false,
}: {
  docId: string
  onOpen?: (docId: string) => void
  /** The tab shows this document now: the card says so instead of «Открыть». */
  open?: boolean
}) {
  const doc = useAgentDocument(docId)
  const data = doc.data
  // A failed reading after a good one leaves the card as it was.
  if (!data)
    return doc.isError ? (
      <Typography sx={{ color: 'text.secondary' }}>{agentDocTexts.failed}</Typography>
    ) : null
  return (
    <Box
      component="article"
      aria-label={`${agentDocTexts.kind} «${data.title}»`}
      sx={{
        alignSelf: 'flex-start',
        width: '100%',
        maxWidth: 560,
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: '14px',
        bgcolor: 'background.paper',
        px: 1.75,
        py: 1.25,
        minWidth: 0,
      }}
    >
      <Box sx={{ display: 'flex', color: 'text.secondary' }} aria-hidden>
        <AppIcon name="pages" size={20} />
      </Box>
      <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {agentDocTexts.kind} · {docStatusOf(data)}
        </Typography>
        <Typography sx={{ fontWeight: 600, fontSize: 15, overflowWrap: 'anywhere' }}>
          {data.title}
        </Typography>
        {data.draft ? (
          <Box sx={{ mt: 1, borderRadius: '2px', overflow: 'hidden' }}>
            <DocProgress doc={data} height={4} />
          </Box>
        ) : null}
      </Box>
      {onOpen ? (
        open ? (
          <Typography
            variant="body2"
            sx={{ color: 'primary.main', whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            {agentDocTexts.shownBeside}
          </Typography>
        ) : (
          <Button
            size="small"
            variant="outlined"
            onClick={() => onOpen(docId)}
            aria-label={agentDocTexts.openLabel(data.title)}
            sx={{ minHeight: 40, flexShrink: 0, borderRadius: '20px' }}
          >
            {agentDocTexts.open}
          </Button>
        )
      ) : data.version > 0 ? (
        <Button
          size="small"
          variant="outlined"
          href={documentDownloadHref(docId)}
          sx={{ minHeight: 40, flexShrink: 0 }}
        >
          {agentDocTexts.download(data.view)}
        </Button>
      ) : null}
    </Box>
  )
}
