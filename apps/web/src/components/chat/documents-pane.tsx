'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import InputBase from '@mui/material/InputBase'
import Link from '@mui/material/Link'
import MenuItem from '@mui/material/MenuItem'
import Popover from '@mui/material/Popover'
import Select from '@mui/material/Select'
import Typography from '@mui/material/Typography'
import { DocumentMarkdown, markdownTitleOf } from '@repo/doc-render/markdown'
import { PAGE_SANDBOX } from '@repo/domain/pages'
import {
  chatDocumentsOf,
  chatImageAt,
  compareFeedIds,
  documentVersionOf,
  openingDocumentOf,
  type ChatDocument,
  type ChatFileRow,
} from '@repo/domain/tasks/chat-documents'
import { BrandProgress } from '@repo/ui/brand-progress'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import {
  agentDocEntry,
  agentDocOfEntry,
  AgentDocStatus,
  AgentDocTitle,
  AgentDocumentView,
} from './agent-document'
import { documentText } from './chat-texts'
import { taskFileHref } from './feed-file'

// «Документы» beside the chat (docs/plan/67-agent-documents.md, Д4–Д7): the pages and the text
// documents the agent made, as a browser shows them — «Назад» and «Вперёд» over what the client
// opened here, the list of the documents of the chat, the title where a browser has its address,
// the version, and on the right «Обновить», «На весь экран», a new tab, «Скачать», «Поделиться». A
// page is framed from the domain of pages, in an opaque origin; a text document is drawn here by
// `DocumentMarkdown`.

/** A document asked for from outside the tab: an arrival, «Открыть» of a card, a new tab. */
export interface DocumentTarget {
  name: string
  /** A version; null — the latest. */
  fileId: string | null
  /** A new value opens it again, the same document too. */
  seq: number
}

interface Entry {
  name: string
  fileId: string | null
  anchor: string | null
}

/** Where a document opens in a tab of its own: the window of the cabinet (Д4). */
export const documentWindowHref = (taskId: string, fileId: string): string =>
  `/chats/${encodeURIComponent(taskId)}/documents/${encodeURIComponent(fileId)}`

const imageHref = (taskId: string, fileId: string) => `${taskFileHref(taskId, fileId)}/image`

/** The history of the tab: «Назад» and «Вперёд» over the documents opened in it. */
function useDocumentHistory(target: DocumentTarget | null, fallback: string | null) {
  const [history, setHistory] = useState<{ entries: Entry[]; index: number }>(() => ({
    entries: target ? [{ name: target.name, fileId: target.fileId, anchor: null }] : [],
    index: 0,
  }))
  // A step from the document shown by default keeps it behind «Назад».
  const pushed = useCallback(
    ({ entries, index }: { entries: Entry[]; index: number }, entry: Entry) => {
      const before =
        entries.length > 0
          ? entries.slice(0, index + 1)
          : fallback
            ? [{ name: fallback, fileId: null, anchor: null }]
            : []
      return { entries: [...before, entry], index: before.length }
    },
    [fallback],
  )
  const [seq, setSeq] = useState(target?.seq ?? null)
  if (target !== null && target.seq !== seq) {
    setSeq(target.seq)
    setHistory((state) =>
      seq === null && state.entries.length === 0
        ? { entries: [{ name: target.name, fileId: target.fileId, anchor: null }], index: 0 }
        : pushed(state, { name: target.name, fileId: target.fileId, anchor: null }),
    )
  }
  const current: Entry | null =
    history.entries[history.index] ??
    (fallback ? { name: fallback, fileId: null, anchor: null } : null)
  const go = useCallback((entry: Entry) => setHistory((state) => pushed(state, entry)), [pushed])
  const step = (by: -1 | 1) =>
    setHistory((state) => ({
      ...state,
      index: Math.min(Math.max(0, state.index + by), state.entries.length - 1),
    }))
  return {
    current,
    go,
    back: history.index > 0 ? () => step(-1) : null,
    forward: history.index < history.entries.length - 1 ? () => step(1) : null,
  }
}

/** The width of the tab: the list stands beside the document from about 600 px. */
function useWide(element: HTMLElement | null, at: number): boolean {
  const [wide, setWide] = useState(false)
  useEffect(() => {
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWide((entry?.contentRect.width ?? 0) >= at))
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, at])
  return wide
}

function HeadButton({
  icon,
  label,
  onClick,
  disabled,
  pressed,
  href,
  download,
}: {
  icon: AppIconName
  label: string
  onClick?: () => void
  disabled?: boolean
  pressed?: boolean
  href?: string
  download?: string
}) {
  const common = {
    'aria-label': label,
    title: label,
    disabled,
    sx: { width: 44, height: 44, flexShrink: 0 },
  }
  if (href)
    return (
      <IconButton
        {...common}
        component="a"
        href={href}
        {...(download ? { download } : { target: '_blank', rel: 'noopener' })}
      >
        <AppIcon name={icon} size={18} />
      </IconButton>
    )
  return (
    <IconButton {...common} onClick={onClick} aria-pressed={pressed}>
      <AppIcon name={icon} size={18} />
    </IconButton>
  )
}

export function DocumentsPane({
  taskId,
  rows,
  agentDocs = [],
  target,
  fullscreen = false,
  onFullscreen,
  onPublish,
  standalone = false,
}: {
  taskId: string
  /** The rows of the chat: the documents, their versions and the pictures come from them. */
  rows: readonly ChatFileRow[]
  /**
   * The documents the agent writes section by section, oldest first (docs/plan/74): in the list
   * with the files, each as `agentDocEntry(docId)` in the tab's history.
   */
  agentDocs?: readonly string[]
  target: DocumentTarget | null
  fullscreen?: boolean
  onFullscreen?: (on: boolean) => void
  /**
   * «Опубликовать как страницу» of a version, at the client's wish (owner's answer of
   * 13.11.2026): the publishing is plan 69's; absent — not offered here.
   */
  onPublish?: (document: ChatDocument, fileId: string) => void
  /** The window of a new tab: no new tab of it, the list beside it always. */
  standalone?: boolean
}) {
  const documents = useMemo(() => chatDocumentsOf(rows), [rows])
  const names = useMemo(() => new Set(documents.map((document) => document.name)), [documents])
  const latestAgentDoc = agentDocs.at(-1)
  const fallback =
    openingDocumentOf(documents.map((document) => document.name)) ??
    (latestAgentDoc === undefined ? null : agentDocEntry(latestAgentDoc))
  const { current, go, back, forward } = useDocumentHistory(target, fallback)
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const wide = useWide(root, 600) || fullscreen || standalone
  const [listAnchor, setListAnchor] = useState<HTMLElement | null>(null)
  const [reload, setReload] = useState(0)
  const [source, setSource] = useState(false)
  const [contentsOpen, setContentsOpen] = useState(true)

  const document = current ? (documents.find((one) => one.name === current.name) ?? null) : null
  const version =
    document === null
      ? null
      : current?.fileId
        ? documentVersionOf(document, current.fileId)
        : { version: document.versions.at(-1)!, number: document.versions.length }

  const open = (name: string, anchor: string | null = null) => {
    setListAnchor(null)
    go({ name, fileId: null, anchor })
  }

  const currentAgentDoc = current ? agentDocOfEntry(current.name) : null
  const list = (
    <DocumentList
      documents={documents}
      agentDocs={agentDocs}
      current={current?.name ?? null}
      onOpen={(name) => open(name)}
    />
  )

  if (currentAgentDoc !== null && agentDocs.includes(currentAgentDoc))
    return (
      <Box ref={setRoot} sx={{ height: '100%', minHeight: 0, minWidth: 0 }}>
        <AgentDocumentView
          key={currentAgentDoc}
          docId={currentAgentDoc}
          fullscreen={fullscreen}
          {...(onFullscreen ? { onFullscreen } : {})}
          lead={
            <>
              <HeadButton
                icon="back"
                label={documentText.back}
                onClick={back ?? undefined}
                disabled={!back}
              />
              <HeadButton
                icon="forward"
                label={documentText.forward}
                onClick={forward ?? undefined}
                disabled={!forward}
              />
              {wide ? null : (
                <Button
                  size="small"
                  onClick={(event) => setListAnchor(event.currentTarget)}
                  aria-haspopup="dialog"
                  aria-expanded={listAnchor !== null}
                  sx={{ flexShrink: 0, minHeight: 44, whiteSpace: 'nowrap' }}
                >
                  {documentText.all(documents.length + agentDocs.length)}
                </Button>
              )}
            </>
          }
          aside={
            wide ? (
              <Box
                component="nav"
                aria-label={documentText.list}
                sx={{
                  width: 240,
                  flexShrink: 0,
                  borderRight: 1,
                  borderColor: 'divider',
                  overflowY: 'auto',
                }}
              >
                {list}
              </Box>
            ) : null
          }
        />
        <Popover
          open={listAnchor !== null}
          anchorEl={listAnchor}
          onClose={() => setListAnchor(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          slotProps={{ paper: { sx: { width: 300, maxHeight: '70vh' } } }}
        >
          <Box component="nav" aria-label={documentText.list}>
            {list}
          </Box>
        </Popover>
      </Box>
    )

  if (documents.length === 0 || document === null || version === null)
    return (
      <Box sx={{ p: 3 }}>
        <Typography color="text.secondary">{documentText.empty}</Typography>
      </Box>
    )

  const fileId = version.version.fileId
  return (
    <Box
      ref={setRoot}
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
        <HeadButton
          icon="back"
          label={documentText.back}
          onClick={back ?? undefined}
          disabled={!back}
        />
        <HeadButton
          icon="forward"
          label={documentText.forward}
          onClick={forward ?? undefined}
          disabled={!forward}
        />
        {wide ? null : (
          <Button
            size="small"
            onClick={(event) => setListAnchor(event.currentTarget)}
            aria-haspopup="dialog"
            aria-expanded={listAnchor !== null}
            sx={{ flexShrink: 0, minHeight: 44, whiteSpace: 'nowrap' }}
          >
            {documentText.all(documents.length + agentDocs.length)}
          </Button>
        )}
        <Box
          role="textbox"
          aria-readonly="true"
          aria-label={documentText.title}
          title={document.name}
          sx={{
            flex: '1 1 auto',
            minWidth: 0,
            px: 1.5,
            py: 0.75,
            borderRadius: '999px',
            bgcolor: 'var(--mui-palette-action-hover)',
            fontSize: 14,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <DocumentTitle
            taskId={taskId}
            document={document}
            fileId={fileId}
            fallback={document.title}
          />
        </Box>
        {document.versions.length > 1 ? (
          <Select
            size="small"
            value={fileId}
            onChange={(event) =>
              go({ name: document.name, fileId: event.target.value, anchor: null })
            }
            inputProps={{
              'aria-label': documentText.versionOf(version.number, document.versions.length),
            }}
            sx={{ flexShrink: 0, fontSize: 14 }}
          >
            {document.versions.map((one, index) => (
              <MenuItem key={one.fileId} value={one.fileId} sx={{ minHeight: 44 }}>
                {documentText.versionOf(index + 1, document.versions.length)}
              </MenuItem>
            ))}
          </Select>
        ) : null}
        <HeadButton
          icon="retry"
          label={documentText.refresh}
          onClick={() => setReload((n) => n + 1)}
        />
        {onFullscreen ? (
          <HeadButton
            icon={fullscreen ? 'shrink' : 'fullscreen'}
            label={fullscreen ? documentText.leaveFullscreen : documentText.fullscreen}
            pressed={fullscreen}
            onClick={() => onFullscreen(!fullscreen)}
          />
        ) : null}
        {standalone ? null : (
          <HeadButton
            icon="arrow"
            label={documentText.newTab}
            href={documentWindowHref(taskId, fileId)}
          />
        )}
        <HeadButton
          icon="down"
          label={documentText.downloadLabel(document.title)}
          href={taskFileHref(taskId, fileId)}
          download={document.name}
        />
        {onPublish ? (
          <HeadButton
            icon="share"
            label={documentText.publish}
            onClick={() => onPublish(document, fileId)}
          />
        ) : null}
      </Box>
      {document.kind === 'markdown' ? (
        <Box
          sx={{
            display: 'flex',
            gap: 0.5,
            px: 1,
            py: 0.25,
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Button
            size="small"
            startIcon={<AppIcon name="contents" size={16} />}
            aria-pressed={contentsOpen}
            onClick={() => setContentsOpen((on) => !on)}
            sx={{ minHeight: 40, display: wide ? 'inline-flex' : 'none' }}
          >
            {documentText.contents}
          </Button>
          <Button
            size="small"
            aria-pressed={source}
            onClick={() => setSource((on) => !on)}
            sx={{ minHeight: 40 }}
          >
            {source ? documentText.rendered : documentText.source}
          </Button>
          <CopyText taskId={taskId} fileId={fileId} />
        </Box>
      ) : null}
      <Box sx={{ flex: '1 1 0', minHeight: 0, display: 'flex' }}>
        {wide ? (
          <Box
            component="nav"
            aria-label={documentText.list}
            sx={{
              width: 240,
              flexShrink: 0,
              borderRight: 1,
              borderColor: 'divider',
              overflowY: 'auto',
            }}
          >
            {list}
          </Box>
        ) : null}
        <Box sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex' }}>
          {document.kind === 'page' ? (
            <PageFrame
              key={`${fileId}:${reload}`}
              taskId={taskId}
              fileId={fileId}
              title={document.title}
            />
          ) : (
            <MarkdownView
              key={`${fileId}:${reload}`}
              taskId={taskId}
              fileId={fileId}
              rowId={version.version.rowId}
              rows={rows}
              names={names}
              anchor={current?.anchor ?? null}
              source={source}
              contents={wide && contentsOpen}
              onDocument={open}
            />
          )}
        </Box>
      </Box>
      <Popover
        open={listAnchor !== null}
        anchorEl={listAnchor}
        onClose={() => setListAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { width: 300, maxHeight: '70vh' } } }}
      >
        <Box component="nav" aria-label={documentText.list}>
          {list}
        </Box>
      </Popover>
    </Box>
  )
}

/** The title of the document: its `# …` once its text is read, its name before that. */
function DocumentTitle({
  taskId,
  document,
  fileId,
  fallback,
}: {
  taskId: string
  document: ChatDocument
  fileId: string
  fallback: string
}) {
  const trpc = useTRPC()
  const text = useQuery({
    ...trpc.document.text.queryOptions({ taskId, fileId }),
    enabled: document.kind === 'markdown',
    staleTime: Infinity,
  })
  const read = text.data?.readable ? markdownTitleOf(text.data.text) : null
  return <>{read ?? fallback}</>
}

/** The list of the documents of the chat: pages and texts together, by name, with a search. */
function DocumentList({
  documents,
  agentDocs,
  current,
  onOpen,
}: {
  documents: readonly ChatDocument[]
  agentDocs: readonly string[]
  current: string | null
  onOpen: (name: string) => void
}) {
  const [query, setQuery] = useState('')
  const found = documents.filter((document) =>
    document.title.toLowerCase().includes(query.trim().toLowerCase()),
  )
  return (
    <Box sx={{ p: 1 }}>
      {documents.length + agentDocs.length > 5 ? (
        <InputBase
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={documentText.search}
          inputProps={{ 'aria-label': documentText.search }}
          sx={{
            width: '100%',
            mb: 1,
            px: 1.5,
            minHeight: 40,
            borderRadius: '10px',
            bgcolor: 'var(--mui-palette-action-hover)',
            fontSize: 14,
          }}
        />
      ) : null}
      {agentDocs.length > 0 && query.trim() === '' ? (
        <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {[...agentDocs].reverse().map((docId) => {
            const name = agentDocEntry(docId)
            const here = name === current
            return (
              <li key={name}>
                <Button
                  fullWidth
                  onClick={() => onOpen(name)}
                  aria-current={here ? 'page' : undefined}
                  sx={{
                    justifyContent: 'flex-start',
                    textAlign: 'left',
                    minHeight: 44,
                    px: 1,
                    gap: 1,
                    color: 'text.primary',
                    fontWeight: here ? 600 : 400,
                    bgcolor: here ? 'var(--mui-palette-action-selected)' : undefined,
                  }}
                >
                  <AppIcon name="pages" size={16} />
                  <Box component="span" sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                    <AgentDocTitle docId={docId} />
                    <Box
                      component="span"
                      sx={{ display: 'block', fontSize: 12, color: 'text.secondary' }}
                    >
                      <AgentDocStatus docId={docId} />
                    </Box>
                  </Box>
                </Button>
              </li>
            )
          })}
        </Box>
      ) : null}
      {found.length === 0 ? (
        documents.length === 0 ? null : (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            {documentText.nothingFound}
          </Typography>
        )
      ) : (
        <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {found.map((document) => (
            <li key={document.name}>
              <Button
                fullWidth
                onClick={() => onOpen(document.name)}
                aria-current={document.name === current ? 'page' : undefined}
                sx={{
                  justifyContent: 'flex-start',
                  textAlign: 'left',
                  minHeight: 44,
                  px: 1,
                  gap: 1,
                  color: 'text.primary',
                  fontWeight: document.name === current ? 600 : 400,
                  bgcolor:
                    document.name === current ? 'var(--mui-palette-action-selected)' : undefined,
                }}
              >
                <AppIcon name={document.kind === 'page' ? 'globe' : 'document'} size={16} />
                <Box component="span" sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                  {document.title}
                  <Box
                    component="span"
                    sx={{ display: 'block', fontSize: 12, color: 'text.secondary' }}
                  >
                    {documentText.kind[document.kind]}
                    {document.versions.length > 1
                      ? ` · ${documentText.versions(document.versions.length)}`
                      : ''}
                  </Box>
                </Box>
                {document.fresh ? (
                  <Box component="span" sx={{ fontSize: 12, color: 'primary.main', flexShrink: 0 }}>
                    {documentText.fresh}
                  </Box>
                ) : null}
              </Button>
            </li>
          ))}
        </Box>
      )}
    </Box>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.5,
        p: 3,
        textAlign: 'center',
      }}
    >
      {children}
    </Box>
  )
}

/** A page in the frame of the domain of pages: a fresh address of five minutes for every frame. */
function PageFrame({ taskId, fileId, title }: { taskId: string; fileId: string; title: string }) {
  const trpc = useTRPC()
  const view = useMutation(trpc.document.pageView.mutationOptions())
  const [attempt, setAttempt] = useState(0)
  // The address whose frame has loaded: a new address is loading until its frame says so.
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  const { mutate } = view
  useEffect(() => {
    mutate({ taskId, fileId })
  }, [mutate, taskId, fileId, attempt])
  if (view.isError) {
    const off =
      (view.error as { data?: { domainCode?: string } }).data?.domainCode === 'PAGES_UNAVAILABLE'
    return (
      <Centered>
        <Typography>{off ? documentText.pagesOff : documentText.failed}</Typography>
        {off ? null : (
          <Button variant="outlined" onClick={() => setAttempt((n) => n + 1)}>
            {documentText.retry}
          </Button>
        )}
      </Centered>
    )
  }
  const url = view.data?.url ?? null
  const loaded = url !== null && loadedUrl === url
  return (
    <Box sx={{ flex: 1, position: 'relative', bgcolor: '#fff' }}>
      {url === null || !loaded ? (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <BrandProgress size={28} aria-label={documentText.loading} />
        </Box>
      ) : null}
      {url === null ? null : (
        <Box
          component="iframe"
          // A new address is a new frame: never the old page under a new token.
          key={url}
          src={url}
          title={documentText.frame(title)}
          sandbox={PAGE_SANDBOX}
          referrerPolicy="no-referrer"
          onLoad={() => setLoadedUrl(url)}
          sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
        />
      )}
    </Box>
  )
}

function CopyText({ taskId, fileId }: { taskId: string; fileId: string }) {
  const trpc = useTRPC()
  const text = useQuery({
    ...trpc.document.text.queryOptions({ taskId, fileId }),
    staleTime: Infinity,
  })
  const [copied, setCopied] = useState(false)
  const value = text.data?.readable ? text.data.text : null
  return (
    <>
      <Button
        size="small"
        startIcon={<AppIcon name="copy" size={16} />}
        disabled={value === null}
        onClick={() => {
          if (value === null) return
          void navigator.clipboard?.writeText(value).then(() => setCopied(true))
        }}
        sx={{ minHeight: 40 }}
      >
        {documentText.copy}
      </Button>
      <Box
        role="status"
        aria-live="polite"
        sx={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
        }}
      >
        {copied ? documentText.copied : ''}
      </Box>
    </>
  )
}

interface Heading {
  id: string
  text: string
  level: number
}

/** A text document of the chat, with its table of contents when there is room for it. */
function MarkdownView({
  taskId,
  fileId,
  rowId,
  rows,
  names,
  anchor,
  source,
  contents,
  onDocument,
}: {
  taskId: string
  fileId: string
  rowId: string
  rows: readonly ChatFileRow[]
  names: ReadonlySet<string>
  anchor: string | null
  source: boolean
  contents: boolean
  onDocument: (name: string, anchor: string | null) => void
}) {
  const trpc = useTRPC()
  const text = useQuery({
    ...trpc.document.text.queryOptions({ taskId, fileId }),
    staleTime: Infinity,
  })
  const area = useRef<HTMLDivElement | null>(null)
  const [headings, setHeadings] = useState<Heading[]>([])
  const [active, setActive] = useState<string | null>(null)

  const imageSrc = useCallback(
    (name: string) => {
      const image = chatImageAt(rows, name, rowId)
      return image === null ? null : imageHref(taskId, image.fileId)
    },
    [rows, rowId, taskId],
  )
  const scrollTo = useCallback((id: string) => {
    const target = area.current?.querySelector(`[id="${CSS.escape(id)}"]`)
    target?.scrollIntoView({ block: 'start' })
  }, [])

  const body = text.data?.readable ? text.data.text : null
  // The headings as drawn: their ids are the rules', never counted twice.
  useEffect(() => {
    const element = area.current
    if (element === null || body === null || source) return
    const found = [...element.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id]')].map(
      (heading) => ({
        id: heading.id,
        text: heading.textContent ?? '',
        level: Number(heading.tagName.slice(1)),
      }),
    )
    setHeadings(found)
    if (anchor) scrollTo(`doc-${anchor}`)
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting)
        if (visible[0]) setActive(visible[0].target.id)
      },
      { root: element, rootMargin: '0px 0px -70% 0px' },
    )
    for (const heading of element.querySelectorAll('h1[id], h2[id], h3[id]'))
      observer.observe(heading)
    return () => observer.disconnect()
  }, [body, source, anchor, scrollTo])

  if (text.isPending)
    return (
      <Centered>
        <BrandProgress size={28} aria-label={documentText.loading} />
      </Centered>
    )
  if (text.isError)
    return (
      <Centered>
        <Typography>{documentText.failed}</Typography>
        <Button variant="outlined" onClick={() => void text.refetch()}>
          {documentText.retry}
        </Button>
      </Centered>
    )
  if (!text.data.readable)
    return (
      <Centered>
        <Typography>{documentText.unreadable}</Typography>
        <Link href={taskFileHref(taskId, fileId)} download>
          {documentText.download}
        </Link>
      </Centered>
    )
  const showSource = source || text.data.truncated
  return (
    <Box sx={{ flex: 1, display: 'flex', minWidth: 0 }}>
      <Box ref={area} sx={{ flex: 1, minWidth: 0, overflowY: 'auto', px: { xs: 2, sm: 4 }, py: 3 }}>
        {text.data.truncated ? (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {documentText.large}
          </Typography>
        ) : null}
        {showSource ? (
          <Box
            component="pre"
            sx={{
              m: 0,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              fontFamily: 'var(--raditi-font-mono, ui-monospace, monospace)',
              fontSize: 14,
            }}
          >
            {text.data.text}
          </Box>
        ) : (
          <Box sx={documentSx}>
            <DocumentMarkdown
              text={text.data.text}
              documents={names}
              imageSrc={imageSrc}
              onDocument={onDocument}
              onAnchor={scrollTo}
            />
          </Box>
        )}
      </Box>
      {contents && !showSource ? (
        <Box
          component="nav"
          aria-label={documentText.contents}
          sx={{
            width: 220,
            flexShrink: 0,
            borderLeft: 1,
            borderColor: 'divider',
            overflowY: 'auto',
            p: 1.5,
          }}
        >
          {headings.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              {documentText.noContents}
            </Typography>
          ) : (
            <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
              {headings.map((heading) => (
                <li key={heading.id}>
                  <Link
                    href={`#${heading.id}`}
                    underline="hover"
                    onClick={(event) => {
                      event.preventDefault()
                      scrollTo(heading.id)
                    }}
                    aria-current={active === heading.id ? 'location' : undefined}
                    sx={{
                      display: 'block',
                      py: 0.5,
                      pl: (heading.level - 1) * 1.5,
                      fontSize: 14,
                      color: active === heading.id ? 'primary.main' : 'text.secondary',
                      fontWeight: active === heading.id ? 600 : 400,
                    }}
                  >
                    {heading.text}
                  </Link>
                </li>
              ))}
            </Box>
          )}
        </Box>
      ) : null}
    </Box>
  )
}

/** The look of a text document: a line for reading, real headings, tables that scroll. */
export const documentSx = {
  maxWidth: '72ch',
  mx: 'auto',
  fontSize: 16,
  lineHeight: 1.7,
  overflowWrap: 'anywhere',
  '& > :first-of-type': { mt: 0 },
  '& h1': { fontSize: 30, lineHeight: 1.25, fontWeight: 700, mt: 0, mb: 2 },
  '& h2': { fontSize: 23, lineHeight: 1.3, fontWeight: 650, mt: 4, mb: 1.5 },
  '& h3': { fontSize: 19, fontWeight: 600, mt: 3, mb: 1 },
  '& h4, & h5, & h6': { fontSize: 16, fontWeight: 600, mt: 2.5, mb: 1 },
  '& h1, & h2, & h3, & h4, & h5, & h6': { scrollMarginTop: 16 },
  '& p, & ul, & ol, & pre, & blockquote, & table': { my: 1.5 },
  '& ul, & ol': { pl: 3 },
  '& li + li': { mt: 0.5 },
  '& li:has(> input[type=checkbox])': { listStyle: 'none', ml: -2.5 },
  '& a': { color: 'primary.main' },
  '& [data-host], & [data-image-missing]': { color: 'text.secondary', fontSize: '0.9em' },
  '& [data-missing-document]': { textDecoration: 'underline dotted', cursor: 'help' },
  '& img': { maxWidth: '100%', height: 'auto', borderRadius: '8px' },
  '& code': {
    px: 0.5,
    borderRadius: '6px',
    bgcolor: 'var(--mui-palette-action-hover)',
    fontFamily: 'var(--raditi-font-mono, ui-monospace, monospace)',
    fontSize: '0.9em',
  },
  '& pre': {
    p: 1.5,
    borderRadius: '12px',
    overflowX: 'auto',
    bgcolor: 'var(--mui-palette-action-hover)',
    fontSize: 14,
  },
  '& pre code': { p: 0, bgcolor: 'transparent' },
  '& blockquote': { mx: 0, pl: 2, borderLeft: 3, borderColor: 'divider', color: 'text.secondary' },
  '& table': {
    display: 'block',
    overflowX: 'auto',
    maxWidth: '100%',
    borderCollapse: 'collapse',
    fontSize: 14,
  },
  '& th, & td': { border: 1, borderColor: 'divider', px: 1.25, py: 0.75, textAlign: 'left' },
  '& hr': { border: 0, borderTop: 1, borderColor: 'divider', my: 3 },
  '@media print': { maxWidth: 'none', color: '#000' },
} as const

/** The documents of the latest rows, for the opening of an arrival: names of those after `since`. */
export function documentsAfter(rows: readonly ChatFileRow[], since: string): string[] {
  return chatDocumentsOf(rows)
    .filter((document) => compareFeedIds(document.versions.at(-1)!.rowId, since) > 0)
    .map((document) => document.name)
}
