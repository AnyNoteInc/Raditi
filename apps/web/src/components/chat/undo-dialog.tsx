'use client'

import { isTerminalReleaseStatus } from '@repo/domain/release/release-state'
import { feedVersionText } from '@repo/domain/tasks/client-feed-labels'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import FormControlLabel from '@mui/material/FormControlLabel'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useId, useState, type ReactNode } from 'react'

import { nbsp } from '@/lib/nbsp'
import { useTRPC, useTRPCClient } from '@/trpc/client'

import { callErrorText } from './call-error'
import { undoText } from './chat-texts'
import type { ReadyUndoPlan, UndoPlanAnswer } from './chat-types'

// «Отменить выпуск» (docs/plan/53-chat-preview-release.md, «Отмена выпуска»): the window asks core
// for the plan of the undo when it opens and shows it once it is ready — the version the site
// goes back to and the number the undo comes out as, the files, every record of the release with
// what becomes of it, and what stays. The button confirms exactly the plan shown (the server
// binds its confirmation to the plan and the number); a plan that changed is asked again.

/** How often a pending plan is asked again, and how long it is waited for. */
export const undoPolling = Object.freeze({ everyMs: 2_000, giveUpMs: 90_000 })

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box component="section" sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Typography component="h3" sx={{ fontSize: 15, fontWeight: 600 }}>
        {title}
      </Typography>
      {children}
    </Box>
  )
}

/** The files of the plan, in sentences, with the paths it names. */
export function undoFileLines(files: ReadyUndoPlan['files']): string[] {
  return [
    files.back > 0 ? undoText.back(files.back) : null,
    files.removed > 0 ? undoText.removed(files.removed) : null,
    files.restored > 0 ? undoText.restored(files.restored) : null,
  ].filter((line): line is string => line !== null)
}

function Plan({
  plan,
  reviewed,
  onReview,
}: {
  plan: ReadyUndoPlan
  reviewed: boolean
  onReview: (reviewed: boolean) => void
}) {
  const returnsTo = feedVersionText(plan.returnsTo)
  const undone = feedVersionText(plan.undoneVersion)
  const lines = undoFileLines(plan.files)
  const returned = plan.records.filter((record) => record.verdict === 'return').length
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, mt: 2 }}>
      <Typography>
        {nbsp(undoText.returns(returnsTo, feedVersionText(plan.version), undone))}
      </Typography>
      {plan.nothingToUndo ? <Alert severity="info">{nbsp(undoText.nothing)}</Alert> : null}

      <Section title={undoText.files}>
        {lines.length === 0 ? (
          <Typography color="text.secondary">{undoText.noFiles}</Typography>
        ) : (
          <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.25 }}>
            {lines.map((line) => (
              <li key={line}>{nbsp(line)}</li>
            ))}
          </Box>
        )}
        {plan.files.paths.length > 0 ? (
          <Box
            component="ul"
            aria-label={undoText.files}
            sx={{
              m: 0,
              pl: 2.5,
              display: 'grid',
              gap: 0.25,
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 13,
              overflowWrap: 'anywhere',
              color: 'text.secondary',
            }}
          >
            {plan.files.paths.map((entry) => (
              <li key={entry.path}>{entry.path}</li>
            ))}
            {plan.files.more > 0 ? <li>{undoText.more(plan.files.more)}</li> : null}
          </Box>
        ) : null}
        {plan.files.mediaKept > 0 ? (
          <Typography variant="body2" color="text.secondary">
            {nbsp(undoText.mediaKept(plan.files.mediaKept))}
          </Typography>
        ) : null}
      </Section>

      <Section title={undoText.records}>
        {plan.records.length === 0 ? (
          <Typography color="text.secondary">{undoText.noRecords}</Typography>
        ) : (
          <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.5 }}>
            {plan.records.map((record) => (
              <Box
                component="li"
                key={`${record.objectType}:${record.objectId}`}
                sx={{
                  color:
                    record.verdict === 'return' || record.verdict === 'already'
                      ? 'text.primary'
                      : 'text.secondary',
                }}
              >
                {nbsp(record.text)}
              </Box>
            ))}
          </Box>
        )}
        {plan.review ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <Typography role="note" sx={{ fontWeight: 600 }}>
              {nbsp(undoText.review(returned))}
            </Typography>
            <FormControlLabel
              sx={{ minHeight: 44, mr: 0 }}
              control={
                <Checkbox checked={reviewed} onChange={(_event, checked) => onReview(checked)} />
              }
              label={undoText.reviewed}
            />
          </Box>
        ) : null}
      </Section>

      <Box sx={{ display: 'grid', gap: 0.5 }}>
        {[...undoText.notes, undoText.safety(undone)].map((note) => (
          <Typography key={note} variant="body2" color="text.secondary">
            {nbsp(note)}
          </Typography>
        ))}
      </Box>
    </Box>
  )
}

/** What the window shows: the plan, a refusal with or without «Повторить», or the wait. */
type Shown =
  | { kind: 'loading' }
  | { kind: 'ready'; plan: ReadyUndoPlan }
  | { kind: 'error'; text: string; retry: boolean }

/**
 * The window of «Отменить выпуск». The plan is asked for once per opening (or again after a
 * refusal, or by «Повторить») and belongs to that opening: a plan of an opening before is never
 * shown. A pending plan is read again every `pollEveryMs` up to `undoPolling.giveUpMs`.
 */
export function UndoDialog({
  taskId,
  releaseId,
  version,
  open,
  onClose,
  onConfirmed,
  pollEveryMs = undoPolling.everyMs,
}: {
  taskId: string
  /** The release undone and its version, as the dialog shows them. */
  releaseId: string
  version: string
  open: boolean
  onClose: () => void
  onConfirmed: () => void
  /** How often a pending plan is asked again (a test asks at once). */
  pollEveryMs?: number
}) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const titleId = useId()
  // Asked, not cached: each opening asks core for the plan that stands now.
  const prepare = useMutation({
    mutationFn: () => client.release.undoPrepare.mutate({ taskId, releaseId }),
  })
  const { mutate: ask, reset: forget } = prepare
  const confirm = useMutation(trpc.release.undoConfirm.mutationOptions())
  const [reviewed, setReviewed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) ask()
    else forget()
  }, [open, ask, forget])

  const planId = prepare.isSuccess ? prepare.data.planId : null
  const askedAt = prepare.submittedAt
  const answer = useQuery({
    // The moment of the request is part of the key: a plan of an opening before is not reused.
    queryKey: ['release.undoPlan', taskId, releaseId, planId, askedAt],
    queryFn: (): Promise<UndoPlanAnswer> =>
      client.release.undoPlan.query({ taskId, releaseId, planId: planId! }),
    enabled: open && planId !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.state === 'pending' &&
      query.state.dataUpdatedAt - askedAt < undoPolling.giveUpMs
        ? pollEveryMs
        : false,
  })

  const data = answer.data
  const shown: Shown = prepare.isError
    ? { kind: 'error', text: callErrorText(prepare.error), retry: false }
    : answer.isError
      ? { kind: 'error', text: callErrorText(answer.error), retry: true }
      : data?.state === 'ready'
        ? { kind: 'ready', plan: data }
        : data?.state === 'failed'
          ? { kind: 'error', text: undoText.failed[data.reason], retry: true }
          : data?.state === 'expired' ||
              (data?.state === 'pending' && answer.dataUpdatedAt - askedAt >= undoPolling.giveUpMs)
            ? { kind: 'error', text: undoText.slow, retry: true }
            : { kind: 'loading' }
  const plan = shown.kind === 'ready' ? shown.plan : null

  function again() {
    setReviewed(false)
    ask()
  }

  async function undo() {
    if (!plan) return
    setError(null)
    try {
      const confirmed = await confirm.mutateAsync({
        taskId,
        releaseId,
        confirmToken: plan.confirmToken,
        version: plan.version,
        ...(plan.review ? { reviewed } : {}),
      })
      // The same confirmation was taken before, and that undo has ended: its number is spent.
      if (confirmed.repeated && isTerminalReleaseStatus(confirmed.status)) {
        setError(undoText.used(feedVersionText(confirmed.version)))
        again()
        return
      }
      onConfirmed()
    } catch (failure) {
      setError(callErrorText(failure))
      // The plan or the number may have moved on: the plan is asked anew under the refusal.
      again()
    }
  }

  function close() {
    if (confirm.isPending) return
    setError(null)
    setReviewed(false)
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
        {undoText.title(feedVersionText(version))}
      </Typography>

      {error ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      ) : null}

      {shown.kind === 'error' ? (
        <Alert
          severity="error"
          sx={{ mt: 2 }}
          action={
            shown.retry ? (
              <Button color="inherit" size="small" onClick={again}>
                {undoText.retry}
              </Button>
            ) : undefined
          }
        >
          {shown.text}
        </Alert>
      ) : plan ? (
        <Plan plan={plan} reviewed={reviewed} onReview={setReviewed} />
      ) : open ? (
        <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mt: 2 }}>
          <CircularProgress size={18} aria-hidden="true" />
          <Typography>{undoText.loading}</Typography>
        </Box>
      ) : null}

      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
        <Button onClick={close} disabled={confirm.isPending}>
          {undoText.keep}
        </Button>
        {plan && !plan.nothingToUndo ? (
          <Button
            variant="contained"
            onClick={() => void undo()}
            loading={confirm.isPending}
            // A bulk undo goes only once the client looked at every record it returns (rule 4).
            disabled={plan.review && !reviewed}
          >
            {undoText.confirm(feedVersionText(plan.returnsTo))}
          </Button>
        ) : null}
      </Box>
    </Dialog>
  )
}
