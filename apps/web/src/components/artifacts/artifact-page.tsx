'use client'

import Alert from '@mui/material/Alert'
import Avatar from '@mui/material/Avatar'
import AvatarGroup from '@mui/material/AvatarGroup'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import Link from '@mui/material/Link'
import MenuItem from '@mui/material/MenuItem'
import Skeleton from '@mui/material/Skeleton'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { artifactKindSpecOf, artifactRoleAtLeast, artifactSavedLine } from '@repo/domain/artifacts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import NextLink from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useState, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { uuidv7 } from '@/components/chat/uuid'
import { useTRPC } from '@/trpc/client'

import { ArtifactBody, artifactBodyWide } from './artifact-body'
import { ArtifactKindIcon } from './artifact-kind-icon'
import { documentTexts, galleryTexts } from './artifact-texts'
import { useArtifact, type ArtifactPresence, type CabinetArtifact } from './use-artifact'

// The page of an artifact (docs/plan/88-artifacts.md, Ар48; boards C-doc, D-together): the
// artifact large, its sections on the left, and on the right the chat of this artifact of the
// reader — their own chats with it (the last one by default) and «Новый чат с артефактом». A chat
// of someone else never opens here. On a phone the chat slides out from the side.

export const pageTexts = Object.freeze({
  back: 'Артефакты',
  chat: 'Чат артефакта',
  openChat: 'Открыть чат',
  newChat: 'Новый чат с артефактом',
  noChats: 'Агент ещё не работал с этим артефактом. Напишите, что сделать, — начнётся новый чат.',
  ask: 'Попросить агента',
  askPlaceholder: 'Например: допишите раздел «Доставка» и проверьте цены',
  send: 'Отправить',
  sent: 'Отправлено.',
  sendFailed: 'Не получилось отправить. Попробуйте ещё раз.',
  whichChat: 'Чат',
  untitledChat: 'Чат без названия',
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
      sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}
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
  const fontSize = size === 'large' ? { xs: 22, md: 28 } : 17
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
        sx={{ minWidth: 260 }}
      />
    )
  return (
    <Typography
      component="h1"
      sx={{ fontSize, fontWeight: 650, lineHeight: 1.25, overflowWrap: 'anywhere' }}
    >
      {canEdit ? (
        <Box
          component="button"
          type="button"
          aria-label={`${documentTexts.rename}: ${artifact.title}`}
          onClick={() => setDraft(artifact.title)}
          sx={{
            all: 'inherit',
            cursor: 'text',
            borderRadius: '6px',
            '&:hover, &:focus-visible': { bgcolor: 'action.hover' },
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

/** The chat of this artifact of the reader (Ар48): their chats with it, and a word to the agent. */
function ArtifactChatPanel({ artifact }: { artifact: CabinetArtifact }) {
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const chats = useQuery(trpc.artifact.chats.queryOptions({ artifactId: artifact.id }))
  const create = useMutation(trpc.task.create.mutationOptions())
  const message = useMutation(trpc.task.message.mutationOptions())
  const [chosen, setChosen] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const list = chats.data ?? []
  const taskId = chosen === 'new' ? null : (chosen ?? list[0]?.taskId ?? null)

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
    } catch {
      setFailed(true)
    }
  }

  return (
    <Box
      component="aside"
      aria-label={pageTexts.chat}
      sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, p: 2 }}
    >
      <Typography component="h2" sx={{ fontSize: 16, fontWeight: 650 }}>
        {pageTexts.chat}
      </Typography>
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
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {pageTexts.noChats}
        </Typography>
      )}
      {taskId !== null && (
        <Link component={NextLink} href={`/chats/${taskId}`} variant="body2">
          {pageTexts.openChat}
        </Link>
      )}
      <TextField
        multiline
        minRows={3}
        label={pageTexts.ask}
        placeholder={pageTexts.askPlaceholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send()
        }}
      />
      <Button
        variant="contained"
        onClick={() => void send()}
        disabled={text.trim() === '' || create.isPending || message.isPending}
        endIcon={<AppIcon name="send" size={16} />}
      >
        {pageTexts.send}
      </Button>
      {sent !== null && (
        <Alert
          severity="success"
          action={
            <Button color="inherit" size="small" onClick={() => router.push(`/chats/${sent}`)}>
              {pageTexts.openChat}
            </Button>
          }
        >
          {pageTexts.sent}
        </Alert>
      )}
      {failed && <Alert severity="error">{pageTexts.sendFailed}</Alert>}
    </Box>
  )
}

/** The outline of a document: its sections, a click scrolls to one. */
function Outline({ artifact }: { artifact: CabinetArtifact }) {
  const sections = artifact.blocks.filter((block) => block.kind === 'section')
  if (sections.length === 0) return null
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
              color="text.primary"
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

/** The page `/artifacts/<id>`. `actions` — what the slices of the history and the pages add. */
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
  const [chatOpen, setChatOpen] = useState(false)
  const onEditing = useCallback((key: string | null) => setBlock(key), [])
  const artifact = read.data

  if (read.isPending) return <Skeleton variant="rounded" height={320} />
  if (!artifact || accessLost)
    return (
      <Alert severity="error">
        {accessLost ? documentTexts.notFound : documentTexts.loadFailed}
      </Alert>
    )
  const spec = artifactKindSpecOf(artifact.kind)
  const chat = <ArtifactChatPanel artifact={artifact} />
  // A mockup and a table take the width of the page: no outline, no column of text.
  const full = artifactBodyWide(artifact.kind)

  return (
    <Box sx={{ width: '100%', maxWidth: 1440, mx: 'auto' }}>
      <Link
        component={NextLink}
        href="/artifacts"
        underline="hover"
        variant="body2"
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, mb: 1.5 }}
      >
        <AppIcon name="back" size={16} />
        {pageTexts.back}
      </Link>
      <Box
        component="header"
        sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 1.5, mb: 3 }}
      >
        <Box sx={{ display: 'flex', color: 'primary.main', pt: 0.75 }} aria-hidden>
          <ArtifactKindIcon kind={artifact.kind} size={24} />
        </Box>
        <Box sx={{ minWidth: 0, flex: '1 1 320px' }}>
          <ArtifactTitle artifact={artifact} onChanged={reread} />
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>
            {[
              spec?.label,
              artifact.project?.name ?? galleryTexts.personal,
              artifact.version > 0 ? artifactSavedLine(artifact.version) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Typography>
        </Box>
        <ArtifactPresenceBar presence={presence} />
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          {actions?.(artifact, reread)}
          {!wide && (
            <Button
              variant="outlined"
              startIcon={<AppIcon name="chat" size={16} />}
              onClick={() => setChatOpen(true)}
            >
              {pageTexts.chat}
            </Button>
          )}
        </Box>
      </Box>
      <Box
        sx={{
          display: 'grid',
          gap: 3,
          gridTemplateColumns: wide
            ? full
              ? 'minmax(0, 1fr) 340px'
              : '200px minmax(0, 1fr) 340px'
            : 'minmax(0, 1fr)',
          alignItems: 'start',
        }}
      >
        {wide && !full && <Outline artifact={artifact} />}
        <Box component="main" sx={{ minWidth: 0, maxWidth: full ? 'none' : 820 }}>
          <ArtifactBody
            artifact={artifact}
            presence={presence}
            onChanged={reread}
            onAccessLost={discardAccess}
            onEditing={onEditing}
            place="page"
          />
        </Box>
        {wide && (
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
            {chat}
          </Box>
        )}
      </Box>
      {!wide && (
        <Drawer anchor="right" open={chatOpen} onClose={() => setChatOpen(false)}>
          <Box sx={{ width: 'min(100vw, 380px)' }}>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', p: 1 }}>
              <IconButton aria-label="Закрыть" onClick={() => setChatOpen(false)}>
                <AppIcon name="close" size={18} />
              </IconButton>
            </Box>
            {chat}
          </Box>
        </Drawer>
      )}
    </Box>
  )
}
