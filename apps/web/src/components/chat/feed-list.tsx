'use client'

import type { ChatCommandId, FeedReleaseOutcome, FeedUpdateOutcome } from '@repo/domain'
import {
  chatCommandRefusalText,
  chatCommands,
  type ChatCommandRefusal,
} from '@repo/domain/release/chat-commands'
import { feedFailureText } from '@repo/domain/tasks/client-feed-failures'
import {
  feedApprovalSiteText,
  feedBrowserButtons,
  feedBrowserQuestionText,
  feedBrowserQuestionTitle,
  feedCancelledSentence,
  feedCandidateText,
  feedCandidateVersionText,
  feedCardTitle,
  feedCeilingButtons,
  feedCeilingText,
  feedCommandText,
  feedCreditsSentence,
  feedDecisionText,
  feedDoneSiteText,
  feedEndedSiteText,
  feedFailureKeptText,
  feedFilesChangedText,
  feedLiveText,
  feedMediaAddedText,
  feedObjectKindLabel,
  feedObjectStatusLabel,
  feedObjectText,
  feedQuestionText,
  FEED_QUEUE_TIMEOUT_CLOSING,
  feedQueuedText,
  feedRecordsChangedText,
  feedReleaseKeptText,
  feedReleaseReasonText,
  feedReleaseText,
  feedReleaseTitle,
  feedRetryText,
  feedRowText,
  feedStateText,
  feedStepLabel,
  feedUndoConfirmedText,
  feedUndoKeptText,
  feedUndoReasonText,
  feedUndoText,
  feedUndoTitle,
  feedUpdateText,
  feedUpdateTitle,
  feedVersionBumpLabel,
  feedVersionText,
  feedWorkedText,
  feedDurationText,
  taskStatusLabel,
} from '@repo/domain/tasks/client-feed-labels'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import MuiLink from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import Link from 'next/link'
import { useEffect, useState, type ReactNode } from 'react'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'
import { nbsp } from '@/lib/nbsp'

import { SentFiles, type SentFile } from './attachment-chips'
import { dayTime, feedTime } from './chat-format'
import {
  browserText,
  dialogText,
  objectLinkText,
  ownText,
  releaseStatusText,
  releaseStepText,
  undoText,
} from './chat-texts'
import type { CommandVerdict, FeedRow, UndoHead } from './chat-types'
import {
  feedEntries,
  type CandidateRow,
  type FeedEntry,
  type QuestionRow,
  type StepRow,
} from './feed-model'
import type { FeedHeadState } from './feed-state'

// The rows of a dialog and its live block (feed design, «Экраны, которых нет на макетах»; plan
// 53, R9). The client's words stand on the right, everything else on the left. Every text is
// set as text: what the client or the agent wrote is never markup.

/** What the rows can ask the dialog to do. */
export interface FeedActions {
  /** «Продолжить» after the platform's question about credits. */
  onContinue: () => void
  /** «Попробовать ещё» of the failure with this row id (docs/plan/53, «Попробовать ещё»). */
  onRetry: (failureEventId: string) => void
  /** «Остановить задачу»: `/cancel` with its confirmation. */
  onStop: () => void
  /** «Выпустить новую версию». */
  onRelease: () => void
  /** «Обновить рабочую копию». */
  onUpdate: () => void
  /** «Отменить выпуск» of the installed version of the dialog. */
  onUndo: () => void
  /** «Посмотреть изменения»: the panel beside the dialog. */
  onShowChanges: () => void
  /** «Взять управление» of the task's browser (docs/plan/57-browser-tasks.md, Б15). */
  onTakeControl?: () => void
  /** «Продолжить работу агента» (Б16). */
  onResumeAgent?: () => void
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
}

const PLANS_PATH = '/settings/plans'

function Paragraph({ children }: { children: ReactNode }) {
  return (
    <Typography sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.55 }}>
      {children}
    </Typography>
  )
}

/** A card of the agent or of the platform: a sign and a title, then what it says. */
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
    <Box
      sx={{
        alignSelf: 'stretch',
        maxWidth: 720,
        p: { xs: 2, sm: 2.5 },
        border: 1,
        borderColor: 'divider',
        borderRadius: '14px',
        bgcolor: 'background.default',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      <Typography
        component="h2"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          fontSize: 16,
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

/** The client's own words, on the right, with the files they sent. */
function Bubble({
  text,
  at,
  now,
  files = [],
}: {
  text: string
  at: string
  now: Date
  files?: readonly SentFile[]
}) {
  return (
    <Box
      sx={{
        alignSelf: 'flex-end',
        maxWidth: '85%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 0.75,
      }}
    >
      <SentFiles files={files} />
      <Box
        sx={{
          px: 2,
          py: 1.25,
          borderRadius: '14px 14px 4px 14px',
          bgcolor: 'text.primary',
          color: 'background.paper',
        }}
      >
        <Typography
          component="p"
          sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5 }}
        >
          {text}
        </Typography>
      </Box>
      <Typography
        component="time"
        dateTime={at}
        variant="caption"
        color="text.secondary"
        sx={{ alignSelf: 'flex-end', mt: 0.5 }}
      >
        {feedTime(new Date(at), now)}
      </Typography>
    </Box>
  )
}

/** A press of the client — a command, «Продолжить», a decision: a line on the right. */
function Press({ text, icon = 'slash' }: { text: string; icon?: AppIconName }) {
  return (
    <Typography
      sx={{
        alignSelf: 'flex-end',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        maxWidth: '85%',
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
    <Typography
      variant="body2"
      color="text.secondary"
      sx={{
        px: 2,
        py: 1.25,
        border: 1,
        borderStyle: 'dashed',
        borderColor: 'divider',
        borderRadius: '12px',
      }}
    >
      {text}
    </Typography>
  )
}

/** Sentences of a card, those that are there. */
function Sentences({ parts }: { parts: readonly (string | null | undefined)[] }) {
  const text = parts.filter((part): part is string => typeof part === 'string' && part !== '')
  return text.length === 0 ? null : <Paragraph>{nbsp(text.join(' '))}</Paragraph>
}

function StepList({ steps, running }: { steps: readonly StepRow[]; running: boolean }) {
  return (
    <Box component="ol" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 0.5 }}>
      {steps.map((step, index) => {
        const current = running && index === steps.length - 1
        return (
          <Box
            component="li"
            key={step.id}
            sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 14 }}
          >
            {current ? (
              <CircularProgress size={14} aria-hidden="true" />
            ) : (
              <AppIcon name="check" size={16} />
            )}
            <span>{feedStepLabel[step.step]}</span>
          </Box>
        )
      })}
    </Box>
  )
}

function Worked({ steps, seconds }: { steps: readonly StepRow[]; seconds: number }) {
  return (
    <Box
      component="details"
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
        },
        '& > summary::-webkit-details-marker': { display: 'none' },
        '&[open] > summary svg': { transform: 'rotate(90deg)' },
      }}
    >
      <summary>
        <AppIcon name="chevron" size={14} />
        {feedWorkedText(seconds)}
      </summary>
      <Box sx={{ pl: 2.5, pb: 1 }} aria-label={dialogText.stages}>
        <StepList steps={steps} running={false} />
      </Box>
    </Box>
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
  const next = (
    <Button
      key="next"
      variant="contained"
      onClick={actions.onContinue}
      loading={actions.busy}
      disabled={actions.stopping}
    >
      {feedCeilingButtons.step.next}
    </Button>
  )
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
  actions,
}: {
  row: QuestionRow
  open: boolean
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
  if (row.kind === 'browser') return <BrowserQuestionCard row={row} open={open} actions={actions} />
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
      {open ? (
        <Typography variant="body2" color="text.secondary">
          {feedQuestionText.waiting}
          {row.questions.length > 1 ? ` ${feedQuestionText.oneMessage}` : ''}
        </Typography>
      ) : null}
    </Box>
  )
}

/**
 * A question of a task in the browser (docs/plan/57-browser-tasks.md, Б23): the agent asks the
 * client to sign in, pass a check or confirm something there, or the platform stops the work.
 * While it is open the card offers the control of the browser, or gives it back.
 */
function BrowserQuestionCard({
  row,
  open,
  actions,
}: {
  row: Extract<QuestionRow, { kind: 'browser' }>
  open: boolean
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
        <Paragraph>{nbsp(feedBrowserQuestionText[row.reason])}</Paragraph>
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

/** Why `/release` cannot be run on the live candidate: said where the button would stand. */
const RELEASE_HINTS: readonly ChatCommandRefusal[] = [
  'not_allowed',
  'needs_update',
  'checks_failed',
  'release_in_progress',
]

function CandidateCard({
  row,
  live,
  release,
  update,
  actions,
}: {
  row: CandidateRow
  live: boolean
  release: CommandVerdict | undefined
  update: CommandVerdict | undefined
  actions: FeedActions
}) {
  const changed = row.files.added + row.files.modified + row.files.deleted
  const refusal = release?.available ? null : (release?.refusal ?? null)
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Card
        icon="eye"
        title={feedCandidateText.title}
        tone={live ? 'primary.main' : 'text.primary'}
        actions={
          live ? (
            <>
              {release?.available ? (
                <Button variant="contained" onClick={actions.onRelease} disabled={actions.busy}>
                  {feedCandidateText.release}
                </Button>
              ) : null}
              {refusal === 'needs_update' && update?.available ? (
                <Button variant="contained" onClick={actions.onUpdate} loading={actions.busy}>
                  {chatCommands.update.label}
                </Button>
              ) : null}
              <Button variant="outlined" onClick={actions.onShowChanges}>
                {dialogText.showChanges}
              </Button>
            </>
          ) : undefined
        }
      >
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
        {live ? <Paragraph>{nbsp(feedCandidateText.hint)}</Paragraph> : null}
        {live && refusal !== null && RELEASE_HINTS.includes(refusal) ? (
          <Typography variant="body2" color="text.secondary">
            {chatCommandRefusalText[refusal]}
          </Typography>
        ) : null}
      </Card>
      {live ? (
        <Typography variant="body2" color="text.secondary">
          {nbsp(feedCandidateText.revise)}
        </Typography>
      ) : null}
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
}

/**
 * «Отменить выпуск» under the card of the installed version the dialog may undo now: the server's
 * verdict on the command, and until when (docs/plan/53, «Отмена выпуска»).
 */
function UndoAction({
  releaseId,
  undo,
  commands,
  actions,
}: {
  releaseId: string
  undo: UndoHead | null
  commands: readonly CommandVerdict[]
  actions: FeedActions
}) {
  const verdict = commands.find((command) => command.id === ('undo' satisfies ChatCommandId))
  if (undo?.releaseId !== releaseId || undo.until === null || !verdict?.available) return null
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px' }}>
      <Button variant="outlined" onClick={actions.onUndo} disabled={actions.busy}>
        {undoText.button}
      </Button>
      <Typography variant="body2" color="text.secondary">
        {nbsp(undoText.until(dayTime(new Date(undo.until))))}
      </Typography>
    </Box>
  )
}

function RowView({
  row,
  now,
  siteUrl,
  openQuestionId,
  liveCandidateId,
  retryId,
  commands,
  undo,
  actions,
  filesOf,
}: {
  row: FeedRow
  now: Date
  siteUrl: string
  openQuestionId: string | null
  liveCandidateId: string | null
  /** The failure the server offers «Попробовать ещё» for; null — none. */
  retryId: string | null
  commands: readonly CommandVerdict[]
  undo: UndoHead | null
  actions: FeedActions
  filesOf: (ids: readonly string[]) => SentFile[]
}) {
  switch (row.type) {
    case 'feed.request':
      switch (row.kind) {
        case 'first':
        case 'answer':
        case 'revision':
          return (
            <Bubble text={row.text} at={row.at} now={now} files={filesOf(row.attachments ?? [])} />
          )
        case 'retry':
          return <Press text={feedRowText.retry} icon="back" />
        case 'continue':
          return <Press text={feedRowText.continue} icon="back" />
        case 'resume':
          return <Press text={feedRowText.resume} icon="back" />
        case 'command':
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
      return <QuestionCard row={row} open={row.id === openQuestionId} actions={actions} />
    case 'feed.result': {
      const approval = row.next === 'awaiting_approval'
      const site = approval ? feedApprovalSiteText[row.site] : feedDoneSiteText[row.site]
      return (
        <Card
          icon={approval ? 'eye' : 'check'}
          title={approval ? feedCardTitle.approval : feedCardTitle.result}
        >
          <Paragraph>{row.message}</Paragraph>
          <Sentences
            parts={[
              site,
              row.filesChanged === null ? null : feedFilesChangedText(row.filesChanged),
            ]}
          />
          <SiteObjects objects={row.objects ?? []} heading={feedObjectText.result} />
          {!approval && row.site !== 'unchanged' ? (
            <MuiLink
              href={siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              sx={{
                alignSelf: 'flex-start',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.5,
                minHeight: 44,
              }}
            >
              {feedStateText.openSite}
              <AppIcon name="arrow" size={16} />
            </MuiLink>
          ) : null}
        </Card>
      )
    }
    case 'feed.failure':
      return (
        <Card
          icon="warning"
          title={feedCardTitle.failure}
          tone="error.main"
          actions={
            row.id === retryId ? (
              <Box
                sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px' }}
              >
                <Button
                  variant="contained"
                  onClick={() => actions.onRetry(row.id)}
                  loading={actions.busy}
                >
                  {feedRetryText.button}
                </Button>
                <Typography variant="body2" color="text.secondary">
                  {nbsp(feedRetryText.hint)}
                </Typography>
              </Box>
            ) : undefined
          }
        >
          <Sentences
            parts={[
              feedFailureText[row.code],
              feedEndedSiteText[row.site],
              feedCreditsSentence(row.credits),
              // The dialog kept its candidate: the card of the changes above says what to do.
              row.next === 'awaiting_approval' ? feedFailureKeptText : null,
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
      return (
        <CandidateCard
          row={row}
          live={row.id === liveCandidateId}
          release={commands.find((command) => command.id === ('release' satisfies ChatCommandId))}
          update={commands.find((command) => command.id === ('update' satisfies ChatCommandId))}
          actions={actions}
        />
      )
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
          {row.outcome === 'installed' ? (
            <UndoAction
              releaseId={row.releaseId}
              undo={undo}
              commands={commands}
              actions={actions}
            />
          ) : null}
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
            row.outcome === 'conflict' || row.outcome === 'failed' ? 'error.main' : 'text.primary'
          }
        >
          <Sentences parts={[feedUpdateText(row.outcome, row.conflicts)]} />
        </Card>
      )
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
  siteUrl,
  openQuestionId,
  liveCandidateId,
  retryId = null,
  actions,
  filesOf = noFiles,
}: {
  head: FeedHeadState | null
  rows: readonly FeedRow[]
  siteUrl: string
  openQuestionId: string | null
  liveCandidateId: string | null
  /** The failure row «Попробовать ещё» is offered on (`retryFailure`). */
  retryId?: string | null
  actions: FeedActions
  /** The files a message sent, by their ids, as their chips name them. */
  filesOf?: (ids: readonly string[]) => SentFile[]
}) {
  const now = new Date()
  const entries: FeedEntry[] = feedEntries(rows, head)
  const commands = head?.commands ?? []
  const undo = head?.undo ?? null
  return (
    <Box
      component="ol"
      aria-label="Сообщения диалога"
      sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}
    >
      {entries.map((entry) => (
        <Box
          component="li"
          key={entry.key}
          sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
        >
          {entry.kind === 'worked' ? (
            <Worked steps={entry.steps} seconds={entry.seconds} />
          ) : (
            <RowView
              row={entry.row}
              now={now}
              siteUrl={siteUrl}
              openQuestionId={openQuestionId}
              liveCandidateId={liveCandidateId}
              retryId={retryId}
              commands={commands}
              undo={undo}
              actions={actions}
              filesOf={filesOf}
            />
          )}
        </Box>
      ))}
    </Box>
  )
}

/** Files of a message whose names are not read: a chip each, nameless. */
const noFiles = (ids: readonly string[]): SentFile[] =>
  ids.map((id) => ({ id, name: null, size: null, kind: 'document' as const }))

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
 * The live block under the rows: drawn from the head of the dialog, never stored. The queue, the
 * preparation, the work with its stages and its time, and a release in progress. `stopping` —
 * the client pressed `/cancel` and the work is being stopped: the block says so instead.
 */
export function LiveBlock({
  head,
  steps,
  stopping = false,
  browser,
}: {
  head: FeedHeadState
  steps: readonly StepRow[]
  stopping?: boolean
  /** A task in the browser (docs/plan/57-browser-tasks.md): who drives it, and the way to it. */
  browser?: {
    /** The client controls the browser: the agent waits for «Продолжить работу агента». */
    controlling: boolean
    onResume: () => void
    /** Shows the browser where it is behind the switch; null — it is beside the dialog. */
    onWatch: (() => void) | null
    busy: boolean
  }
}) {
  const { task, release } = head
  const running = task.status === 'running'
  const seconds = useSecondsSince(task.runningSince, running && !task.held)
  let text: string | null
  let body: ReactNode = null
  // The undo of the dialog's release goes on: the dialog stays closed, the block says the undo.
  const undoRun = head.undo?.run ?? null
  const undoing = undoRun !== null && undoRun.outcome === null
  let title: string = taskStatusLabel[task.status]
  if (undoing) {
    title = undoText.live(feedVersionText(head.undo!.version))
    const status = releaseStatusText[undoRun.status] ?? null
    const step = undoRun.step ? ownText(releaseStepText, undoRun.step) : null
    const parts = [status, step].filter((part) => part !== null)
    text = parts.length === 0 ? null : `${parts.join('. ')}.`
  } else
    switch (task.status) {
      case 'queued':
        text = stopping ? dialogText.stoppedHint : feedQueuedText(task.waiting)
        break
      case 'preparing':
        text = stopping ? dialogText.stoppedHint : feedLiveText.preparing
        break
      case 'running':
        if (stopping) text = dialogText.stoppedHint
        else if (task.held) text = feedLiveText.held
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
          text = browser ? feedLiveText.browser : feedLiveText.running
          body = (
            <>
              {steps.length > 0 ? <StepList steps={steps} running /> : null}
              {browser?.onWatch ? (
                <Button
                  variant="outlined"
                  onClick={browser.onWatch}
                  startIcon={<AppIcon name="eye" size={18} />}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  {browserText.watch}
                </Button>
              ) : null}
            </>
          )
        }
        break
      case 'deploying':
      case 'verifying': {
        const status = release === null ? null : (releaseStatusText[release.status] ?? null)
        const step = release?.step ? ownText(releaseStepText, release.step) : null
        const parts = [status, step].filter((part) => part !== null)
        text = parts.length === 0 ? null : `${parts.join('. ')}.`
        break
      }
      default:
        return null
    }
  return (
    <Box
      sx={{
        p: { xs: 2, sm: 2.5 },
        border: 1,
        borderColor: 'divider',
        borderRadius: '14px',
        bgcolor: 'background.default',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.25,
        maxWidth: 720,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
        <CircularProgress size={16} aria-hidden="true" />
        <Typography component="h2" sx={{ fontSize: 16, fontWeight: 600 }}>
          {title}
        </Typography>
        {running && !task.held && task.runningSince !== null ? (
          // The timer is not read aloud: the live region announces the status, not the seconds.
          <Typography
            component="span"
            aria-hidden="true"
            sx={{ ml: 'auto', color: 'text.secondary', fontSize: 14 }}
          >
            {feedDurationText(seconds)}
          </Typography>
        ) : null}
      </Box>
      {body}
      {text ? (
        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.5 }}>
          {nbsp(text)}
        </Typography>
      ) : null}
    </Box>
  )
}
