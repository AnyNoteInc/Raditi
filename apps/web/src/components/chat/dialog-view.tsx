'use client'

import { chatCommands, type ChatCommandId } from '@repo/domain/release/chat-commands'
import { feedFailureText } from '@repo/domain/tasks/client-feed-failures'
import {
  feedFailureKeptText,
  feedInputText,
  feedQuestionText,
  feedStateText,
  feedVersionText,
  taskModeLabel,
  taskStatusLabel,
} from '@repo/domain/tasks/client-feed-labels'
import { terminalTaskStatuses } from '@repo/domain/tasks/task-status'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Skeleton from '@mui/material/Skeleton'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { ConfirmDialog } from '@/components/billing/confirm-dialog'
import {
  SITE_PANE_WIDTH,
  SITE_RAIL_WIDTH,
  SITE_TOOLBAR_HEIGHT,
  siteHref,
} from '@/components/site/site-nav'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import type { SentFile } from './attachment-chips'
import { BrowserPane } from './browser-pane'
import { sessionLive } from './browser-pane-model'
import { callErrorText } from './call-error'
import {
  browserText,
  cancelText,
  composerText,
  dialogText,
  listText,
  paneText,
  releaseStatusText,
  releaseText,
  taskWayText,
  undoText,
  viewSwitchText,
} from './chat-texts'
import { Composer, offScreen } from './composer'
import { dialogListKey } from './dialog-list'
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
import { PaneResizer } from './pane-resizer'
import { PreviewPane, paneTabId, paneTabsOf, type PaneTab } from './preview-pane'
import { ReleaseDialog } from './release-dialog'
import { StatusMark } from './status-mark'
import { TurnActivity } from './turn-activity'
import { UndoDialog } from './undo-dialog'
import { useAttachments } from './use-attachments'
import { useBrowserStream } from './use-browser-stream'
import { useDialogFeed } from './use-dialog-feed'
import { uuidv7 } from './uuid'

// One dialog (docs/plan/53-chat-preview-release.md, R9; feed design, «Экраны, которых нет на
// макетах»): its head, its rows, the live block and the field, with the panel of its changes
// beside it from `lg` and behind the switch «Диалог | Предпросмотр» below. A task in the browser
// (docs/plan/57-browser-tasks.md, Б29) has its browser in that place: «Диалог | Браузер».

type View = 'dialog' | 'preview'
const viewId = (view: View) => `dialog-view-${view}`

/** The one command of a task in the browser: stopping it (docs/plan/57-browser-tasks.md, Б24). */
const BROWSER_COMMANDS: readonly ChatCommandId[] = ['cancel']

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

function DialogHead({ title, head }: { title: string; head: FeedHeadState | null }) {
  const progress = head === null ? null : releaseProgress(head)
  return (
    <Box component="header" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Typography
        component="h1"
        sx={{
          fontSize: { xs: 17, md: 18 },
          fontWeight: 600,
          lineHeight: 1.4,
          overflowWrap: 'anywhere',
        }}
      >
        {title}
      </Typography>
      {head ? (
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '2px 12px',
            fontSize: 13,
            color: 'text.secondary',
          }}
        >
          <StatusMark status={head.task.status} size="medium" />
          <Box component="span">
            <Box component="span" sx={offScreen}>
              {dialogText.mode}:{' '}
            </Box>
            {taskModeLabel[head.task.mode]}
          </Box>
          {head.task.requirements.browser ? (
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
              <AppIcon name="globe" size={14} />
              {taskWayText.browser}
            </Box>
          ) : null}
          {progress ? (
            <Typography component="span" variant="body2" color="text.secondary">
              {nbsp(progress)}
            </Typography>
          ) : null}
        </Box>
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
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const theme = useTheme()
  const wide = useMediaQuery(theme.breakpoints.up('lg'))
  const { state, refresh } = useDialogFeed(taskId)
  const head = state.head
  const rows = state.rows

  const [view, setView] = useState<View>('dialog')
  const [paneTab, setPaneTab] = useState<PaneTab>('preview')
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

  const message = useMutation(trpc.task.message.mutationOptions())
  const proceed = useMutation(trpc.task.continue.mutationOptions())
  const cancel = useMutation(trpc.task.cancel.mutationOptions())
  const reset = useMutation(trpc.preview.reset.mutationOptions())
  const update = useMutation(trpc.candidate.update.mutationOptions())
  const retry = useMutation(trpc.task.retry.mutationOptions())
  const resumeAgent = useMutation(trpc.task.resumeAgent.mutationOptions())
  const busy =
    proceed.isPending ||
    retry.isPending ||
    cancel.isPending ||
    reset.isPending ||
    update.isPending ||
    resumeAgent.isPending

  // A task in the browser (docs/plan/57-browser-tasks.md): the browser instead of the preview,
  // files with its messages, the stream while its panel is shown.
  const inBrowser = head?.task.requirements.browser === true
  const browserLive = inBrowser && sessionLive(head?.browser ?? null)
  // The panel beside the dialog only when it has something (owner's request of 26.10.2026): the
  // browser of a task in the browser, or the tabs of the changes that hold anything — a preview in
  // use, files or records of the site to change, checks.
  const changeTabs = inBrowser ? [] : paneTabsOf(head?.preview ?? null, head?.candidate ?? null)
  const hasPane = inBrowser || changeTabs.length > 0
  // Without a panel the switch has nothing to show instead of the dialog.
  const shownView: View = hasPane ? view : 'dialog'
  const paneVisible = hasPane && (wide || shownView === 'preview')
  const stream = useBrowserStream({
    taskId,
    streamUrl: browserStreamUrl,
    live: browserLive,
    visible: paneVisible,
  })
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
  const announcement =
    status === undefined
      ? ''
      : keptFailure !== null
        ? `${feedFailureText[keptFailure.code]} ${feedFailureKeptText}`
        : taskStatusLabel[status]

  function focusPaneTab(tab: PaneTab) {
    // A tab with nothing in it is not drawn: the first one that holds something takes its place.
    const target = changeTabs.includes(tab) ? tab : changeTabs[0]
    if (target === undefined) return
    setPaneTab(target)
    if (!wide) setView('preview')
    window.setTimeout(() => document.getElementById(paneTabId(target))?.focus(), 0)
  }

  // A repeat that the server answers `repeated` is the same words written before (the id is of
  // these very words): they are in the dialog, and the field is cleared like after a first send.
  async function send(text: string, attachmentIds: readonly string[] = []): Promise<boolean> {
    setFieldError(null)
    const files = inBrowser ? [...attachmentIds] : []
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

  /** «Взять управление»: the browser is shown, and the stream asks for the control. */
  function takeControl() {
    setFieldError(null)
    if (!wide) setView('preview')
    stream.take()
  }

  /**
   * «Продолжить работу агента» (Б16): a turn that runs gets the browser back on the stream; a
   * task that waits goes on with the same attempt (`task.resumeAgent`).
   */
  function resumeWork() {
    if (status === 'awaiting_user') void press('resume', resumeAgent.mutateAsync)
    else stream.release()
  }

  // Esc leaves the browser over the content — unless the page itself is being typed into.
  useEffect(() => {
    if (!fullscreen) return
    // The bar of the shell and the list of dialogs are under the browser too: out of the tab
    // order while it covers them (WCAG 2.4.11), as the dialog's own column is.
    const covered = [
      ...(pane.current
        ?.closest('[data-site-shell]')
        ?.querySelectorAll('header, [data-site-list]') ?? []),
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
        focusPaneTab('preview')
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
    onShowChanges: () => focusPaneTab('files'),
    onTakeControl: takeControl,
    onResumeAgent: resumeWork,
    controlling: head?.browser?.controller === 'user',
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

  if (state.missing) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Typography component="h1" sx={{ fontSize: 26, fontWeight: 600 }}>
          {dialogText.notFound}
        </Typography>
        <Typography color="text.secondary">{dialogText.notFoundHint}</Typography>
        <Button
          component={Link}
          href={siteHref(siteId, 'chat')}
          variant="outlined"
          sx={{ alignSelf: 'flex-start' }}
        >
          {dialogText.toList}
        </Button>
      </Box>
    )
  }

  const shownTitle = head?.task.title ?? title ?? listText.untitled
  let composer
  if (head === null) composer = null
  else if (terminal) {
    // A closed dialog keeps the commands it still has — «Отменить выпуск», the preview — behind
    // the button of the field, which takes no words (R9: commands work with the field closed).
    const open = commands.some(
      (command) => command.available && (command.id === 'undo' || command.id === 'preview'),
    )
    composer = (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, py: 1 }}>
        {open ? (
          <Box sx={{ alignSelf: 'stretch' }}>
            <Composer
              placeholder={composerText.newPlaceholder}
              sendLabel={composerText.send}
              disabledReason={feedInputText.finished}
              error={fieldError}
              busy={false}
              onSend={send}
              commands={{
                verdicts: commands,
                onRun: runCommand,
                onOpen: refresh,
                listed: inBrowser ? BROWSER_COMMANDS : undefined,
              }}
            />
          </Box>
        ) : (
          <Typography color="text.secondary" sx={{ textAlign: 'center' }}>
            {feedInputText.finished}
          </Typography>
        )}
        <Button
          component={Link}
          href={`${siteHref(siteId, 'chat')}/new`}
          variant="contained"
          startIcon={<AppIcon name="plus" size={18} />}
        >
          {feedInputText.newDialog}
        </Button>
      </Box>
    )
  } else {
    // A question of the browser is answered in words too: they resume the agent (Б16). Without a
    // question the dialog waits after an answer of a pass that changed nothing (26.10.2026).
    const answering =
      status === 'awaiting_user' &&
      (question === null || question.kind === 'agent' || question.kind === 'browser')
    const revising = status === 'awaiting_approval' && question === null
    const releasing = status === 'deploying' || status === 'verifying'
    const disabledReason = stopping
      ? composerText.stopping
      : question?.kind === 'ceiling'
        ? composerText.ceiling
        : answering || revising
          ? null
          : releasing
            ? composerText.releasing
            : feedInputText.disabled
    composer = (
      <Composer
        placeholder={
          answering
            ? feedQuestionText.placeholder
            : revising
              ? composerText.revisionPlaceholder
              : composerText.newPlaceholder
        }
        sendLabel={answering ? feedQuestionText.send : composerText.send}
        disabledReason={disabledReason}
        error={fieldError}
        busy={message.isPending}
        onSend={send}
        commands={{
          verdicts: commands,
          onRun: runCommand,
          onOpen: refresh,
          listed: inBrowser ? BROWSER_COMMANDS : undefined,
        }}
        attachments={inBrowser ? attachments : undefined}
        noSecrets={inBrowser ? taskWayText.noSecrets : undefined}
      />
    )
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
      }}
    >
      {/* The browser over the whole area covers the switch and the dialog: neither takes focus. */}
      {hasPane ? (
        <Tabs
          value={shownView}
          onChange={(_event, next: View) => setView(next)}
          aria-label={viewSwitchText.label}
          variant="fullWidth"
          inert={fullscreen}
          sx={{
            display: { lg: 'none' },
            mb: 2,
            borderBottom: 1,
            borderColor: 'divider',
            flex: 'none',
          }}
        >
          {(['dialog', 'preview'] as const).map((value) => (
            <Tab
              key={value}
              value={value}
              label={
                value === 'preview' && inBrowser ? (
                  <Box
                    component="span"
                    sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
                  >
                    {browserText.view}
                    {browserLive ? (
                      <>
                        <Box
                          component="span"
                          aria-hidden="true"
                          sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'primary.main' }}
                        />
                        <Box component="span" sx={offScreen}>
                          {`, ${browserText.status.agent.toLocaleLowerCase('ru')}`}
                        </Box>
                      </>
                    ) : null}
                  </Box>
                ) : (
                  viewSwitchText[value]
                )
              }
              aria-controls={viewId(value)}
              sx={{ minHeight: 48, textTransform: 'none', fontSize: 15 }}
            />
          ))}
        </Tabs>
      ) : null}

      <Box
        id={viewId('dialog')}
        inert={fullscreen}
        sx={{
          display: { xs: shownView === 'dialog' ? 'flex' : 'none', lg: 'flex' },
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
          mb: { lg: -3.5 },
        }}
      >
        <Box
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
          }}
        >
          <DialogHead title={shownTitle} head={head} />
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
                      onWatch: wide ? null : () => setView('preview'),
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
            sx={{
              position: 'sticky',
              bottom: 0,
              zIndex: 2,
              mt: 'auto',
              pt: 1.5,
              pb: { xs: 'max(12px, env(safe-area-inset-bottom))', sm: 2 },
              // The field stands on the page itself: what scrolls under it is hidden, never faded.
              bgcolor: 'var(--chat-page, var(--mui-palette-background-paper))',
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

      {hasPane ? (
        <Box
          component="aside"
          ref={pane}
          id={viewId('preview')}
          aria-label={inBrowser ? browserText.label : paneText.label}
          // The shell leaves this panel its room at the right edge only while it is drawn.
          data-site-pane=""
          sx={{
            display: { xs: shownView === 'preview' ? 'flex' : 'none', lg: 'flex' },
            flexDirection: 'column',
            minWidth: 0,
            height: { xs: 'calc(100dvh - 160px)', lg: 'auto' },
            minHeight: { xs: 480, lg: 0 },
            position: { lg: 'fixed' },
            // Under the bar of breadcrumbs, which runs over the panel to the right edge.
            top: { lg: SITE_TOOLBAR_HEIGHT },
            bottom: { lg: 0 },
            right: { lg: 'env(safe-area-inset-right)' },
            width: { lg: SITE_PANE_WIDTH },
            border: { xs: 1, lg: 0 },
            borderLeft: { lg: 1 },
            borderColor: { xs: 'divider', lg: 'divider' },
            borderRadius: { xs: '14px', lg: 0 },
            // The panel holds its edge outside itself: the edge is not cut off.
            overflow: { xs: 'hidden', lg: 'visible' },
            bgcolor: 'background.paper',
            // Over the whole area of the content, the rail beside it; under the windows of MUI.
            ...(fullscreen && {
              position: 'fixed',
              display: 'flex',
              top: 0,
              bottom: 0,
              right: 0,
              left: { xs: 0, sm: `calc(${SITE_RAIL_WIDTH}px + env(safe-area-inset-left))` },
              width: 'auto',
              height: 'auto',
              minHeight: 0,
              border: 0,
              borderRadius: 0,
              zIndex: 1200,
            }),
          }}
        >
          {fullscreen ? null : (
            <PaneResizer
              pane={pane}
              label={inBrowser ? browserText.separator : paneText.separator}
            />
          )}
          <Box
            sx={{
              flex: '1 1 auto',
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {inBrowser ? (
              <BrowserPane
                taskId={taskId}
                siteId={siteId}
                head={head}
                stream={stream}
                configured={browserStreamUrl !== null}
                visible={paneVisible}
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
              />
            ) : (
              <PreviewPane
                taskId={taskId}
                preview={head?.preview ?? null}
                candidate={head?.candidate ?? null}
                tab={paneTab}
                onTab={setPaneTab}
                tabs={changeTabs}
                visible={paneVisible}
                canReset={resetVerdict?.available === true}
                onReset={() => runCommand('reset')}
                resetting={reset.isPending}
              />
            )}
          </Box>
        </Box>
      ) : null}

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
