'use client'

import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Snackbar from '@mui/material/Snackbar'
import Tooltip from '@mui/material/Tooltip'
import { artifactKindSpecOf, artifactRoleAtLeast } from '@repo/domain/artifacts'
import { useMutation } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'
import { DictationAvailable } from '@/components/chat/dictation-button'
import { useTRPC } from '@/trpc/client'

import { ArtifactSharingAvailable } from './artifact-comments'
import { downloadDocumentMarkdown } from './artifact-document-text'
import { ArtifactHistoryButton } from './artifact-history'
import { ArtifactMoveDialog, moveTexts } from './artifact-move'
import { ArtifactPage } from './artifact-page'
import { ArtifactPublishButton } from './artifact-publish'
import {
  ArtifactShareButton,
  shareTexts,
  useArtifactCopy,
  useArtifactLeave,
} from './artifact-share'
import { galleryTexts } from './artifact-texts'
import { rememberTrashed } from './artifact-trash-notice'
import type { CabinetArtifact } from './use-artifact'

export const viewTexts = Object.freeze({
  more: 'Ещё',
  markdown: 'Скачать в формате Markdown',
  trashFailed: 'Не получилось переместить в корзину. Попробуйте ещё раз.',
})

/**
 * «⋯» of the head (docs/plan/93-artifacts-trim.md, АТ9): what is done rarely — «Перенести в
 * проект», «Сделать копию», «Скачать…», «Покинуть» and «В корзину», which asks nothing: the gallery
 * then offers «Вернуть».
 */
function ArtifactMoreMenu({
  artifact,
  sharing,
  onChanged,
}: {
  artifact: CabinetArtifact
  sharing: boolean
  onChanged: () => void
}) {
  const trpc = useTRPC()
  const router = useRouter()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [moving, setMoving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const copy = useArtifactCopy(artifact, sharing, setProblem)
  const leave = useArtifactLeave(artifact, sharing)
  const trash = useMutation(trpc.artifact.trash.mutationOptions())
  const owner = artifactRoleAtLeast(artifact.role, 'owner')
  const markdown = artifactKindSpecOf(artifact.kind)?.exports.includes('md') === true
  const close = () => setAnchor(null)
  const item = (key: string, icon: AppIconName, label: string, run: () => void, danger = false) => (
    <MenuItem
      key={key}
      onClick={() => {
        close()
        run()
      }}
      sx={danger ? { color: 'error.main' } : undefined}
    >
      <ListItemIcon sx={{ color: 'inherit' }}>
        <AppIcon name={icon} size={18} />
      </ListItemIcon>
      <ListItemText>{label}</ListItemText>
    </MenuItem>
  )
  const items: ReactNode[] = []
  if (owner) items.push(item('move', 'layers', moveTexts.open, () => setMoving(true)))
  if (copy.available && !copy.pending)
    items.push(item('copy', 'copy', shareTexts.makeCopy, copy.run))
  if (markdown)
    items.push(
      item('markdown', 'download', viewTexts.markdown, () => downloadDocumentMarkdown(artifact)),
    )
  if (leave.available && !leave.pending)
    items.push(item('leave', 'logout', shareTexts.leave, leave.run))
  if (owner) {
    if (items.length > 0) items.push(<Divider key="divider" />)
    items.push(
      item(
        'trash',
        'trash',
        galleryTexts.toTrash,
        () =>
          void trash
            .mutateAsync({ artifactId: artifact.id })
            .then(() => {
              rememberTrashed(artifact.id, artifact.title)
              router.push('/artifacts')
            })
            .catch(() => setProblem(viewTexts.trashFailed)),
        true,
      ),
    )
  }
  if (items.length === 0) return null
  return (
    <>
      <Tooltip title={viewTexts.more}>
        <IconButton
          aria-label={viewTexts.more}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          onClick={(event) => setAnchor(event.currentTarget)}
          sx={{ width: 40, height: 40, flexShrink: 0 }}
        >
          <AppIcon name="more" size={18} />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {items}
      </Menu>
      {moving && (
        <ArtifactMoveDialog
          artifact={artifact}
          open
          onClose={() => setMoving(false)}
          onChanged={onChanged}
        />
      )}
      <Snackbar
        open={problem !== null}
        autoHideDuration={6000}
        onClose={() => setProblem(null)}
        message={problem}
      />
    </>
  )
}

/**
 * The page of an artifact with what is done from its head (Ар23; АТ9): «История версий» as an
 * icon, «Опубликовать», «Поделиться» — the main action, where access of others is open — and the
 * rest in «⋯».
 */
export function ArtifactView({
  artifactId,
  speech = false,
  sharing = false,
}: {
  artifactId: string
  /** Dictation into the fields of notes (SpeechKit, docs/plan/75, ВВ16). */
  speech?: boolean
  /** Access of other users is open here (docs/plan/88-artifacts.md, 88.16; the flag of production). */
  sharing?: boolean
}) {
  return (
    <DictationAvailable.Provider value={speech}>
      <ArtifactSharingAvailable.Provider value={sharing}>
        <ArtifactPage
          artifactId={artifactId}
          actions={(artifact, reread) => (
            <>
              <ArtifactHistoryButton artifact={artifact} onChanged={reread} />
              <ArtifactPublishButton artifact={artifact} />
              {sharing ? <ArtifactShareButton artifact={artifact} /> : null}
              <ArtifactMoreMenu artifact={artifact} sharing={sharing} onChanged={reread} />
            </>
          )}
        />
      </ArtifactSharingAvailable.Provider>
    </DictationAvailable.Provider>
  )
}
