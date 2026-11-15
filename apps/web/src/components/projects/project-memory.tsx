'use client'

import { memoryLimits, memoryKinds, type MemoryKind } from '@repo/domain/memory'
import type { AppRouter } from '@repo/trpc'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import IconButton from '@mui/material/IconButton'
import Link from '@mui/material/Link'
import MenuItem from '@mui/material/MenuItem'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { inferRouterOutputs } from '@trpc/server'
import NextLink from 'next/link'
import { useCallback, useId, useState, type FormEvent } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { chatHref } from '@/components/chat/chat-address'
import { callErrorText } from '@/components/chat/call-error'
import { useTRPC } from '@/trpc/client'

import { memoryText } from './project-texts'
import type { ProjectDetails } from './project-types'

/** An entry of «Память», as `projectMemory.list` sends it. */
export type MemoryEntry = inferRouterOutputs<AppRouter>['projectMemory']['list']['entries'][number]

/** It waits for the client: a new note of the agent, or its proposal over a saved one (ПР18). */
export const memoryWaits = (entry: Pick<MemoryEntry, 'status' | 'pendingAction'>): boolean =>
  entry.status === 'proposed' || entry.pendingAction !== null

/** What the memory changed: its list, the counts of the project and the rows of the chat. */
function useMemoryRefresh() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: trpc.projectMemory.pathKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.project.pathKey() })
  }, [queryClient, trpc])
}

/**
 * «Память» of the column of a project (docs/plan/84-projects.md, ПР18, §4.8; P-project): how many
 * entries and how many are «Предложено»; «Посмотреть» opens the window (P-memory, P-memory-empty).
 */
export function ProjectMemoryRow({ project }: { project: Pick<ProjectDetails, 'id' | 'memory'> }) {
  const [open, setOpen] = useState(false)
  const titleId = useId()
  const { active, proposed } = project.memory
  return (
    <Box
      component="section"
      aria-labelledby={titleId}
      data-project-memory=""
      sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ display: 'flex', color: 'text.secondary' }} aria-hidden>
          <AppIcon name="memory" size={18} />
        </Box>
        <Typography
          id={titleId}
          component="h2"
          sx={{ flex: '1 1 auto', fontSize: 15, fontWeight: 600 }}
        >
          {memoryText.title}
        </Typography>
        <Button
          size="small"
          aria-haspopup="dialog"
          aria-label={memoryText.openLabel}
          onClick={() => setOpen(true)}
          sx={{ minHeight: 44 }}
        >
          {memoryText.open}
        </Button>
      </Box>
      <Typography sx={{ color: 'text.secondary', fontSize: 14 }}>
        {active + proposed === 0 ? (
          memoryText.rowEmpty
        ) : (
          <>
            {memoryText.entries(active)}
            {proposed > 0 ? (
              <>
                {' · '}
                <Box component="span" sx={{ color: 'primary.main', fontWeight: 500 }}>
                  {memoryText.proposedCount(proposed)}
                </Box>
              </>
            ) : null}
          </>
        )}
      </Typography>
      <MemoryDialog projectId={project.id} open={open} onClose={() => setOpen(false)} />
    </Box>
  )
}

/** The window «Память» of a project (P-memory, P-memory-empty); the whole screen on a phone. */
export function MemoryDialog({
  projectId,
  open,
  onClose,
}: {
  projectId: string
  open: boolean
  onClose: () => void
}) {
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'))
  const titleId = useId()
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={fullScreen}
      aria-labelledby={titleId}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: '100%',
            maxWidth: { sm: 640 },
            m: { sm: 2 },
            border: { sm: 1 },
            borderColor: { sm: 'divider' },
            borderRadius: { xs: 0, sm: '14px' },
          },
        },
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, p: { xs: 2.5, sm: 3 } }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
          <Typography
            id={titleId}
            component="h2"
            sx={{ flex: '1 1 auto', fontSize: 20, fontWeight: 600 }}
          >
            {memoryText.title}
          </Typography>
          <IconButton
            aria-label={memoryText.close}
            onClick={onClose}
            sx={{ width: 44, height: 44, mt: -1, mr: -1 }}
          >
            <AppIcon name="close" size={20} />
          </IconButton>
        </Box>
        {open ? <MemoryPanel projectId={projectId} /> : null}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="contained" onClick={onClose} sx={{ minHeight: 44 }}>
            {memoryText.done}
          </Button>
        </Box>
      </Box>
    </Dialog>
  )
}

/**
 * The entries of one memory — of a project, or `projectId: null` of the account — with «Добавить
 * запись», the group «Предложено» with «Сохранить» and «Не надо», «Сохранено» with «Изменить» and
 * «Удалить», and «Очистить память». A project adds its switch «Использовать память аккаунта».
 */
export function MemoryPanel({
  projectId,
  offNotice = true,
}: {
  projectId: string | null
  /** «Память агента выключена» with the way to the settings; the settings show their switch. */
  offNotice?: boolean
}) {
  const trpc = useTRPC()
  const refresh = useMemoryRefresh()
  const list = useQuery(trpc.projectMemory.list.queryOptions({ projectId }))
  const setAccount = useMutation(trpc.project.update.mutationOptions())
  const clear = useMutation(trpc.projectMemory.clear.mutationOptions())
  const [adding, setAdding] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const proposedId = useId()
  const savedId = useId()
  const switchId = useId()
  const now = new Date()

  if (list.isPending)
    return (
      <Box role="status" aria-label={memoryText.loading} sx={{ py: 2, display: 'flex' }}>
        <CircularProgress size={20} />
      </Box>
    )
  if (list.isError) return <Alert severity="error">{memoryText.loadFailed}</Alert>

  const { entries, useAccountMemory, agentMemory, limit } = list.data
  const proposed = entries.filter(memoryWaits)
  const saved = entries.filter((entry) => !memoryWaits(entry))
  const full = entries.length >= limit

  async function clearAll() {
    setError(null)
    try {
      await clear.mutateAsync({ projectId })
      setClearing(false)
      refresh()
    } catch (failure) {
      setError(callErrorText(failure, memoryText.failed))
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }} data-memory-panel="">
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap' }}>
        <Typography sx={{ flex: '1 1 260px', color: 'text.secondary', fontSize: 14 }}>
          {projectId === null ? memoryText.accountLead : memoryText.lead}
        </Typography>
        <Button
          variant="outlined"
          startIcon={<AppIcon name="plus" size={16} />}
          disabled={full || adding}
          onClick={() => setAdding(true)}
          sx={{ minHeight: 44, borderRadius: '999px', flex: 'none' }}
        >
          {memoryText.add}
        </Button>
      </Box>

      {agentMemory || !offNotice ? null : (
        <Alert
          severity="info"
          action={
            <Link component={NextLink} href={memoryText.settingsHref} sx={{ alignSelf: 'center' }}>
              {memoryText.offLink}
            </Link>
          }
        >
          {memoryText.off}
        </Alert>
      )}
      {full ? <Alert severity="info">{memoryText.full(limit)}</Alert> : null}

      {adding ? (
        <EntryEditor
          initial={{ kind: 'fact', text: '' }}
          onCancel={() => setAdding(false)}
          onSaved={() => setAdding(false)}
          projectId={projectId}
        />
      ) : null}

      {entries.length === 0 && !adding ? (
        <Box
          sx={{
            border: 1,
            borderStyle: 'dashed',
            borderColor: 'divider',
            borderRadius: '14px',
            p: 2.5,
            display: 'flex',
            flexDirection: 'column',
            gap: 0.5,
          }}
        >
          <Typography sx={{ fontSize: 15, fontWeight: 600 }}>{memoryText.emptyTitle}</Typography>
          <Typography sx={{ color: 'text.secondary', fontSize: 14 }}>{memoryText.empty}</Typography>
        </Box>
      ) : null}

      {proposed.length > 0 ? (
        <Box component="section" aria-labelledby={proposedId} data-memory-group="proposed">
          <Typography id={proposedId} component="h3" sx={{ fontSize: 15, fontWeight: 600 }}>
            {memoryText.proposed}
            <Box component="span" sx={{ ml: 1, color: 'text.secondary', fontWeight: 400 }}>
              · {proposed.length}
            </Box>
          </Typography>
          <Typography sx={{ color: 'text.secondary', fontSize: 13, mb: 1 }}>
            {memoryText.proposedHint}
          </Typography>
          <EntryList entries={proposed} now={now} projectId={projectId} labelledBy={proposedId} />
        </Box>
      ) : null}

      {saved.length > 0 ? (
        <Box component="section" aria-labelledby={savedId} data-memory-group="saved">
          <Typography id={savedId} component="h3" sx={{ fontSize: 15, fontWeight: 600, mb: 1 }}>
            {memoryText.saved}
            <Box component="span" sx={{ ml: 1, color: 'text.secondary', fontWeight: 400 }}>
              · {saved.length}
            </Box>
          </Typography>
          <EntryList entries={saved} now={now} projectId={projectId} labelledBy={savedId} />
        </Box>
      ) : null}

      {projectId !== null && useAccountMemory !== null ? (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 1.5,
            borderTop: 1,
            borderColor: 'divider',
            pt: 2,
          }}
        >
          <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
            <Typography
              component="label"
              htmlFor={switchId}
              sx={{ display: 'block', fontSize: 15, fontWeight: 500 }}
            >
              {memoryText.useAccount}
            </Typography>
            <Typography sx={{ color: 'text.secondary', fontSize: 13, mt: 0.25 }}>
              {memoryText.useAccountHint}
            </Typography>
            <Link
              component={NextLink}
              href={memoryText.settingsHref}
              sx={{ display: 'inline-block', mt: 0.75, fontSize: 14 }}
            >
              {memoryText.seeAccount}
            </Link>
          </Box>
          <Switch
            id={switchId}
            checked={useAccountMemory}
            disabled={setAccount.isPending}
            onChange={(_event, checked) => {
              setError(null)
              setAccount.mutate(
                { projectId, useAccountMemory: checked },
                {
                  onSuccess: refresh,
                  onError: (failure) => setError(callErrorText(failure, memoryText.failed)),
                },
              )
            }}
          />
        </Box>
      ) : null}

      {error ? <Alert severity="error">{error}</Alert> : null}

      {entries.length > 0 ? (
        clearing ? (
          <Alert
            severity="warning"
            action={
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button color="inherit" size="small" onClick={() => setClearing(false)}>
                  {memoryText.cancel}
                </Button>
                <Button
                  color="error"
                  size="small"
                  variant="contained"
                  disableElevation
                  loading={clear.isPending}
                  onClick={() => void clearAll()}
                >
                  {memoryText.clearConfirm}
                </Button>
              </Box>
            }
          >
            <strong>{memoryText.clearTitle}</strong> {memoryText.clearBody}
          </Alert>
        ) : (
          <Box>
            <Button color="error" onClick={() => setClearing(true)} sx={{ minHeight: 44 }}>
              {memoryText.clear}
            </Button>
          </Box>
        )
      ) : null}
    </Box>
  )
}

function EntryList({
  entries,
  now,
  projectId,
  labelledBy,
}: {
  entries: readonly MemoryEntry[]
  now: Date
  projectId: string | null
  labelledBy: string
}) {
  return (
    <Box
      component="ul"
      aria-labelledby={labelledBy}
      sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexDirection: 'column' }}
    >
      {entries.map((entry) => (
        <EntryItem key={entry.id} entry={entry} now={now} projectId={projectId} />
      ))}
    </Box>
  )
}

/** Where an entry came from and when: «из чата «X» · вчера», «добавлено вами · 11 нояб.». */
function EntryMeta({ entry, now }: { entry: MemoryEntry; now: Date }) {
  const where =
    entry.author === 'client'
      ? memoryText.byClient
      : entry.status === 'proposed'
        ? memoryText.proposedIn(entry.source?.title ?? null)
        : memoryText.fromChat(entry.source?.title ?? null)
  const when = memoryText.when(entry.status === 'proposed' ? entry.createdAt : entry.updatedAt, now)
  return (
    <Typography sx={{ fontSize: 12.5, color: 'text.secondary', mt: 0.25 }}>
      {entry.source && entry.author === 'agent' ? (
        <Link component={NextLink} href={chatHref(entry.source.taskId)} color="inherit">
          {where}
        </Link>
      ) : (
        where
      )}
      {' · '}
      {when}
    </Typography>
  )
}

function EntryItem({
  entry,
  now,
  projectId,
}: {
  entry: MemoryEntry
  now: Date
  projectId: string | null
}) {
  const trpc = useTRPC()
  const refresh = useMemoryRefresh()
  const confirm = useMutation(trpc.projectMemory.confirm.mutationOptions())
  const reject = useMutation(trpc.projectMemory.reject.mutationOptions())
  const remove = useMutation(trpc.projectMemory.remove.mutationOptions())
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = confirm.isPending || reject.isPending || remove.isPending

  async function run(act: () => Promise<unknown>) {
    setError(null)
    try {
      await act()
      refresh()
    } catch (failure) {
      setError(callErrorText(failure, memoryText.failed))
      refresh()
    }
  }
  const at = { id: entry.id, expectedVersion: entry.version }

  if (editing)
    return (
      <Box component="li" sx={{ py: 1.25, borderTop: 1, borderColor: 'divider' }}>
        <EntryEditor
          initial={{ kind: entry.kind, text: entry.text }}
          entry={entry}
          projectId={projectId}
          onCancel={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      </Box>
    )

  const waits = memoryWaits(entry)
  return (
    <Box
      component="li"
      data-memory-entry={entry.id}
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1,
        py: 1.25,
        borderTop: 1,
        borderColor: 'divider',
        '&:first-of-type': { borderTop: 0 },
      }}
    >
      <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
        <Typography sx={{ fontSize: 12, color: 'text.secondary', fontWeight: 500 }}>
          {memoryText.kinds[entry.kind]}
        </Typography>
        {entry.pendingAction === 'update' ? (
          <>
            <Typography sx={{ fontSize: 13, color: 'primary.main' }}>
              {memoryText.updateProposed}
            </Typography>
            <Typography sx={{ fontSize: 14, overflowWrap: 'anywhere' }}>
              {entry.pendingText}
            </Typography>
            <Typography sx={{ fontSize: 13, color: 'text.secondary', overflowWrap: 'anywhere' }}>
              {memoryText.updateNow(entry.text)}
            </Typography>
          </>
        ) : (
          <>
            {entry.pendingAction === 'forget' ? (
              <Typography sx={{ fontSize: 13, color: 'primary.main' }}>
                {memoryText.forgetProposed}
              </Typography>
            ) : null}
            <Typography sx={{ fontSize: 14, overflowWrap: 'anywhere' }}>{entry.text}</Typography>
          </>
        )}
        <EntryMeta entry={entry} now={now} />
        {waits ? (
          <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
            <Button
              size="small"
              variant="contained"
              disableElevation
              disabled={busy}
              onClick={() => void run(() => confirm.mutateAsync(at))}
              sx={{ minHeight: 36, borderRadius: '999px' }}
            >
              {entry.pendingAction === 'forget' ? memoryText.forget : memoryText.save}
            </Button>
            <Button
              size="small"
              disabled={busy}
              onClick={() => void run(() => reject.mutateAsync(at))}
              sx={{ minHeight: 36 }}
            >
              {memoryText.drop}
            </Button>
          </Box>
        ) : null}
        {error ? (
          <Typography role="alert" sx={{ mt: 0.5, fontSize: 13, color: 'error.main' }}>
            {error}
          </Typography>
        ) : null}
      </Box>
      {waits ? null : (
        <Box sx={{ display: 'flex', flex: 'none', mr: -1 }}>
          <IconButton
            aria-label={memoryText.editLabel(entry.text)}
            disabled={busy}
            onClick={() => setEditing(true)}
            sx={{ width: 44, height: 44 }}
          >
            <AppIcon name="pencil" size={18} />
          </IconButton>
          <IconButton
            aria-label={memoryText.removeLabel(entry.text)}
            disabled={busy}
            onClick={() => void run(() => remove.mutateAsync({ id: entry.id }))}
            sx={{ width: 44, height: 44 }}
          >
            <AppIcon name="trash" size={18} />
          </IconButton>
        </Box>
      )}
    </Box>
  )
}

/** A new entry of the client, or «Изменить» of one (P-memory): its kind, «Текст записи», «N из 400». */
function EntryEditor({
  initial,
  entry,
  projectId,
  onCancel,
  onSaved,
}: {
  initial: { kind: MemoryKind; text: string }
  entry?: MemoryEntry
  projectId: string | null
  onCancel: () => void
  onSaved: () => void
}) {
  const trpc = useTRPC()
  const refresh = useMemoryRefresh()
  const add = useMutation(trpc.projectMemory.add.mutationOptions())
  const update = useMutation(trpc.projectMemory.update.mutationOptions())
  const [kind, setKind] = useState<MemoryKind>(initial.kind)
  const [text, setText] = useState(initial.text)
  const [error, setError] = useState<string | null>(null)
  const length = text.trim().length
  const tooLong = length > memoryLimits.textChars

  async function submit(event: FormEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (length === 0) {
      setError(memoryText.textRequired)
      return
    }
    setError(null)
    try {
      if (entry)
        await update.mutateAsync({ id: entry.id, text, kind, expectedVersion: entry.version })
      else await add.mutateAsync({ projectId, kind, text })
      refresh()
      onSaved()
    } catch (failure) {
      setError(callErrorText(failure, memoryText.failed))
    }
  }

  return (
    <Box
      component="form"
      onSubmit={(event: FormEvent) => void submit(event)}
      data-memory-editor=""
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        p: 2,
        border: 1,
        borderColor: 'divider',
        borderRadius: '14px',
        bgcolor: 'action.hover',
      }}
    >
      <TextField
        select
        size="small"
        label={memoryText.kindLabel}
        value={kind}
        onChange={(event) => setKind(event.target.value as MemoryKind)}
        sx={{ maxWidth: 240 }}
      >
        {memoryKinds.map((each) => (
          <MenuItem key={each} value={each}>
            {memoryText.kinds[each]}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        label={memoryText.textLabel}
        value={text}
        multiline
        minRows={2}
        autoFocus
        onChange={(event) => setText(event.target.value)}
        error={error !== null || tooLong}
        helperText={error ?? undefined}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography
          variant="caption"
          color={tooLong ? 'error.main' : 'text.secondary'}
          sx={{ flex: '1 1 auto' }}
        >
          {memoryText.count(length, memoryLimits.textChars)}
        </Typography>
        <Button onClick={onCancel} sx={{ minHeight: 44 }}>
          {memoryText.cancel}
        </Button>
        <Button
          type="submit"
          variant="contained"
          disableElevation
          disabled={tooLong}
          loading={add.isPending || update.isPending}
          sx={{ minHeight: 44, borderRadius: '999px' }}
        >
          {memoryText.save}
        </Button>
      </Box>
    </Box>
  )
}
