'use client'

import { chatCommands, type ChatCommandId } from '@repo/domain/release/chat-commands'
import { feedFailureText } from '@repo/domain/tasks/client-feed-failures'
import type { ReasoningEffort } from '@repo/domain/llm/model-class'
import {
  feedFailureKeptText,
  feedInputText,
  feedQuestionText,
  feedStateText,
  feedVersionText,
  taskAnsweredLabel,
  taskStatusLabel,
} from '@repo/domain/tasks/client-feed-labels'
import { terminalTaskStatuses } from '@repo/domain/tasks/task-status'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { ConfirmDialog } from '@/components/billing/confirm-dialog'
import { siteHref, SITE_TOOLBAR_HEIGHT } from '@/components/site/site-nav'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import type { SentFile } from './attachment-chips'
import { BrowserPane } from './browser-pane'
import { sessionLive } from './browser-pane-model'
import { callErrorText } from './call-error'
import type { SiteCapabilities } from './chat-types'
import {
  cancelText,
  composerText,
  dialogText,
  effortText,
  listText,
  releaseStatusText,
  releaseText,
  taskWayText,
  undoText,
} from './chat-texts'
import { Composer, offScreen } from './composer'
import { DialogMenuButton, dialogListKey, RemoveDialogConfirm, RenameField } from './dialog-actions'
import { DialogNotFound } from './dialog-not-found'
import {
  changesMark,
  changesToolOf,
  closedTools,
  isChangesTool,
  movesFocus,
  toolsDot,
  toolsReducer,
  toolsShown,
  toolTabId,
  toolTilesOf,
  type DialogTool,
  type ToolOpener,
} from './dialog-tools'
import { EffortMenu } from './effort-menu'
import { FeedList, LiveBlock, type FeedActions } from './feed-list'
import {
  candidateMessage,
  liveCandidateRow,
  liveSteps,
  openQuestion,
  requestShown,
  retryFailure,
  stopRequested,
} from './feed-model'
import { showsRefresh, type FeedHeadState } from './feed-state'
import { ModeLinks, type DialogMode } from './mode-switch'
import { CandidateTab, PreviewTab, usePreviewCalls } from './preview-pane'
import { ReleaseDialog } from './release-dialog'
import { TOOLS_BUTTON_ID, TOOLS_MENU_MARK, ToolsMenu } from './tools-menu'
import { ToolsPanel } from './tools-panel'
import { TurnActivity } from './turn-activity'
import { UndoDialog } from './undo-dialog'
import { useAttachments } from './use-attachments'
import { useBrowserLaunch } from './use-browser-launch'
import { useBrowserStream } from './use-browser-stream'
import { useBrowserWatching } from './use-browser-watching'
import { useFeedFollow } from './use-feed-follow'
import { useDialogFeed } from './use-dialog-feed'
import { uuidv7 } from './uuid'

// One dialog (docs/plan/53-chat-preview-release.md, R9; feed design, «Экраны, которых нет на
// макетах»): its head, its rows, the live block and the field. Its tools — the browser of a task
// in the browser (docs/plan/57-browser-tasks.md), the preview, files, records and checks of a task
// with the repository — open beside it only when the client asks for one (docs/plan/59-dialog-
// tools-panel.md): by «+» in the corner, «Посмотреть изменения», `/preview` and «Взять
// управление»; by themselves only once, when the browser of the task starts while the client looks
// at the dialog. From `lg` they stand at the right edge; below, in place of the dialog, «К диалогу»
// leading back to it.

/** The one command of a task in the browser: stopping it (docs/plan/57-browser-tasks.md, Б24). */
const BROWSER_COMMANDS: readonly ChatCommandId[] = ['cancel']

/**
 * What a focused element of the feed keeps clear above it (WCAG 2.4.11): below `lg` the head of
 * the dialog sticks to the top of the window — 96px on two lines below `md`, from `md` 44px under
 * the bar of the shell, which sticks too — and a step of 16px, as the landing keeps its anchors
 * from under its header (DESIGN.md, «Шапка»). The room is a margin of the rows and not a padding
 * of the scroller: with a padding, the head itself would count as hidden, and Tab onto it would
 * scroll the page. From `lg` the head stands over the area the feed scrolls in, never over it.
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
    (dialog === null ? active.closest('[data-site-list]') !== null : dialog.contains(active))
  return taken ? active : null
}

/** What a press of the client sends: one id per press, kept for its repeats. */
type Press = 'message' | 'continue' | 'retry' | 'cancel' | 'reset' | 'update' | 'resume'

/** A release or an undo of it that is under way: its words in the head of the dialog. */
function releaseProgress(head: FeedHeadState): string | null {
  const undo = head.undo?.run ?? null
  if (undo !== null && undo.outcome === null) {
    const words = releaseStatusText[undo.status]
    return words ? undoText.progress(feedVersionText(head.undo!.version), words) : null
  }
  const release = head.release
  if (release === null || release.outcome !== null) return null
  const words = releaseStatusText[release.status]
  return words ? releaseText.progress(feedVersionText(release.version), words) : null
}

/**
 * The head of a dialog (owner's request of 26.10.2026): one quiet line — its name, a release under
 * way beside it, its menu («Переименовать», «Удалить») and, while the panel of its tools is closed,
 * «+» of the tools in the corner (docs/plan/59, И4). The name is written in place of itself. In
 * the middle stands «Чат | Работа» with the dialog's own mode, as on «Новый диалог» (owner's
 * request of 29.10.2026); on a phone the switch takes a line of its own under the name.
 */
function DialogHead({
  siteId,
  taskId,
  title,
  head,
  onRenamed,
  tools,
  closedModes,
}: {
  siteId: string
  taskId: string
  title: string
  head: FeedHeadState | null
  onRenamed: () => void
  /** «+» of the tools while their panel is closed; null — it stands at the end of the tabs. */
  tools: ReactNode
  /** A mode the site does not offer now, and why: the switch does not lead to it. */
  closedModes: Partial<Record<DialogMode, string>>
}) {
  // «Отменить выпуск» is offered now: deleting the dialog takes it away too.
  const undoable =
    head?.commands.some((command) => command.id === 'undo' && command.available) === true
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const progress = head === null ? null : releaseProgress(head)
  return (
    <Box
      component="header"
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: 'minmax(0, 1fr) auto',
          md: 'minmax(0, 1fr) auto minmax(0, 1fr)',
        },
        alignItems: 'center',
        columnGap: 1.5,
        rowGap: 1,
        // From `lg` as high as the strip of the panel's tabs: «+» keeps its corner (И4).
        minHeight: { xs: 44, lg: 56 },
        minWidth: 0,
      }}
    >
      <Box sx={{ gridColumn: 1, gridRow: 1, minWidth: 0, display: 'flex' }}>
        {renaming ? (
          <RenameField
            siteId={siteId}
            taskId={taskId}
            initial={head?.task.title ?? ''}
            fontSize={15}
            onDone={(saved) => {
              setRenaming(false)
              if (saved !== null) onRenamed()
            }}
          />
        ) : (
          <Box
            sx={{
              flex: '1 1 auto',
              minWidth: 0,
              display: 'flex',
              alignItems: 'baseline',
              gap: 1.5,
            }}
          >
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
            {progress ? (
              <Typography
                component="span"
                variant="body2"
                color="text.secondary"
                sx={{ flex: 'none', fontSize: 13 }}
              >
                {nbsp(progress)}
              </Typography>
            ) : null}
          </Box>
        )}
      </Box>
      {head !== null ? (
        <Box
          sx={{
            gridColumn: { xs: '1 / -1', md: 2 },
            gridRow: { xs: 2, md: 1 },
            justifySelf: 'center',
          }}
        >
          <ModeLinks
            value={head.task.mode}
            newDialogHref={`${siteHref(siteId, 'chat')}/new`}
            closed={closedModes}
          />
        </Box>
      ) : null}
      <Box
        sx={{
          gridColumn: { xs: 2, md: 3 },
          gridRow: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 0.5,
        }}
      >
        {head !== null && !renaming ? (
          <DialogMenuButton
            title={title}
            onRename={() => setRenaming(true)}
            onRemove={() => setRemoving(true)}
          />
        ) : null}
        {tools}
      </Box>
      {removing ? (
        <RemoveDialogConfirm
          siteId={siteId}
          taskId={taskId}
          undoable={undoable}
          open
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </Box>
  )
}

/**
 * The dialog itself. Its state comes from `task.feed`, read again and again while the page is
 * shown; whatever the client writes or presses is read back at once.
 */
export function DialogView({
  siteId,
  siteUrl,
  taskId,
  title,
  browserStreamUrl = null,
  capabilities,
}: {
  siteId: string
  siteUrl: string
  taskId: string
  title: string | null
  /**
   * Where the cabinet opens the stream of a task's browser (`BROWSER_STREAM_PUBLIC_URL`,
   * docs/plan/57-browser-tasks.md, Б12); null — the platform has no browser here.
   */
  browserStreamUrl?: string | null
  /** What the site can be worked on with now (`project.get`): the modes a new dialog has. */
  capabilities?: SiteCapabilities
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { state, refresh } = useDialogFeed(taskId)
  const head = state.head
  const rows = state.rows

  // The tools beside the dialog, as the client opened them (docs/plan/59, И1): every showing of a
  // dialog starts with them closed — with changes ready and with a browser at work too — and
  // nothing of them is kept for the next one.
  const [tools, dispatchTools] = useReducer(toolsReducer, closedTools)
  // From `lg` the tools stand beside the dialog; below, an open one takes its place (И14).
  const theme = useTheme()
  const wide = useMediaQuery(theme.breakpoints.up('lg'))
  // The client's calls for the preview: every choice of it is one (И10); a stopped one wakes only
  // on a call made after it stopped.
  const previewCalls = usePreviewCalls(head?.preview?.status ?? null)
  // Said to a screen reader once the server took a new level.
  const [effortNote, setEffortNote] = useState('')
  // The level chosen here, shown while the head still says the level it was chosen over.
  const [effortChosen, setEffortChosen] = useState<{
    effort: ReasoningEffort
    over: ReasoningEffort | undefined
  } | null>(null)
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [undoOpen, setUndoOpen] = useState(false)
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

  const message = useMutation(trpc.task.message.mutationOptions())
  const proceed = useMutation(trpc.task.continue.mutationOptions())
  const cancel = useMutation(trpc.task.cancel.mutationOptions())
  const reset = useMutation(trpc.preview.reset.mutationOptions())
  const update = useMutation(trpc.candidate.update.mutationOptions())
  const retry = useMutation(trpc.task.retry.mutationOptions())
  const resumeAgent = useMutation(trpc.task.resumeAgent.mutationOptions())
  const setEffort = useMutation(trpc.task.setEffort.mutationOptions())
  const busy =
    proceed.isPending ||
    retry.isPending ||
    cancel.isPending ||
    reset.isPending ||
    update.isPending ||
    resumeAgent.isPending

  // A task in the browser (docs/plan/57-browser-tasks.md): the browser instead of the preview.
  const inBrowser = head?.task.requirements.browser === true
  const browserLive = inBrowser && sessionLive(head?.browser ?? null)
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
  // dropped to the start of the page. A launch that opens nothing — spent — moves nothing.
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
  useBrowserLaunch(head, {
    taskId,
    enabled: inBrowser && browserStreamUrl !== null,
    onLaunch: launched,
  })
  // The chat counts as watching the browser (И18; owner's answer of 30.10.2026): while the dialog
  // is on the screen its browser does not close for idle, the panel open or not.
  useBrowserWatching({ taskId, enabled: browserLive })
  const attachments = useAttachments(siteId)
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
  const candidateRow = liveCandidateRow(rows, head)
  // The failure «Попробовать ещё» answers: the server offers it (docs/plan/53).
  const retryRow = retryFailure(rows, head)
  const terminal = status !== undefined && terminalTaskStatuses.includes(status)
  // `/cancel` was taken while the agent works: core stops it, and it is not asked twice — the
  // agent is still at work until then, as the list says of the command. A task in the browser is
  // stopped by core while it waits for the client too: it takes no words or presses meanwhile.
  const stopping =
    !terminal && (stopRequested(rows, status, inBrowser) || cancel.data?.state === 'stopping')
  // «Отменить выпуск» is listed only in a dialog that installed a version, «Попробовать ещё» only
  // while it is offered (critique of the plan: a refusal in every other dialog would be noise).
  // A task in the browser has one command: stopping it (no preview, release or undo).
  const verdicts = (head?.commands ?? []).filter(
    (command) =>
      (!inBrowser || command.id === 'cancel') &&
      (command.id !== 'undo' || command.refusal !== 'no_release') &&
      (command.id !== 'retry' || (command.available && retryRow !== null)),
  )
  const commands = stopping
    ? verdicts.map((command) =>
        command.id === 'cancel'
          ? { id: command.id, available: false, refusal: 'busy' as const }
          : command,
      )
    : verdicts
  const resetVerdict = commands.find((command) => command.id === 'reset')

  // A dialog whose status changed: the list follows it, the credits it set aside or gave back
  // are read again, and no press of before is repeated.
  const shownStatus = useRef<string | null>(null)
  useEffect(() => {
    if (status === undefined) return
    if (shownStatus.current !== null && shownStatus.current !== status) {
      presses.current.clear()
      void queryClient.invalidateQueries({ queryKey: dialogListKey(siteId) })
      void queryClient.invalidateQueries({ queryKey: trpc.billing.usage.queryKey() })
    }
    shownStatus.current = status
  }, [status, queryClient, siteId, trpc])

  // The changes are read again when their numbers in the head move: a check that ends, a
  // candidate the site moved on under. The panel and the release show what the head says.
  const candidate = head?.candidate ?? null
  const candidateMark =
    candidate === null
      ? null
      : [
          candidate.id,
          candidate.revision,
          candidate.status,
          candidate.checks.pending,
          candidate.checks.passed,
          candidate.checks.failed,
          candidate.checks.stale,
        ].join(':')
  const candidateRevision = candidate?.revision
  const shownCandidate = useRef<string | null>(null)
  useEffect(() => {
    if (candidateMark === null || candidateRevision === undefined) return
    if (shownCandidate.current !== null && shownCandidate.current !== candidateMark)
      void queryClient.invalidateQueries({
        queryKey: trpc.candidate.get.queryKey({ taskId, revision: candidateRevision }),
      })
    shownCandidate.current = candidateMark
  }, [candidateMark, candidateRevision, queryClient, taskId, trpc])
  // A tab of the changes on the screen — beside the dialog or in its place — shows the client this
  // revision: «+» bears no dot for it (И13). A revision that comes after is new again.
  const changesShown = shown && isChangesTool(tools.active)
  const changesNow = changesMark(candidate)
  useEffect(() => {
    if (changesShown && changesNow !== null) dispatchTools({ type: 'seen', changes: changesNow })
  }, [changesShown, changesNow])
  // The live region says the status as it changes: a question, a result, a failure, changes to
  // look at and the end of a release each come with a status of their own. Not every stage and
  // not the timer. A failure after which the dialog kept its changes leaves the status «Ждёт
  // вашего решения» as it was: the failure is said instead, by its own sentence and the one about
  // the kept changes — not under the status «Не получилось», which the dialog does not have.
  const last = rows.at(-1)
  const keptFailure =
    status === 'awaiting_approval' &&
    last?.type === 'feed.failure' &&
    last.next === 'awaiting_approval'
      ? last
      : null
  // The agent answered and asked nothing: the dialog waits for no one (26.10.2026). A failure
  // that left the dialog open (28.10.2026) asks the client again: «продолжи».
  const ending = rows.findLast((row) => row.type === 'feed.result' || row.type === 'feed.failure')
  const answered =
    status === 'awaiting_user' && question === null && ending?.type !== 'feed.failure'
  const announcement =
    status === undefined
      ? ''
      : keptFailure !== null
        ? `${feedFailureText[keptFailure.code]} ${feedFailureKeptText}`
        : answered
          ? taskAnsweredLabel
          : taskStatusLabel[status]

  /**
   * The focus goes where the tools are drawn next — the tab of a tool, or «+» once none is open:
   * what moved it is gone or behind. «+» takes it where it stands, the page left where it is: the
   * head keeps «+» in sight as it sticks, and in a window lower than 420px, where the head goes
   * with the page, the feed comes back where the client read it rather than at the head (И19).
   */
  function focusSoon(id: string) {
    window.setTimeout(
      () => document.getElementById(id)?.focus({ preventScroll: id === TOOLS_BUTTON_ID }),
      0,
    )
  }

  /**
   * The one way a tool opens at the client's press (docs/plan/59, И9): «+», «Посмотреть изменения»,
   * `/preview` and «Взять управление» — never the words of the agent; the launch of the browser is
   * an action of its own (`launched`). An open tool is shown again, never twice. Choosing the preview is the client's call to show it,
   * every time (И10). An explicit opening puts the focus on the tab of the tool, unless the action
   * keeps a place of its own and that place stays in sight: below `lg` the first tool takes the
   * place of the dialog, and the button pressed there goes out of sight with it (И14).
   */
  function openTool(tool: DialogTool, { by }: { by: ToolOpener }) {
    if (tool === 'preview') previewCalls.call()
    const covers = !wide && !shown
    dispatchTools({ type: 'open', tool, by })
    if (movesFocus(by, { covers })) focusSoon(toolTabId(tool))
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
    focusSoon(next.active === null ? TOOLS_BUTTON_ID : toolTabId(next.active))
  }

  /**
   * «Скрыть панель»: every tab at once, nothing sent either; the focus back on «+» in the head, the
   * feed where the client read it (И8, И19).
   */
  function closeTools() {
    dispatchTools({ type: 'closeAll' })
    setFullscreen(false)
    focusSoon(TOOLS_BUTTON_ID)
  }

  /**
   * «К диалогу» below `lg` (И14, owner's answer of 30.10.2026): the tab on the screen closes, the
   * other open ones stay behind the dialog for «+»; the dialog comes back where the client read it,
   * the focus on «+» in its head (И19).
   */
  function backToDialog() {
    dispatchTools({ type: 'back' })
    setFullscreen(false)
    focusSoon(TOOLS_BUTTON_ID)
  }

  /** «Размышление» of the dialog: from the agent's next turn (`task.setEffort`). */
  async function changeEffort(effort: ReasoningEffort) {
    setFieldError(null)
    setEffortNote('')
    setEffortChosen({ effort, over: head?.task.effort })
    try {
      await setEffort.mutateAsync({ taskId, effort })
      setEffortNote(effortText.changed)
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
    // Files go with the messages of either mode: to the browser's pages, or into the copy of
    // the site the agent works on.
    const files = [...attachmentIds]
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
      setFieldError(callErrorText(failure))
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
    } catch (failure) {
      setFieldError(callErrorText(failure))
    }
    // A refusal says the verdicts changed: the commands are read again with the dialog.
    refresh()
  }

  /** «Попробовать ещё» of a failure: one id per press of that failure, kept for its repeats. */
  async function pressRetry(failureEventId: string) {
    setFieldError(null)
    try {
      await retry.mutateAsync({
        taskId,
        requestId: pressId('retry', failureEventId),
        failureEventId,
      })
      pressed('retry')
      // The retry gave the reserve back and set a new one aside.
      void queryClient.invalidateQueries({ queryKey: trpc.billing.usage.queryKey() })
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
    // The bar of the shell, the list of dialogs and the way back to it are under the browser too:
    // out of the tab order while it covers them (WCAG 2.4.11), as the dialog's own column is.
    const covered = [
      ...(pane.current
        ?.closest('[data-site-shell]')
        ?.querySelectorAll('header, [data-site-list], [data-site-back]') ?? []),
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

  function runCommand(id: ChatCommandId) {
    setFieldError(null)
    switch (id) {
      case 'release':
        setReleaseOpen(true)
        return
      case 'preview':
        openTool('preview', { by: 'command' })
        return
      case 'reset':
        void press('reset', reset.mutateAsync)
        return
      case 'update':
        void press('update', update.mutateAsync)
        return
      case 'retry':
        if (retryRow !== null) void pressRetry(retryRow.id)
        return
      case 'cancel':
        setCancelError(null)
        setCancelOpen(true)
        return
      case 'undo':
        setUndoOpen(true)
        return
    }
  }

  const actions: FeedActions = {
    onContinue: () => void press('continue', proceed.mutateAsync),
    onRetry: (failureEventId) => void pressRetry(failureEventId),
    onStop: () => runCommand('cancel'),
    onRelease: () => runCommand('release'),
    onUpdate: () => runCommand('update'),
    onUndo: () => runCommand('undo'),
    // The first tool of the changes that holds anything; never the preview (И10).
    onShowChanges: () => {
      if (head !== null) openTool(changesToolOf(head), { by: 'changes' })
    },
    onTakeControl: takeControl,
    onResumeAgent: resumeWork,
    // The client holds the control of a browser that is there: a closed session holds nothing.
    controlling: head?.browser?.controller === 'user' && browserLive,
    browserLive,
    busy,
    stopping,
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

  if (state.missing) return <DialogNotFound listHref={siteHref(siteId, 'chat')} />

  const shownTitle = head?.task.title ?? title ?? listText.untitled
  const releasing = status === 'deploying' || status === 'verifying'
  const awaitingClient = status === 'awaiting_user' || status === 'awaiting_approval'
  // Once the head says another level than the one chosen over, the head is right.
  const effort =
    effortChosen !== null && effortChosen.over === head?.task.effort
      ? effortChosen.effort
      : (head?.task.effort ?? 'high')
  // «Размышление» in the row of the field (owner's requests of 26.10.2026): the level holds from
  // the agent's next turn. The mode the dialog started in is in its head (29.10.2026).
  const settings =
    head === null ? null : (
      <EffortMenu
        value={effort}
        onChange={(next) => void changeEffort(next)}
        // The level holds from the agent's next turn: it is changed while the dialog waits.
        disabled={!awaitingClient || setEffort.isPending}
      />
    )
  let composer
  if (head === null) composer = null
  else if (terminal) {
    // A closed dialog keeps the commands it still has — «Отменить выпуск», the preview — behind
    // the button of the field, which takes no words (R9: commands work with the field closed).
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
            commands={{
              verdicts: commands,
              onRun: runCommand,
              onOpen: refresh,
              listed: inBrowser ? BROWSER_COMMANDS : undefined,
            }}
          />
        </Box>
        <Button
          component={Link}
          href={`${siteHref(siteId, 'chat')}/new`}
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
    const disabledReason = stopping
      ? composerText.stopping
      : answering || revising
        ? null
        : releasing
          ? composerText.releasing
          : feedInputText.disabled
    // While the agent works «Остановить» stands in place of «Отправить» (`/cancel`).
    const working = status === 'queued' || status === 'preparing' || status === 'running'
    const cancelVerdict = commands.find((command) => command.id === 'cancel')
    composer = (
      <Composer
        placeholder={
          answering && !answered
            ? feedQuestionText.placeholder
            : revising
              ? composerText.revisionPlaceholder
              : composerText.newPlaceholder
        }
        // An answer of the agent asks nothing: the field is the field of a new message.
        sendLabel={answering && !answered ? feedQuestionText.send : composerText.send}
        disabledReason={disabledReason}
        error={fieldError}
        busy={message.isPending}
        onSend={send}
        effort={settings}
        commands={{
          verdicts: commands,
          onRun: runCommand,
          onOpen: refresh,
          listed: inBrowser ? BROWSER_COMMANDS : undefined,
        }}
        attachments={attachments}
        noSecrets={inBrowser ? taskWayText.noSecrets : undefined}
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
  // comes up from the bottom of the screen (И14).
  const menu =
    head === null ? null : (
      <ToolsMenu
        tiles={toolTilesOf(head, tools)}
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
            siteId={siteId}
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
          />
        )
      case 'preview':
        return (
          <PreviewTab
            taskId={taskId}
            preview={head?.preview ?? null}
            calls={previewCalls}
            onReopen={() => {
              previewCalls.call()
              // «Открыть предпросмотр» goes with the frame it opens: the focus waits on the tab.
              focusSoon(toolTabId('preview'))
            }}
            canReset={resetVerdict?.available === true}
            onReset={() => runCommand('reset')}
            resetting={reset.isPending}
          />
        )
      case 'files':
      case 'database':
      case 'checks':
        return (
          <CandidateTab
            taskId={taskId}
            candidate={head?.candidate ?? null}
            tool={tool}
            ended={terminal}
          />
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
        // 96px (two lines of 44px and 8px between them), from `md` the bar of the shell and the
        // head of one line, 44px each (`HEAD_ROOM`). Nothing over the feed from `lg`.
        [HEAD_ROOM]: {
          xs: `${96 + ROOM_STEP}px`,
          md: `${SITE_TOOLBAR_HEIGHT + 44 + ROOM_STEP}px`,
          lg: '0px',
        },
        // A window lower than 420px sticks no head (below): only the bar of the shell from `md`.
        '@media (max-height: 420px)': {
          [HEAD_ROOM]: { xs: '0px', md: `${SITE_TOOLBAR_HEIGHT + ROOM_STEP}px`, lg: '0px' },
        },
      }}
    >
      {/* The browser over the whole area covers the head and the dialog: neither takes focus. */}
      <Box
        inert={fullscreen}
        sx={{
          display: covered ? 'none' : 'block',
          flex: 'none',
          mb: { xs: 3, md: 4, lg: 0 },
          // Below `lg` the page scrolls the dialog, and the head keeps to the top of the window —
          // under the bar of the shell, which keeps there too from `md` — «+» within reach (docs/
          // plan/59, И4, И14). It runs from edge to edge of the content, so the rows pass under it
          // unseen; the field and its list of commands stay over it.
          position: { xs: 'sticky', lg: 'static' },
          top: { xs: 0, md: SITE_TOOLBAR_HEIGHT },
          zIndex: { xs: 1, lg: 'auto' },
          // A window lower than 420px — a phone on its side, a page zoomed to 400% — leaves the head
          // with the page: stuck over the field, it would leave the feed a line to be read in (WCAG
          // 1.4.10), as the landing unpins its header there (DESIGN.md, «Шапка»).
          '@media (max-height: 420px)': { position: 'static' },
          bgcolor: 'background.paper',
          // From `lg` the head stands over the area of the feed, which scrolls under it, from edge
          // to edge of the dialog. While the panel is closed it stands right under the bar, «+» in
          // the corner the strip of the panel's tabs takes when it opens (docs/plan/59, И4); while
          // it is open, under «Назад к диалогам» of the list that gave the dialog its room.
          mt: { lg: shown ? 0 : -3.5 },
          mx: { xs: -2, sm: -2.5, md: -4 },
          pl: { xs: 2, sm: 2.5, md: 4, lg: 3 },
          pr: { xs: 2, sm: 2.5, md: 4, lg: 0.75 },
        }}
      >
        <DialogHead
          siteId={siteId}
          taskId={taskId}
          title={shownTitle}
          head={head}
          closedModes={
            capabilities === undefined
              ? {}
              : {
                  ...(capabilities.browser === 'ready' ? {} : { chat: composerText.chatOff }),
                  ...(capabilities.repository === 'ready' ? {} : { work: composerText.workOff }),
                }
          }
          onRenamed={refresh}
          tools={shown ? null : menu}
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
          pt: { lg: 1 },
          mb: { lg: -3.5 },
        }}
      >
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
              siteUrl={siteUrl}
              openQuestionId={question?.id ?? null}
              liveCandidateId={candidateRow?.id ?? null}
              retryId={retryRow?.id ?? null}
              actions={actions}
              filesOf={sentFilesOf}
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
                inBrowser
                  ? {
                      controlling: head.browser?.controller === 'user' && browserLive,
                      onResume: resumeWork,
                      busy,
                    }
                  : undefined
              }
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
            {composer}
          </Box>
        </Box>
      </Box>
      {/* Outside the column: it speaks while the browser covers the dialog too. */}
      <Box role="status" aria-live="polite" sx={offScreen}>
        {announcement}
      </Box>
      <Box role="status" aria-live="polite" sx={offScreen}>
        {effortNote}
      </Box>

      {/* Drawn only while a tool is on the screen: no empty column, no hidden tool that reads. */}
      <ToolsPanel
        tools={tools}
        pane={pane}
        wide={wide}
        fullscreen={fullscreen}
        menu={shown ? menu : null}
        onShow={(tool) => dispatchTools({ type: 'show', tool })}
        onClose={closeTool}
        onCloseAll={closeTools}
        onBack={backToDialog}
        content={toolContent}
      />

      <ReleaseDialog
        taskId={taskId}
        open={releaseOpen}
        agentMessage={candidateMessage(rows, candidateRow)}
        onClose={() => setReleaseOpen(false)}
        onReleased={() => {
          setReleaseOpen(false)
          refresh()
        }}
      />
      {head?.undo ? (
        <UndoDialog
          taskId={taskId}
          releaseId={head.undo.releaseId}
          version={head.undo.version}
          open={undoOpen}
          onClose={() => setUndoOpen(false)}
          onConfirmed={() => {
            setUndoOpen(false)
            refresh()
          }}
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
        <Typography sx={{ mt: 1.5 }}>{nbsp(chatCommands.cancel.description)}</Typography>
      </ConfirmDialog>
    </Box>
  )
}
