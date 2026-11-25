'use client'

import Alert from '@mui/material/Alert'
import Avatar from '@mui/material/Avatar'
import AvatarGroup from '@mui/material/AvatarGroup'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import LinearProgress from '@mui/material/LinearProgress'
import Link from '@mui/material/Link'
import MenuItem from '@mui/material/MenuItem'
import Skeleton from '@mui/material/Skeleton'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { artifactRoleAtLeast } from '@repo/domain/artifacts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import NextLink from 'next/link'
import { useCallback, useContext, useId, useMemo, useState, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { uuidv7 } from '@/components/chat/uuid'
import { useTRPC } from '@/trpc/client'

import { ArtifactBody, artifactBodyWide } from './artifact-body'
import {
  ArtifactNotesPanel,
  ArtifactSharingAvailable,
  artifactNotesShown,
  useArtifactNotesCount,
} from './artifact-comments'
import { ARTIFACT_HEAD_NARROW, ArtifactHeadButton, artifactHeadSx } from './artifact-head'
import { documentTexts, formatDateTime } from './artifact-texts'
import { useArtifact, type ArtifactPresence, type CabinetArtifact } from './use-artifact'

// The page of an artifact (docs/plan/88-artifacts.md, Ар48; boards C-doc, D-together;
// docs/plan/93-artifacts-trim.md, АТ9): one calm row of a head — back, the title, who is here,
// «Заметки · N» when there are notes, «Попросить агента», then what the owner does — and the
// artifact large. «Попросить агента» opens the reader's own chat of it on the side (a drawer on a
// narrower screen); a chat of someone else never opens here.

export const pageTexts = Object.freeze({
  back: 'Все артефакты',
  ask: 'Попросить агента',
  hideAsk: 'Свернуть',
  openChat: 'Открыть чат',
  newChat: 'Новый чат',
  noChats: 'Напишите, что сделать, — агент начнёт новый чат с этим артефактом.',
  request: 'Что сделать?',
  askPlaceholder: 'Например: допишите раздел «Доставка» и проверьте цены',
  send: 'Отправить',
  sendFailed: 'Не получилось отправить. Попробуйте ещё раз.',
  whichChat: 'Чат',
  untitledChat: 'Чат без названия',
  working: 'Агент работает — правки появятся здесь сами.',
  waiting: 'Агент ждёт вашего ответа в чате.',
  answered: 'Агент ответил. Его правки уже здесь.',
  stopped: 'Агент не закончил работу. Подробности — в чате.',
  notes: (open: number) => `Заметки · ${open}`,
  notesLabel: (open: number, shown: boolean) =>
    `${shown ? 'Скрыть' : 'Показать'} заметки: открытых ${open}`,
  saved: 'Сохранено',
  changed: (at: string) => `изменено ${formatDateTime(at)}`,
  present: (names: string) => `Сейчас здесь: ${names}`,
  agentHere: (label: string) => `Агент: ${label}`,
  more: (count: number) => `ещё ${count}`,
})

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('')

/** Who is here (D-together): people as avatars, agents as pills — another's chat «Агент <Имя>». */
export function ArtifactPresenceBar({ presence }: { presence: ArtifactPresence | null }) {
  if (presence === null) return null
  const others = presence.people.filter((person) => !person.self)
  if (others.length === 0 && presence.agents.length === 0) return null
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        flexShrink: 0,
        [ARTIFACT_HEAD_NARROW]: { display: 'none' },
      }}
      aria-label={pageTexts.present(
        [...others.map((person) => person.name), ...presence.agents.map((each) => each.label)].join(
          ', ',
        ),
      )}
      role="group"
    >
      {others.length > 0 && (
        <AvatarGroup max={4} sx={{ '& .MuiAvatar-root': { width: 28, height: 28, fontSize: 12 } }}>
          {others.map((person) => (
            <Tooltip key={person.userId} title={person.name}>
              <Avatar alt={person.name}>{initialsOf(person.name)}</Avatar>
            </Tooltip>
          ))}
        </AvatarGroup>
      )}
      {presence.agents.map((agent) => (
        <Chip
          key={agent.label}
          size="small"
          variant="outlined"
          color="warning"
          icon={<AppIcon name="pencil" size={14} />}
          label={pageTexts.agentHere(agent.label)}
        />
      ))}
      {presence.morePeople > 0 && (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {pageTexts.more(presence.morePeople)}
        </Typography>
      )}
    </Box>
  )
}

/** The title of an artifact, renamed in place by its owner or an editor (a `title` operation). */
export function ArtifactTitle({
  artifact,
  onChanged,
  size = 'large',
}: {
  artifact: CabinetArtifact
  onChanged: () => void
  size?: 'large' | 'small'
}) {
  const trpc = useTRPC()
  const write = useMutation(trpc.artifact.write.mutationOptions())
  const [draft, setDraft] = useState<string | null>(null)
  const canEdit = artifactRoleAtLeast(artifact.role, 'edit')
  const fontSize = size === 'large' ? { xs: 18, md: 22 } : 16
  if (draft !== null)
    return (
      <TextField
        autoFocus
        size="small"
        value={draft}
        label={documentTexts.title}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setDraft(null)
          if (event.key !== 'Enter') return
          event.preventDefault()
          const title = draft.trim()
          setDraft(null)
          if (title === '' || title === artifact.title) return
          void write
            .mutateAsync({
              batch: {
                artifactId: artifact.id,
                opId: `title-${uuidv7()}`,
                ops: [{ op: 'title', title }],
              },
            })
            .finally(onChanged)
        }}
        slotProps={{ htmlInput: { maxLength: 200 } }}
        sx={{ width: '100%', maxWidth: 520 }}
      />
    )
  return (
    <Typography
      component="h1"
      title={artifact.title}
      sx={{
        fontSize,
        fontWeight: 650,
        lineHeight: 1.3,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {canEdit ? (
        <Box
          component="button"
          type="button"
          aria-label={`${documentTexts.rename}: ${artifact.title}`}
          onClick={() => setDraft(artifact.title)}
          sx={{
            all: 'inherit',
            display: 'inline',
            cursor: 'text',
            borderRadius: '6px',
            '&:hover, &:focus-visible': { bgcolor: 'action.hover' },
            '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineStyle: 'solid' },
          }}
        >
          {artifact.title}
        </Box>
      ) : (
        artifact.title
      )}
    </Typography>
  )
}

/** Where the reader's request to the agent stands, by the status of its chat (spec §7). */
function stageOf(status: string | undefined): 'working' | 'waiting' | 'answered' | 'stopped' {
  if (status === 'awaiting_user' || status === 'awaiting_approval') return 'waiting'
  if (status === 'done') return 'answered'
  if (status === 'failed' || status === 'cancelled' || status === 'rolled_back') return 'stopped'
  return 'working'
}

/**
 * «Попросить агента» (Ар48; АТ9): the reader's own chats with this artifact (the last one by
 * default) and a word to the agent; after it, where the work stands and the way to the chat.
 */
export function ArtifactAskPanel({
  artifact,
  onClose,
}: {
  artifact: CabinetArtifact
  onClose: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const chats = useQuery(trpc.artifact.chats.queryOptions({ artifactId: artifact.id }))
  const create = useMutation(trpc.task.create.mutationOptions())
  const message = useMutation(trpc.task.message.mutationOptions())
  const [chosen, setChosen] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const titleId = useId()
  const list = chats.data ?? []
  const taskId = chosen === 'new' ? null : (chosen ?? list[0]?.taskId ?? null)
  const head = useQuery({
    ...trpc.task.get.queryOptions({ taskId: sent ?? '' }),
    enabled: sent !== null,
    refetchInterval: (query) =>
      stageOf((query.state.data as { status?: string } | undefined)?.status) === 'working'
        ? 3000
        : false,
  })
  const stage = sent === null ? null : stageOf(head.data?.status)

  async function send() {
    const words = text.trim()
    if (words === '') return
    setFailed(false)
    try {
      if (taskId === null) {
        const id = uuidv7()
        // The mention names the artifact for the new chat (Ар47): core attaches it.
        await create.mutateAsync({
          taskId: id,
          text: `@artifact:${artifact.id} ${words}`,
          projectId: artifact.project?.id ?? null,
        })
        setSent(id)
        setChosen(id)
      } else {
        await message.mutateAsync({ taskId, requestId: uuidv7(), text: words })
        setSent(taskId)
      }
      setText('')
      void queryClient.invalidateQueries({
        queryKey: trpc.artifact.chats.queryKey({ artifactId: artifact.id }),
      })
      if (taskId !== null)
        void queryClient.invalidateQueries({
          queryKey: trpc.task.get.queryKey({ taskId }),
        })
    } catch {
      setFailed(true)
    }
  }

  return (
    <Box
      component="aside"
      aria-labelledby={titleId}
      sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, p: 2 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography id={titleId} component="h2" sx={{ fontSize: 16, fontWeight: 650, flex: 1 }}>
          {pageTexts.ask}
        </Typography>
        <Tooltip title={pageTexts.hideAsk}>
          <IconButton size="small" aria-label={pageTexts.hideAsk} onClick={onClose}>
            <AppIcon name="close" size={16} />
          </IconButton>
        </Tooltip>
      </Box>
      {list.length > 0 ? (
        <TextField
          select
          size="small"
          label={pageTexts.whichChat}
          value={taskId ?? 'new'}
          onChange={(event) => setChosen(event.target.value)}
        >
          {list.map((chat) => (
            <MenuItem key={chat.taskId} value={chat.taskId}>
              {chat.title ?? pageTexts.untitledChat}
            </MenuItem>
          ))}
          <MenuItem value="new">{pageTexts.newChat}</MenuItem>
        </TextField>
      ) : (
        chats.isSuccess && (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {pageTexts.noChats}
          </Typography>
        )
      )}
      <TextField
        multiline
        minRows={3}
        label={pageTexts.request}
        placeholder={pageTexts.askPlaceholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send()
        }}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        {taskId !== null && (
          <Link component={NextLink} href={`/chats/${taskId}`} variant="body2" sx={{ mr: 'auto' }}>
            {pageTexts.openChat}
          </Link>
        )}
        <Button
          variant="contained"
          disableElevation
          onClick={() => void send()}
          disabled={text.trim() === '' || create.isPending || message.isPending}
          endIcon={<AppIcon name="send" size={16} />}
          sx={{ ml: 'auto' }}
        >
          {pageTexts.send}
        </Button>
      </Box>
      {stage !== null && (
        <Box role="status" sx={{ display: 'grid', gap: 1 }}>
          {stage === 'working' && <LinearProgress aria-hidden />}
          <Typography variant="body2" color={stage === 'stopped' ? 'error' : 'text.secondary'}>
            {pageTexts[stage]}
          </Typography>
          {sent !== taskId && (
            <Link component={NextLink} href={`/chats/${sent}`} variant="body2">
              {pageTexts.openChat}
            </Link>
          )}
        </Box>
      )}
      {failed && <Alert severity="error">{pageTexts.sendFailed}</Alert>}
    </Box>
  )
}

/** The outline of a long document: its sections, a click scrolls to one. */
function Outline({ sections }: { sections: CabinetArtifact['blocks'] }) {
  return (
    <Box component="nav" aria-label={documentTexts.sections} sx={{ position: 'sticky', top: 16 }}>
      <Typography variant="overline" sx={{ color: 'text.secondary' }}>
        {documentTexts.sections}
      </Typography>
      <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {sections.map((block) => (
          <li key={block.key}>
            <Link
              href={`#section-${block.key}`}
              underline="hover"
              color="text.secondary"
              variant="body2"
              sx={{ display: 'block', py: 0.5 }}
            >
              {block.heading ?? documentTexts.untitled}
            </Link>
          </li>
        ))}
      </Box>
    </Box>
  )
}

/** An outline stands beside a document of this many sections and more. */
const OUTLINE_SECTIONS = 3

/** The page `/artifacts/<id>`. `actions` — what the owner does from the head (history, share, ⋯). */
export function ArtifactPage({
  artifactId,
  actions,
}: {
  artifactId: string
  actions?: (artifact: CabinetArtifact, reread: () => void) => ReactNode
}) {
  const [block, setBlock] = useState<string | null>(null)
  const { read, accessLost, presence, reread, discardAccess } = useArtifact(artifactId, { block })
  const wide = useMediaQuery('(min-width:1200px)', { noSsr: true })
  const [askOpen, setAskOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const notesPanel = useMemo(() => ({ open: notesOpen, setOpen: setNotesOpen }), [notesOpen])
  const onEditing = useCallback((key: string | null) => setBlock(key), [])
  const sharing = useContext(ArtifactSharingAvailable)
  const artifact = read.data
  const notesOn = artifact != null && !accessLost && artifactNotesShown(artifact, sharing)
  const notes = useArtifactNotesCount(artifactId, notesOn)

  if (read.isPending) return <Skeleton variant="rounded" height={320} />
  if (!artifact || accessLost)
    return (
      <Alert severity="error">
        {accessLost ? documentTexts.notFound : documentTexts.loadFailed}
      </Alert>
    )
  // The screens of a canvas, slides and pictures take the width of the page: no outline.
  const full = artifactBodyWide(artifact.kind)
  const sections = artifact.blocks.filter((each) => each.kind === 'section')
  const outline = wide && !full && sections.length >= OUTLINE_SECTIONS
  const ask = <ArtifactAskPanel artifact={artifact} onClose={() => setAskOpen(false)} />
  const columns = [outline ? '180px' : null, 'minmax(0, 1fr)', wide && askOpen ? '360px' : null]
    .filter(Boolean)
    .join(' ')

  return (
    <Box sx={{ width: '100%', maxWidth: 1440, mx: 'auto' }}>
      <Box
        component="header"
        sx={{
          ...artifactHeadSx,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          minHeight: 48,
          mb: { xs: 2, md: 3 },
        }}
      >
        <Tooltip title={pageTexts.back}>
          <IconButton
            component={NextLink}
            href="/artifacts"
            aria-label={pageTexts.back}
            sx={{ width: 40, height: 40, ml: -1, flexShrink: 0 }}
          >
            <AppIcon name="back" size={18} />
          </IconButton>
        </Tooltip>
        <Box sx={{ minWidth: 0, flex: '1 1 auto' }}>
          <ArtifactTitle artifact={artifact} onChanged={reread} />
          <Typography
            variant="caption"
            sx={{
              display: 'block',
              color: 'text.secondary',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {[artifact.project?.name, pageTexts.saved, pageTexts.changed(artifact.updatedAt)]
              .filter(Boolean)
              .join(' · ')}
          </Typography>
        </Box>
        <ArtifactPresenceBar presence={presence} />
        {notes.total > 0 && (
          <Chip
            label={pageTexts.notes(notes.open)}
            aria-label={pageTexts.notesLabel(notes.open, notesOpen)}
            aria-pressed={notesOpen}
            variant={notesOpen ? 'filled' : 'outlined'}
            color={notesOpen ? 'primary' : 'default'}
            onClick={() => setNotesOpen((was) => !was)}
            sx={{ flexShrink: 0 }}
          />
        )}
        <ArtifactHeadButton
          variant="text"
          color="inherit"
          icon={<AppIcon name="chat" size={16} />}
          label={pageTexts.ask}
          aria-pressed={askOpen}
          onClick={() => setAskOpen((was) => !was)}
          sx={askOpen ? { bgcolor: 'action.selected' } : undefined}
        />
        {actions?.(artifact, reread)}
      </Box>
      <ArtifactNotesPanel.Provider value={notesPanel}>
        <Box sx={{ display: 'grid', gap: 4, gridTemplateColumns: columns, alignItems: 'start' }}>
          {outline && <Outline sections={sections} />}
          <Box
            component="main"
            sx={{ minWidth: 0, width: '100%', maxWidth: full ? 'none' : 760, mx: 'auto' }}
          >
            <ArtifactBody
              artifact={artifact}
              presence={presence}
              onChanged={reread}
              onAccessLost={discardAccess}
              onEditing={onEditing}
              place="page"
            />
          </Box>
          {wide && askOpen && (
            <Box
              sx={{
                position: 'sticky',
                top: 16,
                borderRadius: '16px',
                border: 1,
                borderColor: 'divider',
                bgcolor: 'background.paper',
              }}
            >
              {ask}
            </Box>
          )}
        </Box>
      </ArtifactNotesPanel.Provider>
      {!wide && (
        <Drawer anchor="right" open={askOpen} onClose={() => setAskOpen(false)}>
          <Box sx={{ width: 'min(100vw, 380px)' }}>{ask}</Box>
        </Drawer>
      )}
    </Box>
  )
}
