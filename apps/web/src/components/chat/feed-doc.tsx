'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import LinearProgress from '@mui/material/LinearProgress'
import Typography from '@mui/material/Typography'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import type { AppRouter } from '@repo/trpc'
import type { inferRouterOutputs } from '@trpc/server'

import { useTRPC } from '@/trpc/client'

import { AgentMarkdown } from './agent-markdown'

/** The words of a document of the agent (docs/plan/69-pages.md, Ст22): Russian, «вы». */
export const feedDocTexts = Object.freeze({
  kind: 'Документ',
  writing: 'пишется',
  done: (version: number) => `готов · v${version}`,
  progress: (written: number, total: number) => `Разделы: ${written} из ${total}`,
  pending: 'Пишется',
  unchecked: 'Написан — покажем в конце хода',
  open: 'Открыть',
  openLabel: (title: string) => `Открыть документ «${title}»`,
  download: 'Скачать .md',
  close: 'Закрыть',
  failed: 'Не получилось загрузить документ.',
})

/** Where the cabinet serves the Markdown of a document's version (Ст12). */
export const documentMarkdownHref = (docId: string): string =>
  `/api/documents/${encodeURIComponent(docId)}/markdown`

type Document = inferRouterOutputs<AppRouter>['pages']['doc']

/**
 * The latest revision of each document in the feed of the chat (`feed.doc_touch`, Ст22): the
 * card reads its document again when it changes — the end of a turn writes one after its check.
 */
export const DocRevisions = createContext<ReadonlyMap<string, number>>(new Map())

/** The latest revision of every document the rows touch. */
export function docRevisionsOf(
  rows: readonly { type: string; docId?: string; revision?: number }[],
): Map<string, number> {
  const revisions = new Map<string, number>()
  for (const row of rows)
    if (row.type === 'feed.doc_touch' && row.docId && typeof row.revision === 'number')
      revisions.set(row.docId, Math.max(revisions.get(row.docId) ?? 0, row.revision))
  return revisions
}

/** One section as the card and the full view show it: text once checked, its intent before. */
function Section({ section }: { section: Document['sections'][number] }) {
  if (section.state === 'shown')
    return (
      <Box component="section" sx={{ mb: 2.5 }}>
        <Typography component="h3" variant="h6" sx={{ mb: 0.75 }}>
          {section.heading}
        </Typography>
        <AgentMarkdown text={section.markdown ?? ''} />
      </Box>
    )
  return (
    <Box component="section" sx={{ mb: 1.5, color: 'text.secondary' }}>
      <Typography sx={{ fontWeight: 600 }}>{section.intent}</Typography>
      <Typography variant="body2">
        {section.state === 'pending' ? feedDocTexts.pending : feedDocTexts.unchecked}
      </Typography>
    </Box>
  )
}

/**
 * A document the agent writes (`feed.doc`, docs/plan/69-pages.md, Ст19, Ст22): a live card — its
 * title, «Разделы: N из M», the sections written and checked by core in full, the others as
 * quiet lines with their intent. A change of it comes as `feed.doc_touch`, which shows nothing by
 * itself: the card reads the document again then. «Открыть» shows it whole; «Скачать .md» once
 * it has a version.
 */
export function FeedDoc({ docId }: { docId: string }) {
  const trpc = useTRPC()
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const revision = useContext(DocRevisions).get(docId) ?? 0
  const doc = useQuery(trpc.pages.doc.queryOptions({ docId }))
  // A newer change in the feed than the card read: read it again.
  useEffect(() => {
    if (revision > (doc.data?.revision ?? 0))
      void queryClient.invalidateQueries({ queryKey: trpc.pages.doc.queryKey({ docId }) })
  }, [revision, doc.data?.revision, docId, queryClient, trpc])
  const data: Document | undefined = doc.data
  // A failed reading after a good one leaves the card as it was.
  if (!data)
    return doc.isError ? (
      <Typography sx={{ color: 'text.secondary' }}>{feedDocTexts.failed}</Typography>
    ) : null
  const { written, total } = data.progress
  return (
    <Box
      component="article"
      aria-label={`${feedDocTexts.kind} «${data.title}»`}
      sx={{
        alignSelf: 'stretch',
        border: 1,
        borderColor: 'divider',
        borderRadius: '18px',
        bgcolor: 'background.paper',
        overflow: 'hidden',
        minWidth: 0,
      }}
    >
      <Box
        component="header"
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 1.5,
          px: { xs: 2, sm: 2.5 },
          py: 1.5,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Box sx={{ display: 'flex', color: 'text.secondary' }} aria-hidden>
          <AppIcon name="pages" size={20} />
        </Box>
        <Box sx={{ minWidth: 0, flex: '1 1 200px' }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {feedDocTexts.kind} ·{' '}
            {data.version > 0 ? feedDocTexts.done(data.version) : feedDocTexts.writing}
          </Typography>
          <Typography sx={{ fontWeight: 600, fontSize: 16, overflowWrap: 'anywhere' }}>
            {data.title}
          </Typography>
        </Box>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {feedDocTexts.progress(written, total)}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            size="small"
            variant="outlined"
            onClick={() => setOpen(true)}
            aria-label={feedDocTexts.openLabel(data.title)}
            sx={{ minHeight: 40 }}
          >
            {feedDocTexts.open}
          </Button>
          {data.version > 0 && (
            <Button
              size="small"
              variant="contained"
              href={documentMarkdownHref(docId)}
              sx={{ minHeight: 40 }}
            >
              {feedDocTexts.download}
            </Button>
          )}
        </Box>
      </Box>
      <LinearProgress
        variant="determinate"
        value={total === 0 ? 0 : (written / total) * 100}
        aria-label={feedDocTexts.progress(written, total)}
        sx={{ height: 4 }}
      />
      <Box sx={{ px: { xs: 2, sm: 2.5 }, py: 2, maxHeight: 420, overflowY: 'auto' }}>
        {data.sections.map((section) => (
          <Section key={section.key} section={section} />
        ))}
      </Box>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        fullWidth
        maxWidth="md"
        aria-labelledby={`doc-${docId}`}
      >
        <DialogTitle id={`doc-${docId}`} sx={{ pr: 7 }}>
          {data.title}
        </DialogTitle>
        <IconButton
          aria-label={feedDocTexts.close}
          onClick={() => setOpen(false)}
          sx={{ position: 'absolute', right: 12, top: 12 }}
        >
          <AppIcon name="close" size={18} />
        </IconButton>
        <DialogContent dividers>
          {data.sections.map((section) => (
            <Section key={section.key} section={section} />
          ))}
        </DialogContent>
      </Dialog>
    </Box>
  )
}
