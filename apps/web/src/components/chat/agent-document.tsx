'use client'

import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import LinearProgress from '@mui/material/LinearProgress'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { DocumentMarkdown } from '@repo/doc-render/markdown'
import { BrandProgress } from '@repo/ui/brand-progress'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AppRouter } from '@repo/trpc'
import type { inferRouterOutputs } from '@trpc/server'
import { createContext, useContext, useEffect, useEffectEvent, useRef, type ReactNode } from 'react'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { publishTexts, usePagePublish } from './page-publish'

// A document the agent writes section by section (docs/plan/69-pages.md, Ст19–Ст22), beside the
// chat (docs/plan/74-doc-live-panel.md): while it is written the tab «Документы» shows its sections
// as they come — a section a moment after the agent wrote it, once core checked it — and once it is
// finished, the version as the agent chose to show it: a page to read or plain text.

export type AgentDocument = inferRouterOutputs<AppRouter>['pages']['doc']

/** The words of a document of the agent: Russian, «вы». */
export const agentDocTexts = Object.freeze({
  kind: 'Документ',
  writing: 'пишется',
  done: (version: number) => `готов · v${version}`,
  progress: (written: number, total: number) => `Разделы: ${written} из ${total}`,
  short: (written: number, total: number) => `${written} из ${total}`,
  now: 'Пишется',
  checking: 'Проверяем раздел…',
  open: 'Открыть',
  openLabel: (title: string) => `Открыть документ «${title}»`,
  shownBeside: 'Открыт справа',
  download: (view: AgentDocument['view']) => (view === 'page' ? 'Скачать .html' : 'Скачать .md'),
  fullscreen: 'На весь экран',
  leaveFullscreen: 'Выйти из полноэкранного режима',
  frame: (title: string) => `Документ «${title}»`,
  failed: 'Не получилось загрузить документ.',
  loading: 'Загружаем документ',
})

/** Where the cabinet serves the current version of a document, as its view says (Ст12, Д1). */
export const documentDownloadHref = (docId: string): string =>
  `/api/documents/${encodeURIComponent(docId)}/markdown`

/** A document of the agent among the documents of the tab: its name in the tab's history. */
export const agentDocEntry = (docId: string): string => `doc:${docId}`
/** The document of a name of the tab's history; null — a file of the chat. */
export const agentDocOfEntry = (name: string): string | null =>
  name.startsWith('doc:') ? name.slice(4) : null

/** The documents the agent began in the chat (`feed.doc`), oldest first, each once. */
export function agentDocumentIdsOf(rows: readonly { type: string; docId?: string }[]): string[] {
  const ids: string[] = []
  for (const row of rows)
    if (row.type === 'feed.doc' && typeof row.docId === 'string' && !ids.includes(row.docId))
      ids.push(row.docId)
  return ids
}

/**
 * The latest revision of each document in the feed of the chat (`feed.doc_touch`, Ст22): a reader
 * of a document reads it again when it changes — after each section core checked, too.
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

/** A document, read again whenever the feed says it changed. */
export function useAgentDocument(docId: string) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const revision = useContext(DocRevisions).get(docId) ?? 0
  const doc = useQuery(trpc.pages.doc.queryOptions({ docId }))
  const read = doc.data?.revision ?? 0
  useEffect(() => {
    if (revision > read)
      void queryClient.invalidateQueries({ queryKey: trpc.pages.doc.queryKey({ docId }) })
  }, [revision, read, docId, queryClient, trpc])
  return doc
}

/** «Пишется · 3 из 7» or «готов · v1». */
export function docStatusOf(doc: AgentDocument): string {
  const { written, total } = doc.progress
  return doc.draft
    ? `${agentDocTexts.writing} · ${agentDocTexts.short(written, total)}`
    : agentDocTexts.done(doc.version)
}

/** The bar of the sections written: it moves with each one (Д3). */
export function DocProgress({ doc, height = 3 }: { doc: AgentDocument; height?: number }) {
  const { written, total } = doc.progress
  return (
    <LinearProgress
      variant="determinate"
      value={total === 0 ? 0 : (written / total) * 100}
      aria-label={agentDocTexts.progress(written, total)}
      sx={{ height, flexShrink: 0 }}
    />
  )
}

function HeadButton({
  icon,
  label,
  onClick,
  href,
  pressed,
  disabled,
}: {
  icon: AppIconName
  label: string
  onClick?: () => void
  href?: string
  pressed?: boolean
  disabled?: boolean
}) {
  const common = { 'aria-label': label, disabled, sx: { width: 44, height: 44 } }
  // What the button does, on hover and focus; a disabled one still says it.
  return (
    <Tooltip title={label}>
      <Box component="span" sx={{ display: 'inline-flex', flexShrink: 0 }}>
        {href ? (
          <IconButton {...common} component="a" href={href} download>
            <AppIcon name={icon} size={18} />
          </IconButton>
        ) : (
          <IconButton {...common} onClick={onClick} aria-pressed={pressed}>
            <AppIcon name={icon} size={18} />
          </IconButton>
        )}
      </Box>
    </Tooltip>
  )
}

/** The sheet the document is drawn on: light, as a page is, in either theme of the cabinet. */
const sheetSx = {
  flex: '1 1 0',
  minHeight: 0,
  overflowY: 'auto',
  bgcolor: '#fbf7f1',
  color: '#2a1d14',
  colorScheme: 'light',
} as const

const proseSx = {
  maxWidth: 760,
  mx: 'auto',
  px: { xs: 2.5, sm: 4 },
  py: { xs: 3, sm: 4 },
  fontSize: 16,
  lineHeight: 1.7,
  overflowWrap: 'anywhere',
  '& h1': { fontSize: 28, lineHeight: 1.25, fontWeight: 700, mt: 0, mb: 2.5 },
  '& h2': { fontSize: 21, lineHeight: 1.3, fontWeight: 650, mt: 3.5, mb: 1.25 },
  '& h3': { fontSize: 18, fontWeight: 600, mt: 2.5, mb: 1 },
  '& h4, & h5, & h6': { fontSize: 16, fontWeight: 600, mt: 2, mb: 1 },
  '& p, & ul, & ol, & pre, & blockquote, & table': { my: 1.25 },
  '& ul, & ol': { pl: 3 },
  '& a': { color: '#8a5a26' },
  '& code': { px: 0.5, borderRadius: '6px', bgcolor: '#efe5d8', fontSize: '0.9em' },
  '& pre': { p: 1.5, borderRadius: '12px', overflowX: 'auto', bgcolor: '#efe5d8', fontSize: 14 },
  '& pre code': { p: 0, bgcolor: 'transparent' },
  '& blockquote': { mx: 0, pl: 2, borderLeft: 3, borderColor: '#e0d2bf', color: '#6b5544' },
  '& table': { display: 'block', overflowX: 'auto', borderCollapse: 'collapse', fontSize: 14 },
  '& th, & td': { border: 1, borderColor: '#e0d2bf', px: 1.25, py: 0.75, textAlign: 'left' },
  '& img': { maxWidth: '100%', height: 'auto', borderRadius: '8px' },
} as const

const noDocuments: ReadonlySet<string> = new Set()
const noImage = () => null

function Markdown({ text }: { text: string }) {
  return (
    <DocumentMarkdown
      text={text}
      documents={noDocuments}
      imageSrc={noImage}
      documentLinks={false}
    />
  )
}

/**
 * The sections as they come (Д2, Д4): each written and checked one in full, the one being checked
 * a moment, the first one still to write marked «Пишется», the rest as the quiet lines of their
 * intent. A section that comes in is scrolled into sight, unless the client scrolled up to read.
 */
function LiveSections({ doc }: { doc: AgentDocument }) {
  const area = useRef<HTMLDivElement | null>(null)
  const shown = doc.sections.filter((section) => section.state === 'shown').length
  const before = useRef(shown)
  useEffect(() => {
    const element = area.current
    if (element === null || shown <= before.current) {
      before.current = shown
      return
    }
    before.current = shown
    const nearEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 240
    const last = element.querySelectorAll('[data-doc-section="shown"]')[shown - 1]
    if (nearEnd) last?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [shown])
  const firstPending = doc.sections.findIndex((section) => section.state === 'pending')
  return (
    <Box ref={area} sx={sheetSx}>
      <Box sx={proseSx}>
        <Box component="h1">{doc.title}</Box>
        {doc.sections.map((section, index) => {
          if (section.state === 'shown')
            return (
              <Box component="section" key={section.key} data-doc-section="shown">
                <Box component="h2">{section.heading}</Box>
                <Markdown text={section.markdown ?? ''} />
              </Box>
            )
          const now = section.state === 'unchecked' || index === firstPending
          return (
            <Box
              component="section"
              key={section.key}
              data-doc-section={section.state}
              aria-busy={now || undefined}
              sx={{ mt: 2.5, color: now ? '#7a5a3c' : '#9a8571', fontSize: 15 }}
            >
              <Box
                sx={{ display: 'flex', alignItems: 'center', gap: 1, fontWeight: now ? 600 : 400 }}
              >
                {now ? (
                  <Box
                    component="span"
                    aria-hidden
                    sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'primary.main' }}
                  />
                ) : null}
                <span>{section.intent}</span>
              </Box>
              {now ? (
                <>
                  <Typography variant="body2" sx={{ mt: 0.5, color: '#9a8571' }}>
                    {section.state === 'unchecked' ? agentDocTexts.checking : agentDocTexts.now}
                  </Typography>
                  <Box
                    sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 1.25 }}
                    aria-hidden
                  >
                    <Box
                      sx={{ height: 12, width: '92%', borderRadius: '6px', bgcolor: '#efe5d8' }}
                    />
                    <Box
                      sx={{ height: 12, width: '76%', borderRadius: '6px', bgcolor: '#efe5d8' }}
                    />
                  </Box>
                </>
              ) : null}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

/** The finished version as text (Д1, `text`): the cabinet draws its Markdown. */
function TextVersion({ doc }: { doc: AgentDocument }) {
  const markdown = [
    `# ${doc.title}`,
    ...doc.sections.map((section) => `## ${section.heading ?? ''}\n\n${section.markdown ?? ''}`),
  ].join('\n\n')
  return (
    <Box sx={sheetSx}>
      <Box sx={proseSx}>
        <Markdown text={markdown} />
      </Box>
    </Box>
  )
}

/**
 * The finished version as a page (Д1, `page`): the page to read `@repo/doc-render` draws of the
 * text core checked, in a frame of an opaque origin with no script — the page «Опубликовать по
 * ссылке» gives. Links leave in a new tab.
 */
function PageVersion({ doc }: { doc: AgentDocument }) {
  const trpc = useTRPC()
  const page = useQuery(trpc.pages.docPage.queryOptions({ docId: doc.docId, version: doc.version }))
  if (page.isError)
    return (
      <Box sx={{ p: 3 }}>
        <Typography color="text.secondary">{agentDocTexts.failed}</Typography>
      </Box>
    )
  if (!page.data)
    return page.isPending ? (
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <BrandProgress size={28} aria-label={agentDocTexts.loading} />
      </Box>
    ) : (
      <TextVersion doc={doc} />
    )
  return (
    <Box sx={{ flex: '1 1 0', minHeight: 0, position: 'relative' }}>
      <Box
        component="iframe"
        key={`${page.data.version}:${doc.revision}`}
        srcDoc={page.data.html}
        title={agentDocTexts.frame(doc.title)}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
      />
    </Box>
  )
}

/**
 * A document of the agent in the tab «Документы» (docs/plan/74): its head — what the tab gives
 * before it (`lead`: back, forward, the list), the title, its state, and once there is a version
 * «Скачать», «Опубликовать по ссылке» and «На весь экран» — the bar of the sections while it is
 * written, then the sections as they come or the finished version.
 */
export function AgentDocumentView({
  docId,
  lead,
  aside,
  fullscreen = false,
  onFullscreen,
}: {
  docId: string
  lead?: ReactNode
  /** The list of the documents beside it, when the tab is wide. */
  aside?: ReactNode
  fullscreen?: boolean
  onFullscreen?: (on: boolean) => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const doc = useAgentDocument(docId)
  const publishDoc = useMutation(trpc.pages.publishDoc.mutationOptions())
  const publication = usePagePublish()
  const data = doc.data
  if (!data)
    return (
      <Box sx={{ p: 3 }}>
        {doc.isError ? (
          <Typography color="text.secondary">{agentDocTexts.failed}</Typography>
        ) : (
          <BrandProgress size={28} aria-label={agentDocTexts.loading} />
        )}
      </Box>
    )
  return (
    <Box
      aria-label={`${agentDocTexts.kind} «${data.title}»`}
      sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          py: 0.5,
          borderBottom: 1,
          borderColor: 'divider',
          minWidth: 0,
        }}
      >
        {lead}
        <Box
          sx={{
            flex: '1 1 auto',
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 1.5,
            py: 0.75,
            borderRadius: '999px',
            bgcolor: 'var(--mui-palette-action-hover)',
            fontSize: 14,
          }}
        >
          <Box
            component="span"
            title={data.title}
            sx={{
              fontWeight: 600,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {data.title}
          </Box>
          <Box
            component="span"
            role="status"
            sx={{ color: 'text.secondary', whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            {docStatusOf(data)}
          </Box>
        </Box>
        {data.version > 0 ? (
          <HeadButton
            icon="download"
            label={agentDocTexts.download(data.view)}
            href={documentDownloadHref(docId)}
          />
        ) : null}
        {data.version > 0 && data.canPublish ? (
          <HeadButton
            icon="share"
            label={publishTexts.byLink}
            disabled={publication.pending}
            onClick={() =>
              void publication.publish(async () => {
                const published = await publishDoc.mutateAsync({ docId })
                void queryClient.invalidateQueries({ queryKey: trpc.pages.doc.queryKey({ docId }) })
                return published
              })
            }
          />
        ) : null}
        {onFullscreen ? (
          <HeadButton
            icon={fullscreen ? 'shrink' : 'fullscreen'}
            label={fullscreen ? agentDocTexts.leaveFullscreen : agentDocTexts.fullscreen}
            pressed={fullscreen}
            onClick={() => onFullscreen(!fullscreen)}
          />
        ) : null}
      </Box>
      {data.draft ? <DocProgress doc={data} /> : null}
      <Box sx={{ flex: '1 1 0', minHeight: 0, display: 'flex' }}>
        {aside}
        <Box sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {data.draft ? (
            <LiveSections doc={data} />
          ) : data.view === 'page' ? (
            <PageVersion doc={data} />
          ) : (
            <TextVersion doc={data} />
          )}
        </Box>
      </Box>
      {publication.dialog}
    </Box>
  )
}

/** A row of the list of the tab: a document of the agent by its title, read once. */
export function AgentDocTitle({ docId }: { docId: string }) {
  const doc = useAgentDocument(docId)
  return <>{doc.data?.title ?? agentDocTexts.kind}</>
}

/** The state of a document of the agent under its title in the list. */
export function AgentDocStatus({ docId }: { docId: string }) {
  const doc = useAgentDocument(docId)
  return <>{doc.data ? docStatusOf(doc.data) : ''}</>
}

/**
 * A document the agent begins while the client looks at the chat (docs/plan/74, Д5): the ids of
 * the first answer are the base, an id after it came live and is told once. The chat opens the
 * tab «Документы» on it — beside the dialog from `lg`, as a file of the chat does (plan 67, Д4).
 */
export function useAgentDocumentArrivals(
  ids: readonly string[],
  ready: boolean,
  onArrive: (docId: string) => void,
) {
  const base = useRef<ReadonlySet<string> | undefined>(undefined)
  const arrive = useEffectEvent(onArrive)
  useEffect(() => {
    if (!ready) return
    if (base.current === undefined) {
      base.current = new Set(ids)
      return
    }
    const known = base.current
    const fresh = ids.filter((id) => !known.has(id))
    if (fresh.length === 0) return
    base.current = new Set(ids)
    arrive(fresh.at(-1)!)
  }, [ids, ready])
}
