'use client'

import type { ChatCommandId } from '@repo/domain/release/chat-commands'
import { feedFailureText } from '@repo/domain/tasks/client-feed-failures'
import type { ReasoningEffort } from '@repo/domain/llm/model-class'
import {
  feedFailureKeptText,
  feedInputText,
  feedQuestionText,
  feedStateText,
  taskAnsweredLabel,
  taskFailedLabel,
  taskRewoundLabel,
  taskStatusLabel,
} from '@repo/domain/tasks/client-feed-labels'
import {
  chatDocumentsOf,
  chatFilesOf,
  documentOfFile,
  openingDocumentOf,
} from '@repo/domain/tasks/chat-documents'
import { terminalTaskStatuses } from '@repo/domain/tasks/task-status'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { PanelToggle } from '@/components/application/cabinet-panel'
import { ConfirmDialog } from '@/components/billing/confirm-dialog'
import { MoveToProjectDialog, useMoveToProject } from '@/components/projects/move-to-project'
import { moveText, projectHref } from '@/components/projects/project-texts'
import { useContextMentions } from '@/components/projects/use-context-mentions'
import { ScheduleDialog, type ScheduleDialogOpening } from '@/components/scheduled/schedule-dialog'
import { downloadText } from '@/lib/download-text'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import type { SentFile } from './attachment-chips'
import { BrowserPane } from './browser-pane'
import { sessionLive } from './browser-pane-model'
import { callErrorCode, callErrorText, sendErrorText } from './call-error'
import { newChatHref } from './chat-address'
import { useChatDetails, useChatThinking } from './chat-details'
import { rememberEffort } from './chat-effort'
import type { ChatScheduleLabel, ScheduledTaskItem } from './chat-types'
import {
  cancelText,
  clientCommandText,
  composerText,
  queueText,
  dialogText,
  effortText,
  listText,
  taskWayText,
} from './chat-texts'
import { useClientCommands } from './client-commands'
import { Composer, offScreen } from './composer'
import { DialogMenuButton, dialogListKey, RemoveDialogConfirm, RenameField } from './dialog-actions'
import { DialogNotFound } from './dialog-not-found'
import {
  closedTools,
  movesFocus,
  toolsDot,
  toolsReducer,
  toolsShown,
  toolTabId,
  toolTilesOf,
  type DialogTool,
  type ToolOpener,
} from './dialog-tools'
import { EffortMenu, type EffortMenuHandle } from './effort-menu'
import { FeedList, LiveBlock, type FeedActions } from './feed-list'
import {
  liveSteps,
  openQuestion,
  redoneAfter,
  requestShown,
  stopRequested,
  withoutRedoneRewinds,
} from './feed-model'
import { showsRefresh, type FeedHeadState } from './feed-state'
import {
  RESULTS_ROOM,
  RESULTS_WIDTH,
  ResultsCard,
  ResultsToggle,
  resultCountOf,
  useResultsCard,
  type SideHolds,
} from './results-card'
import { ScheduleMark } from './schedule-mark'
import { TOOLS_BUTTON_ID, TOOLS_MENU_MARK, ToolsMenu } from './tools-menu'
import { TodoCard, TodoStrip, todoStripShows } from './todo-card'
import { ToolsPanel } from './tools-panel'
import { TurnActivity } from './turn-activity'
import { useAttachments } from './use-attachments'
import { useBrowserLaunch } from './use-browser-launch'
import { useChatTodo } from './use-chat-todo'
import { useDocumentArrivals } from './use-document-arrivals'
import {
  agentDocEntry,
  agentDocOfEntry,
  agentDocumentIdsOf,
  DocRevisions,
  docRevisionsOf,
  useAgentDocumentArrivals,
} from './agent-document'
import { DocumentsPane, type DocumentTarget } from './documents-pane'
import { PublishTargetDialog, usePagePublish, type PublishTarget } from './page-publish'
import { useBrowserStream } from './use-browser-stream'
import { useBrowserWatching } from './use-browser-watching'
import { useFeedFollow } from './use-feed-follow'
import { requestHistoryOf } from './prompt-history'
import { QueueCards, useChatQueue } from './queue-cards'
import { useWaitingTitle } from './use-waiting-title'
import { useDialogFeed } from './use-dialog-feed'
import { uuidv7 } from './uuid'
import { UsageWindowHint } from '@/components/billing/usage-window-hint'

/**
 * How long the changed words of «Изменить» wait for core to take the turn back in a chat with the
 * repository, and how often they knock (ВВ25).
 */
const EDIT_WAIT_MS = 120_000
const EDIT_WAIT_STEP_MS = 1_500

// One chat (docs/plan/53-chat-preview-release.md, R9; feed design, «Экраны, которых нет на
// макетах»): its head, its rows, the live block and the field. A chat has no project
// (docs/plan/83-remove-projects.md): a chat with a browser has the browser
// (docs/plan/57-browser-tasks.md), any chat the documents of the agent. Its tools open beside it
// only when the client asks for one (docs/plan/59-dialog-tools-panel.md): by «+» in the corner and
// «Взять управление»; by themselves only once, when the browser of the chat starts while the
// client looks at it. From `lg` they stand at
// the right edge; below, in place of the dialog, «К чату» leading back to it.

/**
 * What a focused element of the feed keeps clear above it (WCAG 2.4.11): below `lg` the head of
 * the dialog sticks to the top of the window — a line of 44px — and a step of 16px, as the landing keeps its anchors from under
 * its header (DESIGN.md, «Шапка»). The room is a margin of the rows and not a padding of the
 * scroller: with a padding, the head itself would count as hidden, and Tab onto it would scroll
 * the page. From `lg` the head stands over the area the feed scrolls in, never over it.
 */
const HEAD_ROOM = '--dialog-head-room'
/** What a focused element of the feed keeps clear below it: the field that sticks to the bottom. */
const FIELD_ROOM = '--dialog-field-room'
/** The step between what sticks over the feed and an element in focus. */
const ROOM_STEP = 16

/**
 * What the focus stands on that the tools take away as they open by themselves (docs/plan/59, И3,
 * И4): «+» of the head and the menu it opened, which go; from `lg` the list of dialogs, which gives
 * the panel its room; below `lg` the whole `dialog`, which the area of the tools takes the place
 * of. null — the focus stands elsewhere, and the opening leaves it there.
 */
function focusTakenByOpening(dialog: Element | null): Element | null {
  const active = document.activeElement
  if (active === null || active === document.body) return null
  const taken =
    active.id === TOOLS_BUTTON_ID ||
    active.closest(`[${TOOLS_MENU_MARK}]`) !== null ||
    (dialog === null ? active.closest('[data-chat-list]') !== null : dialog.contains(active))
  return taken ? active : null
}

/** What a press of the client sends: one id per press, kept for its repeats. */
type Press = 'message' | 'continue' | 'cancel' | 'resume' | 'compact' | 'undoTurn' | 'redoTurn'

/**
 * The head of a dialog (owner's request of 26.10.2026): one quiet line — its name, its menu
 * («Переименовать», «Удалить») and, while the panel of its tools is closed, «+» of the tools in the
 * corner (docs/plan/59, И4). The name is written in place of itself.
 */
function DialogHead({
  schedule,
  taskId,
  title,
  head,
  onRenamed,
  tools,
  results = null,
}: {
  /** The task this chat is a run of (docs/plan/82-scheduled-tasks.md, Зп43); null — none. */
  schedule: ChatScheduleLabel | null
  taskId: string
  title: string
  head: FeedHeadState | null
  onRenamed: () => void
  /** «+» of the tools while their panel is closed; null — it stands at the end of the tabs. */
  tools: ReactNode
  /** The icon that hides and shows «Результаты»; null — the chat has none to show. */
  results?: ReactNode
}) {
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const move = useMoveToProject()
  // «Проект «X» / название чата» (docs/plan/84-projects.md, ПР6).
  const project = head?.task.project ?? null
  return (
    <Box
      component="header"
      sx={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        alignItems: 'center',
        columnGap: 1.5,
        rowGap: 1,
        // From `lg` as high as the strip of the panel's tabs: «+» keeps its corner (И4).
        minHeight: { xs: 44, lg: 56 },
        minWidth: 0,
      }}
    >
      <Box sx={{ gridColumn: 1, gridRow: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>
        {/* The list of chats is hidden: the way back to it starts the line of the name (Н3). */}
        <Box
          sx={{
            flex: 'none',
            ml: -1.5,
            mr: 0.5,
            display: { xs: 'none', md: 'flex' },
            '&:empty': { display: 'none' },
          }}
        >
          <PanelToggle place="content" />
        </Box>
        {renaming ? (
          <RenameField
            taskId={taskId}
            initial={head?.task.title ?? ''}
            fontSize={15}
            onDone={(saved) => {
              setRenaming(false)
              if (saved !== null) onRenamed()
            }}
          />
        ) : (
          <Box sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <Box
              sx={{
                flex: '1 1 auto',
                minWidth: 0,
                display: 'flex',
                alignItems: 'baseline',
                gap: 1,
              }}
            >
              {project !== null ? (
                <Box
                  component="span"
                  sx={{ flex: '0 1 auto', minWidth: 0, display: 'flex', gap: 1, fontSize: 15 }}
                >
                  <Box
                    component={Link}
                    href={projectHref(project.id)}
                    title={project.name}
                    data-chat-project=""
                    sx={{
                      minWidth: 0,
                      maxWidth: { xs: 120, sm: 240 },
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: 'text.secondary',
                      textDecoration: 'none',
                      borderRadius: '6px',
                      '&:hover': { color: 'text.primary', textDecoration: 'underline' },
                      '&:focus-visible': {
                        outline: '2px solid',
                        outlineColor: 'primary.main',
                        outlineOffset: 2,
                      },
                    }}
                  >
                    {moveText.crumb(project.name)}
                  </Box>
                  <Box component="span" aria-hidden="true" sx={{ color: 'text.secondary' }}>
                    /
                  </Box>
                </Box>
              ) : null}
              <Typography
                component="h1"
                title={title}
                sx={{
                  minWidth: 0,
                  fontSize: 15,
                  fontWeight: 500,
                  lineHeight: 1.4,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {title}
              </Typography>
            </Box>
            {/* A run of a scheduled task: how it began and its task, under the name (Зп43). */}
            {schedule !== null ? <ScheduleMark schedule={schedule} chatTitle={title} /> : null}
          </Box>
        )}
      </Box>
      <Box
        sx={{
          gridColumn: 2,
          gridRow: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 0.5,
        }}
      >
        {results}
        {head !== null && !renaming ? (
          <DialogMenuButton
            title={title}
            onRename={() => setRenaming(true)}
            onRemove={() => setRemoving(true)}
            project={{
              inProject: project !== null,
              onMove: () => {
                setMoveError(null)
                setMoving(true)
              },
              onTakeOut: () => {
                setMoveError(null)
                void move.to(taskId, null).then((refused) => {
                  setMoveError(refused)
                  if (refused === null) onRenamed()
                })
              },
            }}
          />
        ) : null}
        {tools}
      </Box>
      {moveError !== null ? (
        <Typography
          role="alert"
          variant="body2"
          color="error.main"
          sx={{ gridColumn: '1 / -1', gridRow: 2 }}
        >
          {moveError}
        </Typography>
      ) : null}
      {moving ? (
        <MoveToProjectDialog
          taskId={taskId}
          title={title}
          currentProjectId={project?.id ?? null}
          open
          onClose={() => setMoving(false)}
          onMoved={onRenamed}
        />
      ) : null}
      {removing ? (
        <RemoveDialogConfirm taskId={taskId} open onClose={() => setRemoving(false)} />
      ) : null}
    </Box>
  )
}

/**
 * The dialog itself. Its state comes from `task.feed`, read again and again while the page is
 * shown; whatever the client writes or presses is read back at once.
 */
export function DialogView({
  schedule = null,
  userId = null,
  taskId,
  title,
  browserStreamUrl = null,
  speech = false,
}: {
  /**
   * The scheduled task the chat is a run of, from `task.get` (docs/plan/82-scheduled-tasks.md,
   * Зп43); null — an ordinary chat.
   */
  schedule?: ChatScheduleLabel | null
  /**
   * The signed-in client: the window of a scheduled task keeps its draft by them; null — the cards
   * of the feed open no window and lead to «Расписание» instead.
   */
  userId?: string | null
  taskId: string
  title: string | null
  /**
   * Where the cabinet opens the stream of a task's browser (`BROWSER_STREAM_PUBLIC_URL`,
   * docs/plan/57-browser-tasks.md, Б12); null — the platform has no browser here.
   */
  browserStreamUrl?: string | null
  /** Dictation is set up here (docs/plan/75-chat-input-output.md, ВВ16). */
  speech?: boolean
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { state, refresh } = useDialogFeed(taskId)
  const head = state.head
  const rows = state.rows
  // The client's earlier requests of this chat: the arrows of the field bring them back (ВВ23).
  const requestHistory = useMemo(() => requestHistoryOf(rows), [rows])

  // The tools beside the dialog, as the client opened them (docs/plan/59, И1): every showing of a
  // dialog starts with them closed — with changes ready and with a browser at work too — and
  // nothing of them is kept for the next one.
  const [tools, dispatchTools] = useReducer(toolsReducer, closedTools)
  // From `lg` the tools stand beside the dialog; below, an open one takes its place (И14).
  const theme = useTheme()
  const wide = useMediaQuery(theme.breakpoints.up('lg'))
  // Said to a screen reader: the server took a new level, the file of the chat was saved.
  const [note, setNote] = useState('')
  /** The window of a scheduled task the cards of the feed open (Зп35); null — closed. */
  const [scheduleOpening, setScheduleOpening] = useState<ScheduleDialogOpening | null>(null)
  const effortMenu = useRef<EffortMenuHandle>(null)
  const { details } = useChatDetails()
  const { thinking } = useChatThinking()
  // The level chosen here, shown while the head still says the level it was chosen over.
  const [effortChosen, setEffortChosen] = useState<{
    effort: ReasoningEffort
    over: ReasoningEffort | undefined
  } | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)
  // Why the server refused the last thing written or pressed: one sentence under the field.
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)
  // The browser of the task over the whole area of the content (the rail stays).
  const [fullscreen, setFullscreen] = useState(false)
  const pane = useRef<HTMLElement | null>(null)
  const root = useRef<HTMLDivElement | null>(null)
  // The dialog opens at its latest words and follows what arrives, as a chat does.
  const feedArea = useRef<HTMLDivElement | null>(null)
  const feedContent = useRef<HTMLDivElement | null>(null)
  useFeedFollow(feedArea, feedContent)
  // The field sticks to the bottom on every width, as high as what it holds now — a draft of many
  // lines, files, a refusal under it: the rows of the feed keep that much clear below them, so
  // that Tab down the feed never lands under it (WCAG 2.4.11).
  const field = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const box = field.current
    const area = feedArea.current
    if (box === null || area === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() =>
      area.style.setProperty(
        FIELD_ROOM,
        `${Math.ceil(box.getBoundingClientRect().height) + ROOM_STEP}px`,
      ),
    )
    observer.observe(box)
    return () => observer.disconnect()
  }, [])
  const clientCommands = useClientCommands({ taskId, anchor: field })
  // The words `/undo` gave back, and what the field holds now: a draft is never written over.
  const [undoneWords, setUndoneWords] = useState<string | null>(null)
  // How many times `/redo` took the words away: they leave the field then, or sending them would
  // ask again over the turn that came back (§5.14).
  const [wordsTaken, setWordsTaken] = useState(0)
  // The press of `/redo` whose turn takes those words back: they leave the field once it is.
  const [redoPress, setRedoPress] = useState<string | null>(null)
  const fieldText = useRef('')
  const fieldTextChanged = useCallback((text: string) => {
    fieldText.current = text
    // They left the field: the next `/undo` may bring the same words back.
    setUndoneWords((words) => (words === text ? words : null))
  }, [])

  const message = useMutation(trpc.task.message.mutationOptions())
  // The queue of the chat (docs/plan/75-chat-input-output.md, ВВ1): words written while it works.
  const queueAdd = useMutation(trpc.task.queueAdd.mutationOptions())
  const agentWorks =
    head?.task.status === 'queued' ||
    head?.task.status === 'preparing' ||
    head?.task.status === 'running'
  const chatQueue = useChatQueue(taskId, agentWorks)
  // The tab says the chat waits while it is hidden (docs/plan/75, ВВ11).
  useWaitingTitle(head?.task.status ?? null)
  const queued = chatQueue.data?.items ?? []
  const proceed = useMutation(trpc.task.continue.mutationOptions())
  const cancel = useMutation(trpc.task.cancel.mutationOptions())
  // «Опубликовать как страницу» of a document of the chat (docs/plan/69-pages.md, Ст32): to its
  // owner or an administrator, where pages are set up.
  const canPublishPages = useQuery(trpc.pages.canPublish.queryOptions({ taskId }))
  const publishFile = useMutation(trpc.pages.publishFile.mutationOptions())
  const publication = usePagePublish()
  // The file whose target the client is choosing (docs/plan/73-pages-sites.md, Дер9): a new page,
  // or the next version of a page of the workspace.
  const [publishing, setPublishing] = useState<{
    fileId: string
    name: string
    title: string
  } | null>(null)
  // Read afresh each time the window opens: a page published a moment ago is a target too.
  const targets = useQuery({
    ...trpc.pages.targets.queryOptions({ taskId }),
    enabled: publishing !== null,
    staleTime: 0,
  })
  function publishTo(target: PublishTarget) {
    if (publishing === null || publication.pending) return
    const { fileId } = publishing
    // The window waits for the publication («Публикуем…»), then gives way to its outcome.
    void publication
      .publish(() => publishFile.mutateAsync({ taskId, fileId, target }))
      .finally(() => setPublishing(null))
  }
  const resumeAgent = useMutation(trpc.task.resumeAgent.mutationOptions())
  const compact = useMutation(trpc.task.compact.mutationOptions())
  const undoTurn = useMutation(trpc.task.undoTurn.mutationOptions())
  const redoTurn = useMutation(trpc.task.redoTurn.mutationOptions())
  if (undoneWords !== null && redoPress !== null && redoneAfter(rows, redoPress)) {
    setUndoneWords(null)
    setRedoPress(null)
    setWordsTaken((times) => times + 1)
  }
  const setEffort = useMutation(trpc.task.setEffort.mutationOptions())
  const busy =
    undoTurn.isPending ||
    redoTurn.isPending ||
    proceed.isPending ||
    cancel.isPending ||
    resumeAgent.isPending ||
    compact.isPending

  // What the chat works with (docs/plan/61-chats-first.md, §5.6).
  const withBrowser = head?.task.requirements.browser === true
  const browserLive = withBrowser && sessionLive(head?.browser ?? null)
  // The stream goes while the tab of the browser is on the screen, beside the dialog or in its
  // place; a press of «Взять управление» or «Продолжить работу агента» opens it for that press alone
  // (docs/plan/59, И11). Nothing of it before the client asked for the browser.
  const shown = toolsShown(tools)
  const browserShown = shown && tools.active === 'browser'
  const stream = useBrowserStream({
    taskId,
    streamUrl: browserStreamUrl,
    live: browserLive,
    visible: browserShown,
  })
  // The browser of the task started while the client looks at the dialog (И2, И3): it opens once,
  // on any width — beside the dialog from `lg`, in its place below (owner's answer of 30.10.2026).
  // Never by the words of the agent, and not where the cabinet cannot show the browser. Nobody
  // pressed anything, so the focus stays where it is — unless it stood on what this very opening
  // takes away (`focusTakenByOpening`): then «+» takes it, in the same corner (И4), and it is never
  // dropped to the start of the page. A launch that opens nothing — spent, or the browser joining
  // the tabs of a panel on the screen, which stays as it was — moves nothing.
  const heldAtLaunch = useRef<Element | null>(null)
  const launched = useCallback(() => {
    const opens = !toolsShown(tools) && toolsShown(toolsReducer(tools, { type: 'launch' }))
    heldAtLaunch.current = opens ? focusTakenByOpening(wide ? null : root.current) : null
    dispatchTools({ type: 'launch' })
  }, [tools, wide])
  useEffect(() => {
    const held = heldAtLaunch.current
    heldAtLaunch.current = null
    if (held === null || !shown) return
    // Gone with «+» of the head and its menu, or hidden with the list or the dialog.
    if (!held.isConnected || held.getClientRects().length === 0)
      document.getElementById(TOOLS_BUTTON_ID)?.focus()
  }, [shown])
  // The pages and text documents of the agent (docs/plan/67-agent-documents.md, Д4): one that comes
  // while the client looks at the chat opens «Документы» on it — beside the dialog from `lg`, never
  // in its place below: there only «+» says so.
  const chatDocuments = useMemo(() => chatDocumentsOf(rows), [rows])
  const [documentTarget, setDocumentTarget] = useState<DocumentTarget | null>(null)
  const openDocument = useCallback((name: string, fileId: string | null) => {
    setDocumentTarget((before) => ({ name, fileId, seq: (before?.seq ?? 0) + 1 }))
  }, [])
  useDocumentArrivals(rows, head !== null, (names) => {
    const name = openingDocumentOf(names)
    if (name === null) return
    // The tab shows what came, whether it opens now or later; its history keeps what was before.
    openDocument(name, null)
    dispatchTools({ type: 'documentArrived', opens: wide })
  })
  // The documents the agent writes section by section (docs/plan/74, Д5): one it begins while the
  // client looks at the chat opens the tab on it, as a file does, and fills there as it is written.
  const agentDocs = useMemo(
    () => agentDocumentIdsOf(rows as readonly { type: string; docId?: string }[]),
    [rows],
  )
  const docRevisions = useMemo(
    () => docRevisionsOf(rows as readonly { type: string; docId?: string; revision?: number }[]),
    [rows],
  )
  useAgentDocumentArrivals(agentDocs, head !== null, (docId) => {
    openDocument(agentDocEntry(docId), null)
    dispatchTools({ type: 'documentArrived', opens: wide })
  })
  const documentCount = chatDocuments.length + agentDocs.length
  // «Результаты» name the other files the agent left too — a Word file, a PDF —: a chat whose
  // result is such a file shows it there, and the card is never drawn without a line.
  const chatFiles = useMemo(() => chatFilesOf(rows), [rows])
  const resultCount = resultCountOf({ agentDocs, documents: chatDocuments, files: chatFiles })
  // «План работы» (docs/plan/89-agent-todos.md): the agent's to-do list of the last turn. `/undo`
  // and `/redo` change which turn is last with no new status: their newest row reads it again.
  const lastRewind = useMemo(
    () => rows.findLast((row) => row.type === 'feed.rewind' || row.type === 'feed.redo')?.id,
    [rows],
  )
  const todo = useChatTodo(taskId, head?.task.status, head?.task.turnNo, lastRewind)
  /** `/undo` or `/redo` taken: the plan of the turn now last is read at once. */
  const rereadTodo = () =>
    void queryClient.invalidateQueries({ queryKey: trpc.task.todo.queryKey({ taskId }) })
  // The column beside the chat — «План работы» over «Результаты» (owner's request of 14.11.2026;
  // docs/plan/89, ТД6): from `lg`, while the area of the feed is wide enough and the client has
  // not hidden it. A plan brings it in a chat with no documents too.
  const results = useResultsCard(feedArea, wide && (resultCount > 0 || todo !== null))
  const sideHolds: SideHolds = todo === null ? 'results' : resultCount > 0 ? 'both' : 'plan'
  useBrowserLaunch(head, {
    taskId,
    enabled: withBrowser && browserStreamUrl !== null,
    onLaunch: launched,
  })
  // The chat counts as watching the browser (И18; owner's answer of 30.10.2026): while the dialog
  // is on the screen its browser does not close for idle, the panel open or not.
  useBrowserWatching({ taskId, enabled: browserLive })
  const attachments = useAttachments()
  // `@` in a chat of a project names the files of its context (docs/plan/84-projects.md, ПР24).
  const mentions = useContextMentions(head?.task.project?.id ?? null)
  // The names of the files the messages sent: read once a message has one.
  const sentIds = rows.flatMap((row) =>
    row.type === 'feed.request' && 'attachments' in row && Array.isArray(row.attachments)
      ? row.attachments
      : [],
  )
  const sentFiles = useQuery({
    ...trpc.attachment.list.queryOptions({ taskId }),
    enabled: sentIds.length > 0,
  })
  // A message sent since the list was read names files it does not have yet — this tab's own or
  // one from another tab: the list is read again. Once for the same missing files: one still
  // missing after it does not loop (a file bound to a message never leaves the list).
  const listed = sentFiles.data
  const unlisted =
    listed === undefined
      ? ''
      : sentIds.filter((id) => !listed.some((file) => file.id === id)).join()
  const refetchSent = sentFiles.refetch
  useEffect(() => {
    if (unlisted !== '') void refetchSent()
  }, [unlisted, refetchSent])

  // One id per press, kept for its repeats while nothing says the server has taken it: a repeat
  // after a lost answer writes nothing. Words get an id of their own: other words are another
  // message. An id the feed shows, or one of a dialog that has moved on since, is forgotten — the
  // next press is a new one and is never taken for a repeat of it.
  const presses = useRef(new Map<Press, { id: string; text: string | null }>())
  const pressId = (press: Press, text: string | null = null) => {
    const known = presses.current.get(press)
    if (known && known.text === text) return known.id
    const id = uuidv7()
    presses.current.set(press, { id, text })
    return id
  }
  const pressed = (press: Press) => presses.current.delete(press)
  useEffect(() => {
    for (const [press, { id }] of presses.current)
      if (requestShown(rows, id)) presses.current.delete(press)
  }, [rows])

  const status = head?.task.status
  const question = openQuestion(rows, status)
  const terminal = status !== undefined && terminalTaskStatuses.includes(status)
  // `/cancel` was taken while the agent works: core stops it, and it is not asked twice — the
  // agent is still at work until then, as the list says of the command. A chat with a browser is
  // stopped by core while it waits for the client too, with its changes as well: it takes no words
  // or presses meanwhile.
  const stopping =
    !terminal && (stopRequested(rows, status, withBrowser) || cancel.data?.state === 'stopping')
  // A driver without the compaction: the command is not there, closed or not (§5.14).
  const verdicts = (head?.commands ?? []).filter((command) => command.refusal !== 'no_compaction')
  const commands = stopping
    ? verdicts.map((command) =>
        command.id === 'cancel'
          ? { id: command.id, available: false, refusal: 'busy' as const }
          : command,
      )
    : verdicts

  // A dialog whose status changed: the list follows it, the credits it set aside or gave back
  // are read again, and no press of before is repeated.
  const shownStatus = useRef<string | null>(null)
  useEffect(() => {
    if (status === undefined) return
    if (shownStatus.current !== null && shownStatus.current !== status) {
      presses.current.clear()
      void queryClient.invalidateQueries({ queryKey: dialogListKey })
      void queryClient.invalidateQueries({ queryKey: trpc.billing.usage.queryKey() })
    }
    shownStatus.current = status
  }, [status, queryClient, trpc])

  // The live region says the status as it changes: a question, a result and a failure each come
  // with a status of their own. Not every stage and not the timer. A failure after which an old
  // chat kept its changes leaves the status «Ждёт вашего решения» as it was: the failure is said
  // instead.
  const last = rows.at(-1)
  const keptFailure =
    status === 'awaiting_approval' &&
    last?.type === 'feed.failure' &&
    last.next === 'awaiting_approval'
      ? last
      : null
  // The agent answered and asked nothing: the dialog waits for no one (26.10.2026). A failure
  // that left the dialog open (28.10.2026) asks the client again: «продолжи».
  const ending = withoutRedoneRewinds(rows).findLast(
    (row) =>
      row.type === 'feed.result' || row.type === 'feed.failure' || row.type === 'feed.rewind',
  )
  const answered =
    status === 'awaiting_user' && question === null && ending?.type !== 'feed.failure'
  // `/undo` leaves the dialog open as an answer does, and takes that answer back.
  const rewound = answered && ending?.type === 'feed.rewind'
  // A failure that left the dialog open asks nothing to confirm (06.11.2026): it reads «Ошибка».
  const openFailure =
    status === 'awaiting_user' && question === null && ending?.type === 'feed.failure'
  const announcement =
    status === undefined
      ? ''
      : keptFailure !== null
        ? `${feedFailureText[keptFailure.code]} ${feedFailureKeptText}`
        : rewound
          ? taskRewoundLabel
          : answered
            ? taskAnsweredLabel
            : openFailure
              ? taskFailedLabel
              : taskStatusLabel[status]

  /** The focus goes to the tab of a tool: what moved it is gone or behind. */
  function focusSoon(id: string) {
    window.setTimeout(() => document.getElementById(id)?.focus(), 0)
  }

  /**
   * The focus once no tool stands open: on «+» where it stands, the page left where it is — the head
   * keeps «+» in sight as it sticks, and in a window lower than 420px, where the head goes with the
   * page, the feed comes back where the client read it rather than at the head (И19). A chat left
   * with no tool has no «+» (К19): the field takes it then, or what still works there when it is
   * closed, so that the focus is never dropped to the start of the page.
   */
  function focusBackSoon() {
    window.setTimeout(() => {
      const target =
        document.getElementById(TOOLS_BUTTON_ID) ??
        field.current?.querySelector<HTMLElement>('textarea:enabled, button:enabled')
      target?.focus({ preventScroll: true })
    }, 0)
  }

  /**
   * The one way a tool opens at the client's press (docs/plan/59, И9): «+» and «Взять управление» —
   * never the words of the agent; the launch of the browser is an action of its own (`launched`).
   * An open tool is shown again, never twice. An explicit opening puts the focus on the tab of the tool, unless the action
   * keeps a place of its own and that place stays in sight: below `lg` the first tool takes the
   * place of the dialog, and the button pressed there goes out of sight with it (И14).
   */
  function openTool(tool: DialogTool, { by }: { by: ToolOpener }) {
    const covers = !wide && !shown
    dispatchTools({ type: 'open', tool, by })
    leaveFullscreenFor(tool)
    if (movesFocus(by, { covers })) focusSoon(toolTabId(tool))
  }

  /** The browser and the documents go over the content: both are the tools there are. */
  function leaveFullscreenFor(_tool: DialogTool) {}

  /** A tab chosen on the strip of the panel. */
  function showTool(tool: DialogTool) {
    dispatchTools({ type: 'show', tool })
    leaveFullscreenFor(tool)
  }

  /**
   * The cross of a tab, or Delete on it. Closing only hides (И8): the task, the session of its
   * browser and the control stay as they are, nothing is sent. The browser over the content goes
   * with it (И17); the focus goes to the tab shown instead, or to «+» after the last one.
   */
  function closeTool(tool: DialogTool) {
    const next = toolsReducer(tools, { type: 'close', tool })
    dispatchTools({ type: 'close', tool })
    setFullscreen(false)
    if (next.active === null) focusBackSoon()
    else focusSoon(toolTabId(next.active))
  }

  /**
   * «Скрыть панель»: every tab at once, nothing sent either; the focus back on «+» in the head, the
   * feed where the client read it (И8, И19).
   */
  function closeTools() {
    dispatchTools({ type: 'closeAll' })
    setFullscreen(false)
    focusBackSoon()
  }

  /**
   * «К чату» below `lg` (И14, owner's answer of 30.10.2026): the tab on the screen closes, the
   * other open ones stay behind the dialog for «+»; the dialog comes back where the client read it,
   * the focus on «+» in its head (И19).
   */
  function backToDialog() {
    dispatchTools({ type: 'back' })
    setFullscreen(false)
    focusBackSoon()
  }

  /** «Размышление» of the dialog: from the agent's next turn (`task.setEffort`). */
  async function changeEffort(effort: ReasoningEffort) {
    setFieldError(null)
    setNote('')
    setEffortChosen({ effort, over: head?.task.effort })
    try {
      await setEffort.mutateAsync({ taskId, effort })
      // The next new chat starts with it too (owner's request of 09.11.2026).
      rememberEffort(effort)
      setNote(effortText.changed)
    } catch (failure) {
      setEffortChosen(null)
      setFieldError(callErrorText(failure))
    }
    refresh()
  }

  // A repeat that the server answers `repeated` is the same words written before (the id is of
  // these very words): they are in the dialog, and the field is cleared like after a first send.
  async function send(text: string, attachmentIds: readonly string[] = []): Promise<boolean> {
    setFieldError(null)
    // Files go with the messages of any chat: to the browser's pages, or to the agent's inbox.
    const files = [...attachmentIds]
    // While the agent works the words wait in the queue (ВВ1); a pass that ended meanwhile takes
    // them as a message.
    if (agentWorks) {
      try {
        await queueAdd.mutateAsync({
          taskId,
          requestId: pressId('message', `${text}\u0000${files.join(',')}`),
          text,
          ...(files.length > 0 ? { attachments: files } : {}),
        })
        pressed('message')
        void chatQueue.refetch()
        return true
      } catch (failure) {
        if (callErrorCode(failure) !== 'TASK_NOT_BUSY') {
          setFieldError(sendErrorText(failure))
          refresh()
          return false
        }
      }
    }
    try {
      await message.mutateAsync({
        taskId,
        // Other files with the same words are another message.
        requestId: pressId('message', `${text}\u0000${files.join(',')}`),
        text,
        ...(files.length > 0 ? { attachments: files } : {}),
      })
      pressed('message')
      refresh()
      return true
    } catch (failure) {
      setFieldError(sendErrorText(failure))
      refresh()
      return false
    }
  }

  async function press(
    which: Exclude<Press, 'message' | 'cancel'>,
    mutate: (input: { taskId: string; requestId: string }) => Promise<unknown>,
  ) {
    setFieldError(null)
    try {
      await mutate({ taskId, requestId: pressId(which) })
      pressed(which)
      // «Продолжить» sets credits aside for the next attempt.
      if (which === 'continue')
        void queryClient.invalidateQueries({ queryKey: trpc.billing.usage.queryKey() })
      refresh()
      return true
    } catch (failure) {
      setFieldError(callErrorText(failure))
      // A refusal says the verdicts changed: the commands are read again with the dialog.
      refresh()
      return false
    }
  }

  /** `/undo`: the agent forgets the last request, and its words come back to the field (§5.14). */
  async function pressUndoTurn() {
    setFieldError(null)
    try {
      const { words } = await undoTurn.mutateAsync({
        taskId,
        requestId: pressId('undoTurn'),
      })
      pressed('undoTurn')
      rereadTodo()
      if (words !== null && fieldText.current.trim() === '') setUndoneWords(words)
    } catch (failure) {
      setFieldError(callErrorText(failure))
    }
    refresh()
  }

  /**
   * «Изменить» of the last message, sent changed (ВВ25): `/undo` takes its turn back, then the new
   * words go as a message; while the turn is still being taken back they wait for it
   * (TASK_REWINDING). Words that could not go stay in the field, nothing is lost.
   */
  async function sendEdited(text: string): Promise<boolean> {
    setFieldError(null)
    try {
      await undoTurn.mutateAsync({ taskId, requestId: pressId('undoTurn') })
      pressed('undoTurn')
      rereadTodo()
    } catch (failure) {
      setFieldError(callErrorText(failure))
      refresh()
      return false
    }
    refresh()
    const requestId = pressId('message', `${text}\u0000`)
    for (let waited = 0; ; waited += EDIT_WAIT_STEP_MS) {
      try {
        await message.mutateAsync({ taskId, requestId, text })
        pressed('message')
        refresh()
        return true
      } catch (failure) {
        if (callErrorCode(failure) !== 'TASK_REWINDING' || waited >= EDIT_WAIT_MS) {
          setFieldError(sendErrorText(failure))
          // The turn is taken back already: the new words wait in the field to be sent by hand.
          const kept = fieldText.current.trim() === ''
          if (kept) setUndoneWords(text)
          refresh()
          return kept
        }
        await new Promise((resolve) => setTimeout(resolve, EDIT_WAIT_STEP_MS))
      }
    }
  }

  /**
   * `/redo`: the turn comes back, and with it the words `/undo` put into the field: sent, they would
   * ask a second time. Words the client changed are theirs by now, and they stay.
   */
  async function pressRedoTurn() {
    setFieldError(null)
    try {
      const { words, requestEventId } = await redoTurn.mutateAsync({
        taskId,
        requestId: pressId('redoTurn'),
      })
      pressed('redoTurn')
      rereadTodo()
      if (words !== null && words === undoneWords) setRedoPress(requestEventId)
    } catch (failure) {
      setFieldError(callErrorText(failure))
    }
    refresh()
  }

  async function confirmCancel() {
    setCancelError(null)
    try {
      await cancel.mutateAsync({ taskId, requestId: pressId('cancel') })
      pressed('cancel')
      setCancelOpen(false)
    } catch (failure) {
      setCancelError(callErrorText(failure))
    }
    refresh()
  }

  /**
   * «Взять управление»: the browser is shown — opened if the client had not — and the stream asks
   * for the control (docs/plan/59, И12). The focus stays where the browser's panel puts it, or, on
   * a narrow screen where the browser now covers the card it was pressed on, goes to its tab.
   */
  function takeControl() {
    setFieldError(null)
    openTool('browser', { by: 'take' })
    stream.take()
  }

  /**
   * «Продолжить работу агента» (Б16): a turn that runs gets the browser back on the stream; a
   * task that waits goes on with the same attempt (`task.resumeAgent`).
   */
  function resumeWork() {
    // A question the client acted on goes back to the agent; without one — the agent answered
    // and waits for nothing (26.10.2026) — the client only gives the browser back.
    if (status === 'awaiting_user' && question !== null)
      void press('resume', resumeAgent.mutateAsync)
    else stream.release()
  }

  // Esc leaves the browser over the content — unless the page itself is being typed into.
  useEffect(() => {
    if (!fullscreen) return
    // The list of dialogs and the way back to it are under the browser too:
    // out of the tab order while it covers them (WCAG 2.4.11), as the dialog's own column is.
    const covered = [
      ...(pane.current
        ?.closest('[data-chat-shell]')
        ?.querySelectorAll('[data-chat-list], [data-chat-back]') ?? []),
    ].filter((element) => !root.current?.contains(element))
    for (const element of covered) element.setAttribute('inert', '')
    const leave = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== 'Escape' || target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT')
        return
      setFullscreen(false)
    }
    window.addEventListener('keydown', leave)
    return () => {
      window.removeEventListener('keydown', leave)
      for (const element of covered) element.removeAttribute('inert')
    }
  }, [fullscreen])

  /** `/export`: the server writes the chat out, the browser saves it (§5.14). */
  async function exportChat() {
    setNote('')
    try {
      const file = await queryClient.fetchQuery({
        ...trpc.task.export.queryOptions({ taskId }),
        // Read anew on every press, and not kept on the page afterwards.
        staleTime: 0,
        gcTime: 0,
      })
      downloadText(file.fileName, file.markdown, 'text/markdown;charset=utf-8')
      setNote(clientCommandText.exported)
    } catch (failure) {
      setFieldError(callErrorText(failure))
    }
  }

  function runCommand(id: ChatCommandId): string | undefined {
    setFieldError(null)
    switch (id) {
      case 'compact':
        void press('compact', compact.mutateAsync)
        return
      case 'turn_undo':
        void pressUndoTurn()
        return
      case 'turn_redo':
        void pressRedoTurn()
        return
      case 'cancel':
        setCancelError(null)
        setCancelOpen(true)
        return
      case 'models':
        effortMenu.current?.open()
        return
      case 'export':
        void exportChat()
        return
      case 'new':
      case 'sessions':
      case 'usage':
      case 'status':
      case 'context':
      case 'details':
      case 'thinking':
      case 'themes':
        return clientCommands.run(id)
      // `/help` is the field's.
      default:
        id satisfies 'help'
        return
    }
  }

  const actions: FeedActions = {
    taskId,
    onStop: () => runCommand('cancel'),
    onOpenDocument: (fileId) => {
      const document = documentOfFile(chatDocuments, fileId)
      if (document === null) return
      openDocument(document.name, fileId)
      openTool('documents', { by: 'menu' })
    },
    onOpenAgentDocument: (docId) => {
      openDocument(agentDocEntry(docId), null)
      openTool('documents', { by: 'menu' })
    },
    shownAgentDocument:
      shown && tools.active === 'documents' && documentTarget
        ? agentDocOfEntry(documentTarget.name)
        : null,
    onContinue: () => void press('continue', proceed.mutateAsync),
    onTakeControl: takeControl,
    onResumeAgent: resumeWork,
    // «Изменить»: the words are changed in place, and only «Отправить» takes the turn back (ВВ25).
    onEditLast: sendEdited,
    // The client holds the control of a browser that is there: a closed session holds nothing.
    controlling: head?.browser?.controller === 'user' && browserLive,
    browserLive,
    busy,
    stopping,
    // The window of a scheduled task over the chat (docs/plan/82-scheduled-tasks.md, Зп35).
    ...(userId !== null
      ? {
          onEditSchedule: (task: ScheduledTaskItem) =>
            setScheduleOpening({ kind: 'edit', schedule: task }),
          onNewSchedule: () => setScheduleOpening({ kind: 'new' }),
        }
      : {}),
  }
  const sentFilesOf = (ids: readonly string[]): SentFile[] =>
    ids.map((id) => {
      const known = sentFiles.data?.find((file) => file.id === id)
      return {
        id,
        name: known?.name ?? null,
        size: known?.size ?? null,
        kind: known?.kind ?? 'document',
      }
    })

  if (state.missing) return <DialogNotFound />

  const shownTitle = head?.task.title ?? title ?? listText.untitled
  const awaitingClient = status === 'awaiting_user' || status === 'awaiting_approval'
  // Once the head says another level than the one chosen over, the head is right.
  const effort =
    effortChosen !== null && effortChosen.over === head?.task.effort
      ? effortChosen.effort
      : (head?.task.effort ?? 'high')
  // «Размышление» in the row of the field (owner's requests of 26.10.2026): the level holds from
  // the agent's next turn.
  const settings =
    head === null ? null : (
      <EffortMenu
        value={effort}
        onChange={(next) => void changeEffort(next)}
        // The level holds from the agent's next turn: it is changed while the dialog waits.
        disabled={!awaitingClient || setEffort.isPending}
        lockedText={terminal ? effortText.ended : effortText.locked}
        handle={effortMenu}
      />
    )
  const composerCommands = {
    verdicts: commands,
    onRun: runCommand,
    onOpen: refresh,
    plain: true,
  }
  // The reminder of the field names «Настройки → Переменные» (docs/plan/83-remove-projects.md,
  // БП4): an ended chat reads it from its closed field too.
  const noSecrets = taskWayText.noSecrets
  let composer
  if (head === null) composer = null
  else if (terminal) {
    // A closed dialog keeps the commands it still has behind the button of the field, which takes
    // no words (R9: commands work with the field closed).
    composer = (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
        <Box sx={{ alignSelf: 'stretch' }}>
          <Composer
            placeholder={composerText.finished}
            sendLabel={composerText.send}
            disabledReason={feedInputText.finished}
            error={fieldError}
            busy={false}
            onSend={send}
            effort={settings}
            commands={composerCommands}
            noSecrets={noSecrets}
          />
        </Box>
        <Button
          component={Link}
          href={newChatHref(head.task.project?.id ?? null)}
          variant="outlined"
          startIcon={<AppIcon name="plus" size={18} />}
          sx={{ borderRadius: '999px' }}
        >
          {feedInputText.newDialog}
        </Button>
      </Box>
    )
  } else {
    // A question of the browser is answered in words too: they resume the agent (Б16); so is a
    // question of the platform about credits — the words go on as «Продолжить» does (28.10.2026:
    // «пользователь всегда должен иметь возможность ввести промпт»). Without a question the dialog
    // waits after an answer of a pass that changed nothing (26.10.2026) or after a failure.
    const answering =
      (awaitingClient && question?.kind === 'ceiling') ||
      (status === 'awaiting_user' &&
        (question === null || question.kind === 'agent' || question.kind === 'browser'))
    const revising = status === 'awaiting_approval' && question === null
    // While the agent works the field stays open: the words wait in the queue (ВВ1).
    const working = status === 'queued' || status === 'preparing' || status === 'running'
    const disabledReason = stopping
      ? composerText.stopping
      : answering || revising || working
        ? null
        : feedInputText.disabled
    // While the agent works «Остановить» stands in place of «Отправить» (`/cancel`) — until words
    // are written: then the button puts them in the queue.
    const cancelVerdict = commands.find((command) => command.id === 'cancel')
    composer = (
      <Composer
        placeholder={
          working
            ? queueText.placeholder
            : answering && !answered
              ? feedQuestionText.placeholder
              : revising
                ? composerText.revisionPlaceholder
                : composerText.newPlaceholder
        }
        // An answer of the agent asks nothing: the field is the field of a new message.
        sendLabel={
          working
            ? queueText.queue
            : answering && !answered
              ? feedQuestionText.send
              : composerText.send
        }
        disabledReason={disabledReason}
        error={fieldError}
        busy={message.isPending || queueAdd.isPending}
        onSend={send}
        effort={settings}
        commands={composerCommands}
        attachments={attachments}
        mentions={mentions}
        noSecrets={noSecrets}
        restored={undoneWords}
        restoredTaken={wordsTaken}
        onTextChange={fieldTextChanged}
        history={requestHistory}
        speech={speech}
        {...(working
          ? {
              stop: {
                onStop: () => runCommand('cancel'),
                available: cancelVerdict?.available === true && !stopping,
              },
            }
          : {})}
      />
    )
  }

  // «+» of the tools: in the head while their panel is closed, at the end of its tabs while open.
  // Its dot says what is new behind it, never while the panel is open (И13); below `lg` its menu
  // comes up from the bottom of the screen (И14). A chat with no tool has no «+» at all (К19).
  const tiles =
    head === null ? [] : toolTilesOf(head, tools, { answered, rewound, documents: documentCount })
  const menu =
    head === null || tiles.length === 0 ? null : (
      <ToolsMenu
        tiles={tiles}
        onOpen={(tool) => openTool(tool, { by: 'menu' })}
        dot={toolsDot(head, tools)}
        sheet={!wide}
      />
    )
  // Below `lg` an open tool takes the place of the dialog: its head, rows and field are only
  // hidden, never unmounted — the draft, the files and the place of the reader stay (И14, И19).
  const covered = shown && !wide

  /** What the panel of a tool holds. */
  function toolContent(tool: DialogTool): ReactNode {
    switch (tool) {
      case 'browser':
        return (
          <BrowserPane
            taskId={taskId}
            head={head}
            stream={stream}
            configured={browserStreamUrl !== null}
            visible={browserShown}
            fullscreen={fullscreen}
            onFullscreen={setFullscreen}
            onTake={takeControl}
            onResume={resumeWork}
            onStop={() => runCommand('cancel')}
            stopping={stopping}
            canStop={
              !terminal &&
              !stopping &&
              commands.some((command) => command.id === 'cancel' && command.available)
            }
            busy={busy}
            answered={answered}
            rewound={rewound}
          />
        )
      case 'documents':
        return (
          <DocRevisions.Provider value={docRevisions}>
            <DocumentsPane
              taskId={taskId}
              rows={rows}
              agentDocs={agentDocs}
              target={documentTarget}
              fullscreen={fullscreen}
              onFullscreen={setFullscreen}
              {...(canPublishPages.data === true
                ? {
                    onPublish: (document: { name: string; title: string }, fileId: string) =>
                      setPublishing({ fileId, name: document.name, title: document.title }),
                  }
                : {})}
            />
            {publication.dialog}
            {publishing !== null && (
              <PublishTargetDialog
                key={publishing.fileId}
                open
                fileName={publishing.name}
                defaultTitle={publishing.title}
                pages={targets.data ?? null}
                loading={targets.isPending}
                failed={targets.isError}
                pending={publication.pending}
                onPublish={publishTo}
                onClose={() => setPublishing(null)}
              />
            )}
          </DocRevisions.Provider>
        )
    }
  }

  return (
    <Box
      ref={root}
      sx={{
        flex: { xs: '1 0 auto', lg: '1 1 0' },
        minHeight: { lg: 0 },
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        // What sticks over the top of the window below `lg`, as measured, and a step: the head of
        // one line of 44px (`HEAD_ROOM`). Nothing over the feed from `lg`.
        [HEAD_ROOM]: { xs: `${44 + ROOM_STEP}px`, lg: '0px' },
        // A window lower than 420px sticks no head (below).
        '@media (max-height: 420px)': { [HEAD_ROOM]: '0px' },
      }}
    >
      {/* The browser over the whole area covers the head and the dialog: neither takes focus. */}
      <Box
        inert={fullscreen}
        sx={{
          display: covered ? 'none' : 'block',
          flex: 'none',
          mb: { xs: 3, md: 4, lg: 0 },
          // Below `lg` the page scrolls the dialog, and the head keeps to the top of the window, «+»
          // within reach (docs/plan/59, И4, И14). It runs from edge to edge of the content, so the
          // rows pass under it unseen; the field and its list of commands stay over it.
          position: { xs: 'sticky', lg: 'static' },
          top: 0,
          zIndex: { xs: 1, lg: 'auto' },
          // A window lower than 420px — a phone on its side, a page zoomed to 400% — leaves the head
          // with the page: stuck over the field, it would leave the feed a line to be read in (WCAG
          // 1.4.10), as the landing unpins its header there (DESIGN.md, «Шапка»).
          '@media (max-height: 420px)': { position: 'static' },
          bgcolor: 'background.paper',
          // From `lg` the head stands over the area of the feed, which scrolls under it, from edge
          // to edge of the dialog, at the top of the window — level with the strip of the panel's
          // tabs while the panel is open, «+» in its corner while it is closed (docs/plan/59, И4).
          mt: { lg: -3.5 },
          mx: { xs: -2, sm: -2.5, md: -4 },
          pl: { xs: 2, sm: 2.5, md: 4, lg: 3 },
          pr: { xs: 2, sm: 2.5, md: 4, lg: 0.75 },
        }}
      >
        <DialogHead
          schedule={schedule}
          taskId={taskId}
          title={shownTitle}
          head={head}
          onRenamed={refresh}
          tools={shown ? null : menu}
          results={
            results.fits ? (
              <ResultsToggle shown={results.shown} onToggle={results.toggle} holds={sideHolds} />
            ) : null
          }
        />
      </Box>

      <Box
        ref={feedArea}
        inert={fullscreen}
        sx={{
          // Below `lg` an open tool takes the place of the feed. The feed is only hidden, never
          // unmounted: the draft, the files and the place of the reader stay (docs/plan/59, И19).
          display: covered ? 'none' : 'flex',
          flexDirection: 'column',
          flex: { xs: '1 0 auto', lg: '1 1 0' },
          minWidth: 0,
          // From `lg` the page stands at the height of the window (owner's request of 26.10.2026):
          // the feed scrolls in its own area and the field keeps to the bottom, so the page under
          // the surface of the chat never shows. The area takes the paddings of the content of the
          // shell back (32 px at the sides, 28 px below): its scrollbar stands at the edge, its
          // field at the bottom of the window. Positioned: whatever the feed places is scrolled
          // and clipped with it, never past the page.
          minHeight: { lg: 0 },
          overflowY: { lg: 'auto' },
          position: { lg: 'relative' },
          mx: { lg: -4 },
          px: { lg: 4 },
          // The feed keeps clear of the column beside it on the right while it is shown.
          ...(results.shown ? { pr: { lg: `${32 + RESULTS_ROOM}px` } } : {}),
          pt: { lg: 1 },
          mb: { lg: -3.5 },
        }}
      >
        {results.shown ? (
          // Pinned to the top of the area as the feed scrolls under it: no height of its own.
          <Box
            sx={{
              position: 'sticky',
              top: 0,
              height: 0,
              zIndex: 3,
              mr: `-${RESULTS_ROOM}px`,
              display: 'flex',
              justifyContent: 'flex-end',
            }}
          >
            <Box
              sx={{
                pt: 1,
                width: RESULTS_WIDTH,
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              {todo !== null ? (
                <TodoCard taskId={taskId} todo={todo} waiting={question !== null} />
              ) : null}
              {resultCount > 0 ? (
                <ResultsCard
                  taskId={taskId}
                  agentDocs={agentDocs}
                  documents={chatDocuments}
                  files={chatFiles}
                  underPlan={todo !== null}
                  shownAgentDoc={
                    shown && tools.active === 'documents' && documentTarget
                      ? agentDocOfEntry(documentTarget.name)
                      : null
                  }
                  onOpenAgentDoc={(docId) => {
                    openDocument(agentDocEntry(docId), null)
                    openTool('documents', { by: 'menu' })
                  }}
                  onOpenFile={(fileId) => {
                    const document = documentOfFile(chatDocuments, fileId)
                    if (document === null) return
                    openDocument(document.name, fileId)
                    openTool('documents', { by: 'menu' })
                  }}
                />
              ) : null}
            </Box>
          </Box>
        ) : null}
        <Box
          ref={feedContent}
          sx={{
            flex: '1 0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: { xs: 3, md: 4 },
            minWidth: 0,
            width: '100%',
            // The feed and the field on one axis, a comfortable measure (owner's brief, 26.10.2026).
            maxWidth: 780,
            mx: 'auto',
            // Whatever of the feed takes the focus — a link of an answer, a button of a card —, or
            // is shown by the browser, keeps clear of what sticks over the feed: the head at the
            // top below `lg`, the field at the bottom (WCAG 2.4.11). The field itself has no room:
            // it is always in sight, and a room under it would scroll the page as it is focused.
            '& :not([data-feed-field], [data-feed-field] *)': {
              scrollMarginTop: `var(${HEAD_ROOM})`,
              scrollMarginBottom: `var(${FIELD_ROOM}, ${140 + ROOM_STEP}px)`,
            },
          }}
        >
          {head === null ? (
            <Box role="status" aria-label={dialogText.loading} sx={{ display: 'grid', gap: 1.5 }}>
              <Skeleton
                variant="rounded"
                height={64}
                sx={{ borderRadius: '14px', width: '70%', justifySelf: 'end' }}
              />
              <Skeleton variant="rounded" height={120} sx={{ borderRadius: '14px' }} />
            </Box>
          ) : (
            <FeedList
              head={head}
              rows={rows}
              openQuestionId={question?.id ?? null}
              actions={actions}
              filesOf={sentFilesOf}
              details={details || thinking}
              activityOf={(turn) => <TurnActivity taskId={taskId} turn={turn} live={false} />}
            />
          )}
          {head ? (
            <LiveBlock
              head={head}
              steps={liveSteps(rows, head)}
              stopping={stopping}
              activity={
                head.task.status === 'running' && head.task.turnNo > 0 ? (
                  <TurnActivity
                    key={`${head.task.id}:${head.task.turnNo}`}
                    taskId={taskId}
                    turn={head.task.turnNo}
                    live
                  />
                ) : undefined
              }
              browser={
                withBrowser
                  ? {
                      controlling: head.browser?.controller === 'user' && browserLive,
                      onResume: resumeWork,
                      busy,
                    }
                  : undefined
              }
            />
          ) : null}
          {head ? (
            <QueueCards
              taskId={taskId}
              items={queued}
              canInterrupt={
                (head.task.status === 'preparing' || head.task.status === 'running') && !stopping
              }
              waiting={
                !agentWorks &&
                (head.task.status === 'awaiting_user' || head.task.status === 'awaiting_approval')
              }
              onSendAll={(text, files) => send(text, files)}
              onChanged={refresh}
            />
          ) : null}
          {state.failures > 0 ? (
            <Box
              role="status"
              sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5 }}
            >
              <Typography variant="body2" color="text.secondary">
                {feedStateText.pollFailed}
              </Typography>
              {showsRefresh(state) ? (
                <Button variant="outlined" size="small" onClick={refresh} sx={{ minHeight: 44 }}>
                  {feedStateText.refresh}
                </Button>
              ) : null}
            </Box>
          ) : null}

          <Box
            ref={field}
            data-feed-field=""
            sx={{
              position: 'sticky',
              bottom: 0,
              zIndex: 2,
              mt: 'auto',
              pt: 1.5,
              pb: { xs: 'max(12px, env(safe-area-inset-bottom))', sm: 2 },
              // The field stands on the page itself: what scrolls under it is hidden, never faded.
              bgcolor: 'var(--mui-palette-background-paper)',
            }}
          >
            {/* Where the column beside the chat does not fit, the plan of the work stands over
                the field while the agent works (docs/plan/89, ТД7); from `lg` only once the area
                is measured, so the column does not follow the line in. */}
            {todo !== null &&
            todoStripShows(todo) &&
            !results.fits &&
            (!wide || results.measured) ? (
              // Stays mounted from turn to turn: the opening belongs to its turn (`openTurn`), so the
              // list of a later turn starts folded without a remount and the focus stays on the line.
              <TodoStrip todo={todo} />
            ) : null}
            {composer}
            {composer === null ? null : <UsageWindowHint />}
          </Box>
        </Box>
      </Box>
      {/* Outside the column: it speaks while the browser covers the dialog too. */}
      <Box role="status" aria-live="polite" sx={offScreen}>
        {announcement}
      </Box>
      <Box role="status" aria-live="polite" sx={offScreen}>
        {note}
      </Box>
      {clientCommands.menu}

      {/* Drawn only while a tool is on the screen: no empty column, no hidden tool that reads. */}
      <ToolsPanel
        tools={tools}
        pane={pane}
        wide={wide}
        fullscreen={fullscreen}
        menu={shown ? menu : null}
        onShow={showTool}
        onClose={closeTool}
        onCloseAll={closeTools}
        onBack={backToDialog}
        content={toolContent}
      />

      {userId !== null ? (
        <ScheduleDialog
          opening={scheduleOpening}
          userId={userId}
          onClose={() => setScheduleOpening(null)}
        />
      ) : null}
      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={cancelText.title}
        busy={cancel.isPending}
        error={cancelError}
        keepLabel={cancelText.keep}
        confirmLabel={cancelText.confirm}
        danger
        onConfirm={() => void confirmCancel()}
      >
        <Typography sx={{ mt: 1.5 }}>
          {nbsp(cancelText.body({ changes: false, onSite: false }))}
        </Typography>
      </ConfirmDialog>
    </Box>
  )
}
