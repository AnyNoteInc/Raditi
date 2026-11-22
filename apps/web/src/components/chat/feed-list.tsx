'use client'

import type { FeedReleaseOutcome, FeedUpdateOutcome } from '@repo/domain'
import { chatDocumentsOf } from '@repo/domain/tasks/chat-documents'
import { feedFailureTextOf, usageLimitText } from '@repo/domain/tasks/client-feed-failures'
import {
  feedApprovalSiteText,
  feedBrowserButtons,
  feedBrowserQuestionTextOf,
  feedBrowserQuestionTitle,
  feedCancelledSentence,
  feedCandidateText,
  feedCandidateVersionText,
  feedCardTitle,
  feedCeilingButtons,
  feedCeilingText,
  feedCommandText,
  feedEditText,
  feedRedoText,
  feedRewindText,
  feedCreditsSentence,
  feedDecisionText,
  feedDoneSiteText,
  feedEndedSiteText,
  feedFailureKeptText,
  feedFailureOpenTextOf,
  feedFileLeftText,
  feedArtifactLeftText,
  feedDocLeftText,
  feedMemoryLeftText,
  feedRepoLeftText,
  feedPageChangeText,
  feedPageLeftText,
  feedFilesChangedText,
  feedLiveText,
  feedMediaAddedText,
  feedObjectKindLabel,
  feedObjectStatusLabel,
  feedObjectText,
  FEED_QUEUE_TIMEOUT_CLOSING,
  feedQueuedText,
  feedRecordsChangedText,
  feedReleaseKeptText,
  feedReleaseReasonText,
  feedReleaseText,
  feedReleaseTitle,
  feedRowText,
  feedUndoConfirmedText,
  feedUndoKeptText,
  feedUndoReasonText,
  feedUndoText,
  feedUndoTitle,
  feedUpdateText,
  feedUpdateTitle,
  feedVersionBumpLabel,
  feedWorkedText,
  feedDurationText,
  taskStatusLabel,
} from '@repo/domain/tasks/client-feed-labels'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import MuiLink from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { BrandProgress } from '@repo/ui/brand-progress'
import Link from 'next/link'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'

import { ArtifactTurnUndo } from '@/components/artifacts/artifact-turn-undo'
import { AppIcon, type AppIconName } from '@/components/application/app-icon'
import { nbsp } from '@/lib/nbsp'

import { AgentMarkdown } from './agent-markdown'
import { SentFiles, type SentFile } from './attachment-chips'
import { feedTime } from './chat-format'
import { riseIn } from './chat-motion'
import {
  activityText,
  browserText,
  dialogText,
  messageClampText,
  messageEditText,
  objectLinkText,
} from './chat-texts'
import type { FeedRow, ScheduledTaskItem } from './chat-types'
import { offScreen } from './composer'
import {
  feedEntries,
  type CandidateRow,
  type FeedEntry,
  type QuestionRow,
  type StepRow,
} from './feed-model'
import { CopyButton } from './copy-button'
import { FeedDocuments } from './feed-document'
import { workingPhraseOf } from './working-phrases'
import { DocRevisions, docRevisionsOf, FeedDoc } from './feed-doc'
import { FeedFile } from './feed-file'
import { FeedMemoryChange } from './feed-memory'
import { FeedRepoAction, FeedRepoChanges, FeedRepoProposal } from './feed-repo'
import { FeedPage, FeedPageChange, FeedPageWarnings } from './feed-page'
import { FeedScheduleChange, FeedScheduleLeft } from './feed-schedule'
import { FeedScreenshot } from './feed-screenshot'
import type { FeedHeadState } from './feed-state'

// The rows of a dialog and its live block (feed design, «Экраны, которых нет на макетах»; plan
// 53, R9). The client's words stand on the right, everything else on the left. Every text is
// set as text: what the client or the agent wrote is never markup.

/** What the rows can ask the dialog to do. */
export interface FeedActions {
  /** The chat: the cards of its repository read its branch (docs/plan/84-projects.md, ПР13). */
  taskId?: string
  /** «Продолжить» after the platform's question about credits; absent — a closed project (К39). */
  onContinue?: () => void
  /** «Остановить задачу»: `/cancel` with its confirmation. */
  onStop: () => void
  /** «Взять управление» of the task's browser (docs/plan/57-browser-tasks.md, Б15); as above. */
  onTakeControl?: () => void
  /** «Продолжить работу агента» (Б16); as above. */
  onResumeAgent?: () => void
  /**
   * «Открыть» of a document of the agent: the tab «Документы» on that version
   * (docs/plan/67-agent-documents.md, Д4); absent — the document opens in a window of its own.
   */
  onOpenDocument?: (fileId: string) => void
  /** «Открыть» of a document the agent writes: the tab «Документы» on it (docs/plan/74). */
  onOpenAgentDocument?: (docId: string) => void
  /** The document of the agent the tab shows now, on the screen; null — none. */
  shownAgentDocument?: string | null
  /**
   * «Изменить» of the client's last message, sent changed: the words are edited in place, and only
   * «Отправить» takes the turn back (`/undo`) and sends the new words; «Отмена» changes nothing
   * (docs/plan/75-chat-input-output.md, ВВ25). true — sent; absent — not offered.
   */
  onEditLast?: (text: string) => Promise<boolean>
  /** The client controls the task's browser now. */
  controlling?: boolean
  /** The task's browser is open: the control can be taken. */
  browserLive?: boolean
  /** A press of a row is on its way. */
  busy: boolean
  /**
   * «Остановить» was taken and core has not ended the task yet: nothing that would carry the work
   * on is offered meanwhile (docs/plan/57-browser-tasks.md, Б24).
   */
  stopping?: boolean
  /**
   * «Изменить» of the card of a scheduled task: the window of the task over the chat
   * (docs/plan/82-scheduled-tasks.md, Зп35); absent — the card offers none.
   */
  onEditSchedule?: (task: ScheduledTaskItem) => void
  /** «Настроить вручную» of a change the agent could not make: the window of a new task (Зп35). */
  onNewSchedule?: () => void
}

const PLANS_PATH = '/settings/plans'

function Paragraph({ children }: { children: ReactNode }) {
  return (
    <Typography
      sx={{
        m: 0,
        fontSize: 16,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        lineHeight: 1.65,
      }}
    >
      {children}
    </Typography>
  )
}

/** What the agent says: its words straight on the page, no mark and no frame around them. */
function AgentMessage({
  title,
  children,
  actions,
  copy,
}: {
  title: string
  children?: ReactNode
  actions?: ReactNode
  /** The words «Скопировать текст» copies (owner's request of 14.11.2026). */
  copy?: string
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}>
      {/* Read by a screen reader, not shown: the answer of the agent stands as plain text. */}
      <Typography component="h2" sx={offScreen}>
        {title}
      </Typography>
      {children}
      {actions ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 0.5 }}>{actions}</Box>
      ) : null}
      {copy ? (
        // The icon of the 44 px button on the edge of the words, where it stood at 36 px.
        <Box sx={{ display: 'flex', ml: -1.5, mt: -1 }}>
          <CopyButton text={copy} />
        </Box>
      ) : null}
    </Box>
  )
}

/** What the agent or the platform reports: a sign and a title, then the words — on the page too. */
function Card({
  icon,
  title,
  tone = 'text.primary',
  children,
  actions,
}: {
  icon: AppIconName
  title: string
  tone?: 'text.primary' | 'error.main' | 'primary.main'
  children?: ReactNode
  actions?: ReactNode
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minWidth: 0 }}>
      <Typography
        component="h2"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          fontSize: 16,
          lineHeight: 1.5,
          fontWeight: 600,
          color: tone,
        }}
      >
        <AppIcon name={icon} size={18} />
        {title}
      </Typography>
      {children}
      {actions ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 0.5 }}>{actions}</Box>
      ) : null}
    </Box>
  )
}

/** The client's own words on the right, as wide as they are, with the files they sent. */
function Bubble({
  text,
  at,
  now,
  files = [],
  onEdit,
}: {
  text: string
  at: string
  now: Date
  files?: readonly SentFile[]
  /** «Изменить»: the words are edited here and sent changed; true — they went (ВВ25). */
  onEdit?: (text: string) => Promise<boolean>
}) {
  if (onEdit) return <EditableBubble text={text} at={at} now={now} files={files} onEdit={onEdit} />
  return <BubbleView text={text} at={at} now={now} files={files} />
}

/**
 * The client's last message while it may be changed (ВВ25): «Изменить» opens its words in place,
 * «Отмена» leaves everything as it was, «Отправить» sends the changed words instead of these. Nothing
 * of the chat moves before «Отправить».
 */
function EditableBubble({
  text,
  at,
  now,
  files,
  onEdit,
}: {
  text: string
  at: string
  now: Date
  files: readonly SentFile[]
  onEdit: (text: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  if (draft === null)
    return <BubbleView text={text} at={at} now={now} files={files} onEdit={() => setDraft(text)} />
  const changed = draft.trim() !== '' && draft.trim() !== text.trim()
  const submit = async () => {
    if (!changed || sending) return
    setSending(true)
    const sent = await onEdit(draft.trim())
    setSending(false)
    if (sent) setDraft(null)
  }
  return (
    <Box
      sx={{
        alignSelf: 'flex-end',
        width: { xs: '100%', sm: '80%' },
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        px: 2.5,
        py: 1.25,
        borderRadius: '24px',
        bgcolor: 'var(--mui-palette-action-selected)',
      }}
    >
      <Box
        component="textarea"
        aria-label={messageEditText.label}
        value={draft}
        rows={Math.min(8, Math.max(2, draft.split('\n').length))}
        autoFocus
        disabled={sending}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !sending) setDraft(null)
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void submit()
          }
        }}
        sx={{
          font: 'inherit',
          fontSize: 16,
          lineHeight: 1.65,
          color: 'text.primary',
          bgcolor: 'transparent',
          border: 0,
          outline: 'none',
          resize: 'vertical',
          width: '100%',
        }}
      />
      <Typography variant="caption" color="text.secondary">
        {messageEditText.hint}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
        <Button
          size="small"
          onClick={() => setDraft(null)}
          disabled={sending}
          sx={{ minHeight: 44 }}
        >
          {messageEditText.cancel}
        </Button>
        <Button
          size="small"
          variant="contained"
          disableElevation
          loading={sending}
          disabled={!changed}
          onClick={() => void submit()}
          sx={{ minHeight: 44, borderRadius: '999px' }}
        >
          {messageEditText.send}
        </Button>
      </Box>
    </Box>
  )
}

function BubbleView({
  text,
  at,
  now,
  files,
  onEdit,
}: {
  text: string
  at: string
  now: Date
  files: readonly SentFile[]
  onEdit?: () => void
}) {
  return (
    <Box
      sx={{
        alignSelf: 'flex-end',
        maxWidth: '80%',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 0.75,
      }}
    >
      <SentFiles files={files} />
      <Box
        sx={{
          maxWidth: '100%',
          px: 2.5,
          py: 1.25,
          borderRadius: '24px',
          bgcolor: 'var(--mui-palette-action-selected)',
          color: 'text.primary',
        }}
      >
        <ClampedWords text={text} />
      </Box>
      {/* Its buttons are 44 px for a finger: the row moves up by the half of what they grew. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: -1 }}>
        <Typography
          component="time"
          dateTime={at}
          variant="caption"
          color="text.secondary"
          sx={{ fontSize: 12, mr: 0.5 }}
        >
          {feedTime(new Date(at), now)}
        </Typography>
        <CopyButton text={text} />
        {onEdit ? (
          <Button
            size="small"
            onClick={onEdit}
            startIcon={<AppIcon name="pencil" size={16} />}
            sx={{ minHeight: 44, color: 'text.secondary', fontSize: 13 }}
          >
            {messageEditText.edit}
          </Button>
        ) : null}
      </Box>
    </Box>
  )
}

/** The lines a message of the client shows until «Показать полностью» (owner's request of 19.11.2026). */
export const MESSAGE_CLAMP_LINES = 10

/**
 * The client's words, at most `MESSAGE_CLAMP_LINES` lines of them until «Показать полностью»
 * opens the rest; «Свернуть» takes them back. Lines are those on the screen: a long line that
 * wraps counts as it is drawn, so the words are measured after each change of the width.
 */
function ClampedWords({ text }: { text: string }) {
  const words = useRef<HTMLParagraphElement>(null)
  const [open, setOpen] = useState(false)
  // More lines than the limit are long before anything is measured (and where nothing is).
  const manyLines = text.split('\n').length > MESSAGE_CLAMP_LINES
  const [cut, setCut] = useState(manyLines)
  useLayoutEffect(() => {
    const element = words.current
    // Open, the words are whole: what was cut stays known until they are folded again.
    if (element === null || open) return
    const measure = () => setCut(manyLines || element.scrollHeight > element.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [manyLines, open, text])
  return (
    <>
      <Typography
        ref={words}
        component="p"
        data-message-words=""
        sx={{
          m: 0,
          fontSize: 16,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          lineHeight: 1.65,
          ...(open
            ? {}
            : {
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: MESSAGE_CLAMP_LINES,
                overflow: 'hidden',
              }),
        }}
      >
        {text}
      </Typography>
      {cut ? (
        <Button
          size="small"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          endIcon={
            <Box
              component="span"
              sx={{ display: 'flex', transform: open ? 'rotate(180deg)' : 'none' }}
            >
              <AppIcon name="down" size={16} />
            </Box>
          }
          sx={{ minHeight: 44, ml: -1, mb: -1, color: 'text.secondary', fontSize: 13 }}
        >
          {open ? messageClampText.less : messageClampText.more}
        </Button>
      ) : null}
    </>
  )
}

/** A press of the client — a command, «Продолжить», a decision: a quiet line on the right. */
function Press({ text, icon = 'slash' }: { text: string; icon?: AppIconName }) {
  return (
    <Typography
      sx={{
        alignSelf: 'flex-end',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        maxWidth: '80%',
        color: 'text.secondary',
        fontSize: 14,
        textAlign: 'right',
      }}
    >
      <AppIcon name={icon} size={15} />
      {text}
    </Typography>
  )
}

/** A row the page cannot show as it is. */
function Note({ text }: { text: string }) {
  return (
    <Typography variant="body2" color="text.secondary">
      {text}
    </Typography>
  )
}

/** Sentences of a card, those that are there. */
function Sentences({ parts }: { parts: readonly (string | null | undefined)[] }) {
  const text = parts.filter((part): part is string => typeof part === 'string' && part !== '')
  return text.length === 0 ? null : <Paragraph>{nbsp(text.join(' '))}</Paragraph>
}

/** A line that opens what is under it: the turn's stages, «Ход работы». */
function Disclosure({
  summary,
  open,
  onOpen,
  children,
}: {
  summary: ReactNode
  /** Open from the start. */
  open?: boolean
  onOpen?: () => void
  children: ReactNode
}) {
  return (
    <Box
      component="details"
      open={open}
      onToggle={(event: { currentTarget: HTMLElement }) => {
        if ((event.currentTarget as HTMLDetailsElement).open) onOpen?.()
      }}
      sx={{
        color: 'text.secondary',
        fontSize: 14,
        '& > summary': {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.75,
          minHeight: 44,
          cursor: 'pointer',
          listStyle: 'none',
          borderRadius: '8px',
        },
        '& > summary::-webkit-details-marker': { display: 'none' },
        '& > summary:hover': { color: 'text.primary' },
        '& > summary svg': {
          transition: 'transform var(--raditi-motion-base) var(--raditi-ease-out)',
        },
        '&[open] > summary svg': { transform: 'rotate(90deg)' },
        '&[open] > div': riseIn,
      }}
    >
      <summary>
        <AppIcon name="chevron" size={14} />
        {summary}
      </summary>
      {children}
    </Box>
  )
}

function Worked({
  seconds,
  activity,
  details,
}: {
  seconds: number
  /** «Ход работы» of the turn, drawn once the client opens the line. */
  activity?: () => ReactNode
  /** «Подробности работы» (`/details`): the line stands open. */
  details: boolean
}) {
  const [opened, setOpened] = useState(false)
  // The line opens straight on what the agent did (owner's request of 14.11.2026): the stages and
  // the heading «Ход работы» are the platform's words, not the client's.
  return (
    <Disclosure summary={feedWorkedText(seconds)} open={details} onOpen={() => setOpened(true)}>
      <Box
        sx={{
          ml: 0.75,
          pl: 2,
          pb: 1,
          borderLeft: 1,
          borderColor: 'divider',
          display: 'grid',
          gap: 0.75,
          minWidth: 0,
        }}
        aria-label={activityText.title}
      >
        {(opened || details) && activity ? activity() : null}
      </Box>
    </Disclosure>
  )
}

function ceilingButtons(
  question: Extract<QuestionRow, { kind: 'ceiling' }>,
  actions: FeedActions,
): ReactNode {
  const words = feedCeilingButtons[question.reason]
  const stop = (
    <Button
      key="stop"
      variant="outlined"
      onClick={actions.onStop}
      disabled={actions.busy || actions.stopping}
    >
      {words.stop}
    </Button>
  )
  const next = actions.onContinue ? (
    <Button
      key="next"
      variant="contained"
      onClick={actions.onContinue}
      loading={actions.busy}
      disabled={actions.stopping}
    >
      {feedCeilingButtons.step.next}
    </Button>
  ) : null
  switch (question.reason) {
    case 'step':
      return [next, stop]
    case 'credits':
    case 'gift':
      // The way to more credits is on «Тарифы»; after it the work goes on with «Продолжить».
      return [
        <Button key="buy" variant="outlined" component={Link} href={PLANS_PATH}>
          {words.next}
        </Button>,
        next,
        stop,
      ]
    case 'attempts':
      return [stop]
  }
}

function QuestionCard({
  row,
  open,
  withSite,
  actions,
}: {
  row: QuestionRow
  open: boolean
  withSite: boolean
  actions: FeedActions
}) {
  if (row.kind === 'ceiling') {
    return (
      <Card
        icon="warning"
        title={taskStatusLabel.awaiting_user}
        tone={open ? 'primary.main' : 'text.primary'}
        actions={open ? ceilingButtons(row, actions) : undefined}
      >
        <Paragraph>{nbsp(feedCeilingText(row))}</Paragraph>
      </Card>
    )
  }
  if (row.kind === 'browser')
    return <BrowserQuestionCard row={row} open={open} withSite={withSite} actions={actions} />
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Card
        icon="chat"
        title={feedCardTitle.question}
        tone={open ? 'primary.main' : 'text.primary'}
      >
        <Paragraph>{row.intro}</Paragraph>
        {row.questions.length === 1 ? (
          <Paragraph>{row.questions[0]!.text}</Paragraph>
        ) : (
          <Box component="ol" sx={{ m: 0, pl: 3, display: 'grid', gap: 0.5 }}>
            {row.questions.map((question, index) => (
              <Box
                component="li"
                key={index}
                sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                {question.text}
              </Box>
            ))}
          </Box>
        )}
      </Card>
    </Box>
  )
}

/**
 * A question of a task in the browser (docs/plan/57-browser-tasks.md, Б23): the agent asks the
 * client to sign in, pass a check or confirm something there, or the platform stops the work.
 * While it is open the card offers the control of the browser, which opens the browser too, or
 * gives it back. The browser itself opens from «+» and by itself as it starts (docs/plan/59, И12,
 * owner's answer of 30.10.2026: one way to open it, as every other tool).
 */
function BrowserQuestionCard({
  row,
  open,
  withSite,
  actions,
}: {
  row: Extract<QuestionRow, { kind: 'browser' }>
  open: boolean
  withSite: boolean
  actions: FeedActions
}) {
  const help = row.reason !== 'unconfirmed'
  let button: ReactNode = null
  if (open && help && actions.controlling && actions.onResumeAgent) {
    button = (
      <Button
        variant="contained"
        onClick={actions.onResumeAgent}
        loading={actions.busy}
        disabled={actions.stopping}
      >
        {feedBrowserButtons.resume}
      </Button>
    )
  } else if (
    open &&
    help &&
    row.reason !== 'control' &&
    actions.browserLive &&
    actions.onTakeControl
  ) {
    button = (
      <Button
        variant="contained"
        onClick={actions.onTakeControl}
        disabled={actions.busy || actions.stopping}
      >
        {feedBrowserButtons.take}
      </Button>
    )
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Card
        icon={row.reason === 'unconfirmed' ? 'warning' : 'globe'}
        title={feedBrowserQuestionTitle[row.reason]}
        tone={open ? 'primary.main' : 'text.primary'}
        actions={button ?? undefined}
      >
        <Paragraph>{nbsp(feedBrowserQuestionTextOf(row.reason, withSite))}</Paragraph>
        {row.message ? <Paragraph>{row.message}</Paragraph> : null}
      </Card>
      {open && row.reason === 'login' ? (
        <Typography variant="body2" color="text.secondary">
          {nbsp(browserText.helpSecret)}
        </Typography>
      ) : null}
    </Box>
  )
}

/** A feed object as the row read it: its kind and state may be ones this page does not know. */
type ShownObject = {
  kind: 'post' | 'page' | null
  title: string | null
  status: keyof typeof feedObjectStatusLabel | null
  url?: string
  editUrl?: string
}

/**
 * What a task in the browser left on the site, as the platform read it there (Б23, Б24): the
 * kind, the title and the state of each object, with links to it and to its editor.
 */
function SiteObjects({ objects, heading }: { objects: readonly ShownObject[]; heading: string }) {
  if (objects.length === 0) return null
  const linkSx = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 0.5,
    minHeight: 44,
  } as const
  return (
    <Box component="section" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Typography component="h3" sx={{ fontSize: 14, fontWeight: 600, color: 'text.secondary' }}>
        {heading}
      </Typography>
      <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 1 }}>
        {objects.map((object, index) => (
          <Box
            component="li"
            key={index}
            sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}
          >
            <Typography sx={{ overflowWrap: 'anywhere' }}>
              {object.kind === null ? feedObjectText.otherKind : feedObjectKindLabel[object.kind]} «
              {object.title ?? feedObjectText.untitled}»
              {object.status === null ? null : (
                <Box component="span" sx={{ color: 'text.secondary' }}>
                  {' — '}
                  {feedObjectStatusLabel[object.status].toLocaleLowerCase('ru')}
                </Box>
              )}
            </Typography>
            {object.url || object.editUrl ? (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '0 16px' }}>
                {object.url ? (
                  <MuiLink href={object.url} target="_blank" rel="noopener noreferrer" sx={linkSx}>
                    {objectLinkText.open(object.kind)}
                    <AppIcon name="arrow" size={16} />
                  </MuiLink>
                ) : null}
                {object.editUrl ? (
                  <MuiLink
                    href={object.editUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    sx={linkSx}
                  >
                    {objectLinkText.edit}
                    <AppIcon name="arrow" size={16} />
                  </MuiLink>
                ) : null}
              </Box>
            ) : null}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

/**
 * The changes of a chat of a project that is no more (docs/plan/83-remove-projects.md): a row of
 * its history, nothing to do with it.
 */
function CandidateCard({ row }: { row: CandidateRow }) {
  const changed = row.files.added + row.files.modified + row.files.deleted
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Card icon="eye" title={feedCandidateText.title} tone="text.primary">
        <Paragraph>
          {nbsp(feedCandidateVersionText(row.version))}
          {row.bump ? ` (${feedVersionBumpLabel[row.bump].toLocaleLowerCase('ru')})` : ''}.
        </Paragraph>
        <Box
          component="ul"
          sx={{ m: 0, pl: 2.5, color: 'text.secondary', display: 'grid', gap: 0.25 }}
        >
          {changed > 0 ? <li>{nbsp(feedFilesChangedText(changed))}</li> : null}
          {row.media > 0 ? <li>{nbsp(feedMediaAddedText(row.media))}</li> : null}
          {row.records > 0 ? <li>{nbsp(feedRecordsChangedText(row.records))}</li> : null}
        </Box>
      </Card>
    </Box>
  )
}

const releaseIcon: Readonly<Record<FeedReleaseOutcome, AppIconName>> = {
  installed: 'check',
  rolled_back: 'changes',
  failed: 'warning',
  unknown: 'clock',
  refused: 'warning',
}

const updateIcon: Readonly<Record<FeedUpdateOutcome, AppIconName>> = {
  emptied: 'check',
  conflict: 'warning',
  current: 'check',
  withdrawn: 'clock',
  failed: 'warning',
  rewind_failed: 'warning',
  redo_failed: 'warning',
}

function RowView({
  row,
  now,
  openQuestionId,
  actions,
  filesOf,
  editable = false,
  pushHere = false,
}: {
  row: FeedRow
  now: Date
  openQuestionId: string | null
  actions: FeedActions
  filesOf: (ids: readonly string[]) => SentFile[]
  /** The client's last message, while `/undo` can take it back: «Изменить» under it (ВВ25). */
  editable?: boolean
  /** The card of a scheduled task that offers notifications in this browser (Зп36). */
  pushHere?: boolean
}) {
  switch (row.type) {
    case 'feed.request':
      switch (row.kind) {
        case 'first':
        case 'answer':
        case 'revision':
        case 'queued':
          return (
            <Bubble
              text={row.text}
              at={row.at}
              now={now}
              files={filesOf(row.attachments ?? [])}
              {...(editable && actions.onEditLast ? { onEdit: actions.onEditLast } : {})}
            />
          )
        case 'retry':
          return <Press text={feedRowText.retry} icon="back" />
        case 'continue':
          return <Press text={feedRowText.continue} icon="back" />
        case 'resume':
          return <Press text={feedRowText.resume} icon="back" />
        case 'interrupt':
          return <Press text={feedRowText.interrupt} icon="back" />
        case 'command':
        case 'agent_command':
          return (
            <Press
              text={row.command === null ? feedRowText.otherRequest : feedCommandText[row.command]}
            />
          )
        case 'other':
          return row.text ? (
            <Bubble text={row.text} at={row.at} now={now} />
          ) : (
            <Press text={feedRowText.otherRequest} />
          )
      }
      return null
    case 'feed.question':
      return (
        <QuestionCard
          row={row}
          open={row.id === openQuestionId}
          withSite={false}
          actions={actions}
        />
      )
    case 'feed.result': {
      const approval = row.next === 'awaiting_approval'
      // A pass that changed nothing left the dialog open for the next words (26.10.2026).
      const open = row.next === 'awaiting_user'
      const site = approval ? feedApprovalSiteText[row.site] : feedDoneSiteText[row.site]
      return (
        <AgentMessage
          copy={row.message}
          title={
            approval ? feedCardTitle.approval : open ? feedCardTitle.answer : feedCardTitle.result
          }
        >
          <AgentMarkdown text={row.message} />
          <Sentences
            parts={[
              site,
              // No change in git, not a word of files (docs/plan/61-chats-first.md, К19).
              open || !row.filesChanged ? null : feedFilesChangedText(row.filesChanged),
            ]}
          />
          <SiteObjects objects={row.objects ?? []} heading={feedObjectText.result} />
        </AgentMessage>
      )
    }
    case 'feed.failure':
      return (
        <Card icon="warning" title={feedCardTitle.failure} tone="error.main">
          <Sentences
            parts={[
              // A window of the workspace names when the work goes on (plan 71).
              row.code === 'usage_limit' && row.window
                ? usageLimitText(row.window.kind, new Date(row.window.resetsAt))
                : feedFailureTextOf(row.code, false),
              feedEndedSiteText[row.site],
              feedCreditsSentence(row.credits),
              // The dialog kept its candidate: the card of the changes above says what to do.
              row.next === 'awaiting_approval' ? feedFailureKeptText : null,
              // The dialog stays open: the client writes «продолжи» (28.10.2026).
              row.next === 'awaiting_user' ? feedFailureOpenTextOf(row.code) : null,
            ]}
          />
          <SiteObjects objects={row.objects ?? []} heading={feedObjectText.ended} />
        </Card>
      )
    case 'feed.cancelled':
      return (
        <Card icon="stop" title={feedCardTitle.cancelled}>
          <Sentences
            parts={[
              feedCancelledSentence(row.by),
              feedEndedSiteText[row.site],
              feedCreditsSentence(row.credits),
              row.by === 'queue_timeout' ? FEED_QUEUE_TIMEOUT_CLOSING : null,
            ]}
          />
          <SiteObjects objects={row.objects ?? []} heading={feedObjectText.ended} />
        </Card>
      )
    case 'feed.candidate':
      return <CandidateCard row={row} />
    case 'feed.decision':
      return <Press text={feedDecisionText(row.version)} icon="check" />
    case 'feed.release':
      return (
        <Card
          icon={releaseIcon[row.outcome]}
          title={feedReleaseTitle[row.outcome]}
          tone={
            row.outcome === 'installed'
              ? 'text.primary'
              : row.outcome === 'unknown'
                ? 'primary.main'
                : 'error.main'
          }
        >
          <Sentences
            parts={[
              feedReleaseText(row.outcome, row.version),
              row.reason === null ? null : feedReleaseReasonText[row.reason],
              ...feedReleaseKeptText(row.kept),
              feedCreditsSentence(row.credits),
            ]}
          />
        </Card>
      )
    case 'feed.undo':
      if (row.stage === 'confirmed')
        return <Press text={feedUndoConfirmedText(row.undoneVersion)} icon="back" />
      return (
        <Card
          icon={releaseIcon[row.stage]}
          title={feedUndoTitle[row.stage]}
          tone={
            row.stage === 'installed'
              ? 'text.primary'
              : row.stage === 'unknown'
                ? 'primary.main'
                : 'error.main'
          }
        >
          <Sentences
            parts={[
              feedUndoText(row.stage, {
                undone: row.undoneVersion,
                version: row.version,
                returnsTo: row.returnsTo,
              }),
              row.reason === null ? null : feedUndoReasonText(row.reason),
              row.stage === 'installed' ? feedUndoKeptText(row.records.kept) : null,
            ]}
          />
        </Card>
      )
    case 'feed.update':
      return (
        <Card
          icon={updateIcon[row.outcome]}
          title={feedUpdateTitle[row.outcome]}
          tone={
            row.outcome === 'conflict' ||
            row.outcome === 'failed' ||
            row.outcome === 'rewind_failed' ||
            row.outcome === 'redo_failed'
              ? 'error.main'
              : 'text.primary'
          }
        >
          <Sentences parts={[feedUpdateText(row.outcome, row.conflicts)]} />
        </Card>
      )
    case 'feed.screenshot':
      return (
        <FeedScreenshot
          screenshotId={row.screenshotId}
          number={row.number}
          width={row.width}
          height={row.height}
        />
      )
    // A file the agent made for the client (docs/plan/66-chat-visuals.md, В8).
    case 'feed.file':
      return <FeedFile fileId={row.fileId} name={row.name} sizeBytes={row.sizeBytes} />
    // Not all the files of the agent came (docs/plan/66-chat-visuals.md, В8): its message may say they did.
    case 'feed.file_left':
      return <Note text={feedFileLeftText(row)} />
    // A page the agent published (docs/plan/69-pages.md, Ст23): its card.
    case 'feed.page':
      return (
        <>
          <FeedPage pageId={row.pageId} title={row.title} version={row.version} kind={row.kind} />
          {row.warnings ? <FeedPageWarnings warnings={row.warnings} /> : null}
        </>
      )
    case 'feed.page_left':
      return <Note text={feedPageLeftText(row)} />
    // The agent changed a page of a site (docs/plan/73-pages-sites.md, Дер27).
    case 'feed.page_change':
      return (
        <FeedPageChange pageId={row.pageId} text={feedPageChangeText(row)} change={row.change} />
      )
    // A scheduled task the agent created, changed or could not (docs/plan/82-scheduled-tasks.md,
    // Зп35): its card, and the control of notifications on the newest one (Зп36).
    case 'feed.schedule_change':
      return (
        <FeedScheduleChange
          row={row}
          now={now}
          push={pushHere}
          {...(actions.onEditSchedule ? { onEdit: actions.onEditSchedule } : {})}
        />
      )
    case 'feed.schedule_left':
      return (
        <FeedScheduleLeft
          row={row}
          {...(actions.onNewSchedule ? { onSetUp: actions.onNewSchedule } : {})}
        />
      )
    // A document the agent writes (docs/plan/69-pages.md, Ст22): its card stands after the answer
    // of the turn that wrote it (`feedEntries`), the rows themselves show nothing.
    case 'feed.doc':
    case 'feed.doc_touch':
    case 'feed.artifact':
      return null
    case 'feed.doc_left':
      return <Note text={feedDocLeftText(row)} />
    // Writes of the turn the check sent back (docs/plan/88-artifacts.md, Ар19): never why.
    case 'feed.artifact_left':
      return <Note text={feedArtifactLeftText(row)} />
    // What the end of a pass did with the memory (docs/plan/84-projects.md, ПР18; P-chat).
    case 'feed.memory_change':
      return <FeedMemoryChange entryId={row.entryId} action={row.action} text={row.text} />
    case 'feed.memory_left':
      return <Note text={feedMemoryLeftText(row)} />
    // What a turn left in the chat's branch, and changes it did not keep (docs/plan/84-projects.md,
    // ПР12, ПР26): the card «Изменения в ветке» with its buttons (ПР13).
    case 'feed.repo_changes':
      return <FeedRepoChanges taskId={actions.taskId} row={row} />
    case 'feed.repo_proposal':
      return (
        <FeedRepoProposal taskId={actions.taskId} title={row.title} description={row.description} />
      )
    case 'feed.repo_action':
      return <FeedRepoAction kind={row.kind} state={row.state} url={row.url} error={row.error} />
    case 'feed.repo_left':
      return <Note text={feedRepoLeftText(row)} />
    case 'feed.rewind':
      return (
        <>
          <Note text={feedRewindText(row)} />
          {/* The edits of the turn in artifacts stay: undone in their history (Ар13). */}
          {actions.taskId ? <ArtifactTurnUndo taskId={actions.taskId} turn={row.turn} /> : null}
        </>
      )
    case 'feed.redo':
      return <Note text={feedRedoText(row)} />
    // The client's edit of a file in «Терминал» (06.11.2026).
    case 'feed.edit':
      return <Note text={feedEditText(row)} />
    case 'newer':
      return <Note text={feedRowText.newer} />
    case 'unreadable':
      return <Note text={feedRowText.unreadable} />
    case 'feed.step':
    case 'skipped':
      return null
  }
}

/** The rows of a dialog, top to bottom. */
export function FeedList({
  head,
  rows,
  openQuestionId,
  actions,
  filesOf = noFiles,
  details = false,
  activityOf,
}: {
  head: FeedHeadState | null
  rows: readonly FeedRow[]
  openQuestionId: string | null
  actions: FeedActions
  /** The files a message sent, by their ids, as their chips name them. */
  filesOf?: (ids: readonly string[]) => SentFile[]
  /** «Подробности работы» (`/details`): «Ход работы» of finished turns stands open. */
  details?: boolean
  /** «Ход работы» of a finished turn (owner's decision of 26.10.2026). */
  activityOf?: (turn: number) => ReactNode
}) {
  const now = new Date()
  const entries: FeedEntry[] = feedEntries(rows, head)
  const documents = useMemo(() => chatDocumentsOf(rows), [rows])
  const commands = head?.commands ?? []
  // «Изменить» stands under the client's last message while `/undo` can take its turn back.
  const editableId =
    commands.find((command) => command.id === 'turn_undo')?.available === true
      ? lastMessageId(rows)
      : null
  // The rows of the first paint stay still; a row that arrives later rises into its place. The
  // animation plays once, when its element mounts: later renders do not start it again.
  const [initial] = useState(() => new Set(entries.map((entry) => entry.key)))
  // The documents of the chat read themselves again when a change of them comes (Ст22).
  const revisions = docRevisionsOf(
    rows as readonly { type: string; docId?: string; revision?: number }[],
  )
  // «Включить в этом браузере» once in the chat, on its newest card of a task that stays (Зп36).
  const pushRowId = schedulePushRowId(rows)
  return (
    <DocRevisions.Provider value={revisions}>
      <Box
        component="ol"
        aria-label="Сообщения чата"
        sx={{
          m: 0,
          p: 0,
          listStyle: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: { xs: 3, md: 4 },
        }}
      >
        {entries.map((entry) => (
          <Box
            component="li"
            key={entry.key}
            // Where the dialog keeps its place when the area around the rows changes (docs/plan/59,
            // И19): the row at the top of the screen stays there.
            data-feed-row=""
            sx={{
              display: 'flex',
              flexDirection: 'column',
              minWidth: 0,
              ...(initial.has(entry.key) ? {} : riseIn),
            }}
          >
            {entry.kind === 'documents' ? (
              <FeedDocuments
                fileIds={entry.fileIds}
                documents={documents}
                {...(actions.onOpenDocument ? { onOpen: actions.onOpenDocument } : {})}
              />
            ) : entry.kind === 'agentDocs' ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                {entry.docIds.map((docId) => (
                  <FeedDoc
                    key={docId}
                    docId={docId}
                    open={actions.shownAgentDocument === docId}
                    {...(actions.onOpenAgentDocument
                      ? { onOpen: actions.onOpenAgentDocument }
                      : {})}
                  />
                ))}
              </Box>
            ) : entry.kind === 'worked' ? (
              <Worked
                seconds={entry.seconds}
                activity={activityOf ? () => activityOf(entry.turn) : undefined}
                details={details}
              />
            ) : (
              <RowView
                row={entry.row}
                now={now}
                openQuestionId={openQuestionId}
                actions={actions}
                filesOf={filesOf}
                editable={entry.row.id === editableId}
                pushHere={entry.row.id === pushRowId}
              />
            )}
          </Box>
        ))}
      </Box>
    </DocRevisions.Provider>
  )
}

/**
 * The newest card of a scheduled task the agent created or changed — not deleted — in the feed:
 * it alone offers notifications in this browser (docs/plan/82-scheduled-tasks.md, Зп36), so a chat
 * of several tasks does not repeat the button. null — none.
 */
export function schedulePushRowId(rows: readonly FeedRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!
    if (row.type === 'feed.schedule_change' && row.action !== 'deleted') return row.id
  }
  return null
}

/** The id of the client's last message with words — not a press — in the feed; null — none. */
export function lastMessageId(rows: readonly FeedRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    if (row?.type !== 'feed.request') continue
    if (
      row.kind === 'first' ||
      row.kind === 'answer' ||
      row.kind === 'revision' ||
      row.kind === 'queued'
    )
      return row.id
  }
  return null
}

/** Files of a message whose names are not read: a chip each, nameless. */
const noFiles = (ids: readonly string[]): SentFile[] =>
  ids.map((id) => ({ id, name: null, size: null, kind: 'document' as const }))

/**
 * The line under the work of the agent: a phrase of what it is doing that changes every few
 * seconds, shimmering while it works, and the time. The live region announces the status, not
 * the phrase: `label` is what is read aloud.
 */
function WorkingLine({ turn, seconds, label }: { turn: number; seconds: number; label: string }) {
  return (
    <Box
      sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}
      role="status"
      aria-label={label}
    >
      {/* The moving mark of Радити beside the phrase (owner, 15.11.2026). */}
      <Box aria-hidden="true" sx={{ display: 'flex', flexShrink: 0 }}>
        <BrandProgress size={20} variant="spiral" />
      </Box>
      <Typography
        component="span"
        aria-hidden="true"
        sx={{
          fontSize: 15,
          fontWeight: 500,
          lineHeight: 1.5,
          color: 'text.secondary',
          '@media (prefers-reduced-motion: no-preference)': {
            backgroundImage:
              'linear-gradient(90deg, var(--mui-palette-text-secondary) 0%, var(--mui-palette-text-secondary) 40%, var(--mui-palette-text-primary) 50%, var(--mui-palette-text-secondary) 60%, var(--mui-palette-text-secondary) 100%)',
            backgroundSize: '250% 100%',
            backgroundClip: 'text',
            WebkitBackgroundClip: 'text',
            color: 'transparent',
            animation: 'raditi-working-shimmer 2.4s linear infinite',
            '@keyframes raditi-working-shimmer': {
              from: { backgroundPosition: '100% 0' },
              to: { backgroundPosition: '-150% 0' },
            },
          },
        }}
      >
        {workingPhraseOf(turn, seconds)}
      </Typography>
      <Typography
        component="span"
        aria-hidden="true"
        sx={{ color: 'text.secondary', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}
      >
        {feedDurationText(seconds)}
      </Typography>
    </Box>
  )
}

/** Seconds since a moment, counted on the client while `on`. */
function useSecondsSince(since: string | null, on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [on])
  if (since === null) return 0
  const start = Date.parse(since)
  return Number.isFinite(start) ? Math.max(0, (now - start) / 1000) : 0
}

/**
 * The live block under the rows: drawn from the head of the chat, never stored. The queue, the
 * preparation, the work and its time. `stopping` —
 * the client pressed `/cancel` and the work is being stopped: the block says so instead.
 */
export function LiveBlock({
  head,
  stopping = false,
  browser,
  activity,
}: {
  head: FeedHeadState
  /** The stages of the turn: no longer shown (owner's request of 14.11.2026). */
  steps?: readonly StepRow[]
  stopping?: boolean
  /** «Ход работы» of the turn at work, as it goes (owner's decision of 26.10.2026). */
  activity?: ReactNode
  /** A task in the browser (docs/plan/57-browser-tasks.md): who drives it. */
  browser?: {
    /** The client controls the browser: the agent waits for «Продолжить работу агента». */
    controlling: boolean
    onResume: () => void
    busy: boolean
  }
}) {
  const { task } = head
  const running = task.status === 'running'
  const seconds = useSecondsSince(task.runningSince, running && !task.held)
  let text: string | null
  let body: ReactNode = null
  let title: string = taskStatusLabel[task.status]
  switch (task.status) {
    case 'queued':
      text = stopping ? dialogText.stoppedHint : feedQueuedText(task.waiting, false)
      break
    case 'preparing':
      text = stopping ? dialogText.stoppedHint : null
      break
    case 'running':
      if (stopping) text = dialogText.stoppedHint
      else if (task.held) text = feedLiveText.heldNoSite
      else if (browser?.controlling) {
        title = browserText.status.user
        text = browserText.controlPlate
        body = (
          <Button
            variant="contained"
            onClick={browser.onResume}
            disabled={browser.busy}
            sx={{ alignSelf: 'flex-start' }}
          >
            {feedBrowserButtons.resume}
          </Button>
        )
      } else {
        // What the agent does stands in the feed as it comes, no folding and no scrolling of its
        // own (owner's request of 09.11.2026); under it a word of what it is doing and the time,
        // in place of «Агент работает» and the stages (owner, 14.11.2026), with the moving mark of
        // Радити beside it (owner, 15.11.2026). The
        // finished turn folds it under «Агент работал …».
        return (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minWidth: 0, ...riseIn }}>
            {activity ? <Box sx={{ minWidth: 0 }}>{activity}</Box> : null}
            <WorkingLine turn={task.turnNo} seconds={seconds} label={title} />
          </Box>
        )
      }
      break
    default:
      return null
  }
  // The agent at work has the moving mark of Raditi before its status (owner's request of
  // 09.11.2026, in place of a pulsing dot); a wait for the client stands still. One stage, one
  // looped trajectory (owner, 09.11.2026): preparing and work.
  const working = !browser?.controlling && !task.held && !stopping
  const motion: ComponentProps<typeof BrandProgress>['variant'] =
    task.status === 'running' ? 'spiral' : 'orbits'
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minWidth: 0, ...riseIn }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0 }}>
        {working ? <BrandProgress size={22} variant={motion} /> : null}
        <Typography component="h2" sx={{ fontSize: 16, fontWeight: 600, lineHeight: 1.5 }}>
          {title}
        </Typography>
        {running && !task.held && task.runningSince !== null ? (
          // The timer is not read aloud: the live region announces the status, not the seconds.
          <Typography
            component="span"
            aria-hidden="true"
            sx={{ color: 'text.secondary', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}
          >
            {feedDurationText(seconds)}
          </Typography>
        ) : null}
      </Box>
      {text ? (
        <Typography color="text.secondary" sx={{ fontSize: 15, lineHeight: 1.6 }}>
          {nbsp(text)}
        </Typography>
      ) : null}
      {body}
    </Box>
  )
}
