'use client'

import { isTerminalReleaseStatus } from '@repo/domain/release/release-state'
import {
  feedFilesChangedText,
  feedMediaAddedText,
  feedRecordsChangedText,
  feedVersionBumpLabel,
  feedVersionText,
} from '@repo/domain/tasks/client-feed-labels'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import FormControlLabel from '@mui/material/FormControlLabel'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useId, useState, type ReactNode } from 'react'

import { nbsp } from '@/lib/nbsp'
import { useTRPC, useTRPCClient } from '@/trpc/client'

import { ChecksPanel } from './candidate-panels'
import { DatabasePanel } from './database-panel'
import { callErrorText } from './call-error'
import { releaseText } from './chat-texts'
import type { PreparedRelease, ReleaseChoice } from './chat-types'

// `/release` (docs/plan/53-chat-preview-release.md, Р25–Р27, Р33): what will be released — the
// platform's own counts of the changes, the agent's words about them, the changes of the database
// with their values and the checks — and under which number, the proposed one or one of its two
// neighbours. Each number comes with its own confirmation from the server, bound to the
// description of the database shown here; the button confirms exactly the chosen one, and for a
// bulk or shortened plan only once the client said they looked at every change.

function Section({
  title,
  headingId,
  children,
}: {
  title: string
  headingId?: string
  children: ReactNode
}) {
  return (
    <Box component="section" sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Typography component="h3" id={headingId} sx={{ fontSize: 15, fontWeight: 600 }}>
        {title}
      </Typography>
      {children}
    </Box>
  )
}

/** The trusted counts of a release, in sentences. */
export function releaseFacts(counts: PreparedRelease['counts']): string[] {
  if (counts === null) return [releaseText.noFacts]
  const changed = counts.files.added + counts.files.modified + counts.files.deleted
  return [
    changed > 0 ? feedFilesChangedText(changed) : null,
    counts.media > 0 ? feedMediaAddedText(counts.media) : null,
    counts.records > 0 ? feedRecordsChangedText(counts.records) : null,
  ].filter((line): line is string => line !== null)
}

function Prepared({
  taskId,
  prepared,
  agentMessage,
  chosen,
  onChoose,
  reviewed,
  onReview,
}: {
  taskId: string
  prepared: PreparedRelease
  agentMessage: string | null
  chosen: string
  onChoose: (version: string) => void
  reviewed: boolean
  onReview: (reviewed: boolean) => void
}) {
  const trpc = useTRPC()
  // The checks may have moved on since the panel read them: the release reads them anew.
  const candidate = useQuery({
    ...trpc.candidate.get.queryOptions({ taskId, revision: prepared.revision }),
    staleTime: 0,
  })
  const versionLabel = useId()
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, mt: 2 }}>
      <Section title={releaseText.facts}>
        <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.25 }}>
          {releaseFacts(prepared.counts).map((line) => (
            <li key={line}>{nbsp(line)}</li>
          ))}
        </Box>
        <Typography variant="body2" color="text.secondary">
          {nbsp(
            prepared.installedVersion === null
              ? releaseText.firstRelease
              : releaseText.installed(feedVersionText(prepared.installedVersion)),
          )}
        </Typography>
      </Section>

      {agentMessage ? (
        <Section title={releaseText.agentSaid}>
          <Typography
            component="blockquote"
            sx={{
              m: 0,
              pl: 1.5,
              borderLeft: 3,
              borderColor: 'divider',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {agentMessage}
          </Typography>
        </Section>
      ) : null}

      {candidate.data ? (
        <>
          <Section title={releaseText.database}>
            <DatabasePanel candidate={candidate.data} />
            {prepared.review ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                <Typography role="note" sx={{ fontWeight: 600 }}>
                  {nbsp(
                    (candidate.data.databaseView?.operations.length ?? 0) > 20
                      ? releaseText.reviewBulk(candidate.data.databaseView!.operations.length)
                      : releaseText.reviewShortened,
                  )}
                </Typography>
                <FormControlLabel
                  sx={{ minHeight: 44, mr: 0 }}
                  control={
                    <Checkbox
                      checked={reviewed}
                      onChange={(_event, checked) => onReview(checked)}
                    />
                  }
                  label={releaseText.reviewed}
                />
              </Box>
            ) : null}
          </Section>
          <Section title={releaseText.checks}>
            <ChecksPanel candidate={candidate.data} />
          </Section>
        </>
      ) : null}

      <Section title={releaseText.version} headingId={versionLabel}>
        <RadioGroup
          aria-labelledby={versionLabel}
          name="release-version"
          value={chosen}
          onChange={(_event, value) => onChoose(value)}
        >
          {prepared.choices.map((choice) => (
            <FormControlLabel
              key={choice.version}
              value={choice.version}
              control={<Radio />}
              sx={{ minHeight: 44, mr: 0 }}
              label={
                <span>
                  <Box component="span" sx={{ fontWeight: 600 }}>
                    {feedVersionText(choice.version)}
                  </Box>
                  {' — '}
                  {feedVersionBumpLabel[choice.bump]}
                  {choice.version === prepared.proposal.version ? ` (${releaseText.proposed})` : ''}
                </span>
              }
            />
          ))}
        </RadioGroup>
      </Section>

      <Typography variant="body2" color="text.secondary">
        {nbsp(releaseText.safety)}
      </Typography>
    </Box>
  )
}

/**
 * The dialog of `/release`. What can be released is asked once per opening and belongs to it:
 * an opening never shows the numbers and confirmations of an opening before. A refusal of the
 * server — the changes moved on, the confirmation expired, the number was used — stays inside,
 * and what can be released is asked anew under it.
 */
export function ReleaseDialog({
  taskId,
  open,
  agentMessage,
  onClose,
  onReleased,
}: {
  taskId: string
  open: boolean
  agentMessage: string | null
  onClose: () => void
  onReleased: () => void
}) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const titleId = useId()
  // Asked, not cached: a confirmation lives ten minutes, and each answer is of its own opening.
  const prepare = useMutation({ mutationFn: () => client.release.prepare.query({ taskId }) })
  const { mutate: ask, reset: forget } = prepare
  const confirm = useMutation(trpc.release.confirm.mutationOptions())
  const [chosen, setChosen] = useState<string | null>(null)
  const [reviewed, setReviewed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) ask()
    else forget()
  }, [open, ask, forget])

  // Only an answer of this opening, and never beside a refusal to answer.
  const prepared = prepare.isSuccess ? prepare.data : undefined
  // A choice that a newer answer no longer offers falls back to the proposal.
  const offered = (version: string | null | undefined): ReleaseChoice | undefined =>
    prepared?.choices.find((item) => item.version === version)
  const choice = offered(chosen) ?? offered(prepared?.proposal.version)
  const version = choice?.version ?? null

  async function release() {
    if (!choice) return
    setError(null)
    try {
      const confirmed = await confirm.mutateAsync({
        taskId,
        confirmToken: choice.confirmToken,
        version: choice.version,
        ...(prepared?.review ? { reviewed } : {}),
      })
      // The same confirmation was taken before, and that release has ended: this number of
      // these changes is spent, a new one is chosen.
      if (confirmed.repeated && isTerminalReleaseStatus(confirmed.status)) {
        setError(releaseText.used(feedVersionText(confirmed.version)))
        ask()
        return
      }
      setChosen(null)
      onReleased()
    } catch (failure) {
      setError(callErrorText(failure))
      // The changes or the numbers may have moved on, or the confirmation expired: what can be
      // released is asked anew, and the refusal stays above it.
      ask()
    }
  }

  function close() {
    if (confirm.isPending) return
    setChosen(null)
    setReviewed(false)
    setError(null)
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      aria-labelledby={titleId}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: '100%',
            maxWidth: 560,
            m: 2,
            p: { xs: 2.5, sm: 3 },
            border: 1,
            borderColor: 'divider',
            borderRadius: '14px',
          },
        },
      }}
    >
      <Typography
        component="h2"
        id={titleId}
        sx={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3 }}
      >
        {releaseText.title}
      </Typography>

      {error ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      ) : null}

      {prepare.isError ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          {callErrorText(prepare.error)}
        </Alert>
      ) : prepared && version !== null ? (
        <Prepared
          taskId={taskId}
          prepared={prepared}
          agentMessage={agentMessage}
          chosen={version}
          onChoose={setChosen}
          reviewed={reviewed}
          onReview={setReviewed}
        />
      ) : open ? (
        <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mt: 2 }}>
          <CircularProgress size={18} aria-hidden="true" />
          <Typography>{releaseText.loading}</Typography>
        </Box>
      ) : null}

      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
        <Button onClick={close} disabled={confirm.isPending}>
          {releaseText.keep}
        </Button>
        {choice ? (
          <Button
            variant="contained"
            onClick={() => void release()}
            loading={confirm.isPending}
            // A bulk or shortened plan is released only once the client looked at every change.
            disabled={Boolean(prepared?.review) && !reviewed}
          >
            {releaseText.confirm(feedVersionText(choice.version))}
          </Button>
        ) : null}
      </Box>
    </Dialog>
  )
}
