'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import IconButton from '@mui/material/IconButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { projectLimits } from '@repo/domain/projects'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { ConfirmDialog } from '@/components/billing/confirm-dialog'
import { callErrorText } from '@/components/chat/call-error'
import { dialogListKey } from '@/components/chat/dialog-actions'
import { useTRPC } from '@/trpc/client'

import { projectsText } from './project-texts'

/** What a project's menu acts on. */
export interface ProjectActionsTarget {
  id: string
  name: string
  starred: boolean
  archived: boolean
}

/**
 * The changes of a project from its card and its page (docs/plan/84-projects.md, ПР4, ПР20): each
 * press reads the projects and the chats again; what the server said comes back as a sentence.
 */
export function useProjectActions() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const star = useMutation(trpc.project.star.mutationOptions())
  const archive = useMutation(trpc.project.archive.mutationOptions())
  const remove = useMutation(trpc.project.remove.mutationOptions())
  const restore = useMutation(trpc.project.restore.mutationOptions())
  const purge = useMutation(trpc.project.purge.mutationOptions())
  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.project.pathKey() })
    // The chats of a project in the trash leave the list, and come back with it (ПР20).
    void queryClient.invalidateQueries({ queryKey: dialogListKey })
  }
  async function run(call: () => Promise<unknown>): Promise<string | null> {
    try {
      await call()
      return null
    } catch (failure) {
      return callErrorText(failure)
    } finally {
      settle()
    }
  }
  return {
    star: (projectId: string, starred: boolean) =>
      run(() => star.mutateAsync({ projectId, starred })),
    archive: (projectId: string, archived: boolean) =>
      run(() => archive.mutateAsync({ projectId, archived })),
    remove: (projectId: string) => run(() => remove.mutateAsync({ projectId })),
    restore: (projectId: string) => run(() => restore.mutateAsync({ projectId })),
    purge: (projectId: string) => run(() => purge.mutateAsync({ projectId })),
    removing: remove.isPending,
    purging: purge.isPending,
  }
}

/**
 * «Удалить навсегда…» of a project in «Корзина» (ПР38): before its 30 days, after a question — it
 * cannot be returned then.
 */
export function ProjectPurgeButton({
  project,
  onNotice,
}: {
  project: { id: string; name: string }
  onNotice: (text: string) => void
}) {
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const actions = useProjectActions()
  return (
    <>
      <Button
        size="small"
        color="error"
        startIcon={<AppIcon name="trash" size={14} />}
        aria-haspopup="dialog"
        aria-label={`${projectsText.purgeConfirm}: ${project.name}`}
        onClick={() => {
          setError(null)
          setAsking(true)
        }}
        sx={{ minHeight: 36, borderRadius: 999 }}
      >
        {projectsText.purge}
      </Button>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        title={projectsText.purgeTitle(project.name)}
        busy={actions.purging}
        error={error}
        keepLabel={projectsText.removeKeep}
        confirmLabel={projectsText.purgeConfirm}
        danger
        onConfirm={() =>
          void actions.purge(project.id).then((refused) => {
            if (refused !== null) {
              setError(refused)
              return
            }
            setAsking(false)
            onNotice(projectsText.purged(project.name))
          })
        }
      >
        <Typography sx={{ mt: 1.5 }}>{projectsText.purgeBody}</Typography>
      </ConfirmDialog>
    </>
  )
}

/** The star of a project: «В избранное» / «Убрать из избранного». */
export function ProjectStarButton({
  project,
  onNotice,
}: {
  project: ProjectActionsTarget
  onNotice: (text: string) => void
}) {
  const actions = useProjectActions()
  return (
    <IconButton
      aria-label={
        project.starred
          ? projectsText.unstarLabel(project.name)
          : projectsText.starLabel(project.name)
      }
      aria-pressed={project.starred}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void actions.star(project.id, !project.starred).then((refused) => {
          if (refused !== null) onNotice(refused)
        })
      }}
      sx={{
        width: 44,
        height: 44,
        flex: 'none',
        color: project.starred ? 'primary.main' : 'text.secondary',
        '&:hover': { bgcolor: 'action.hover', color: 'primary.main' },
      }}
    >
      <AppIcon name="star" size={18} filled={project.starred} />
    </IconButton>
  )
}

/**
 * «⋯» of a project (P-list): «В избранное», «Переименовать», «В архив», «Удалить» — into the
 * trash for 30 days, after a question.
 */
export function ProjectMenuButton({
  project,
  onNotice,
  onRemoved,
}: {
  project: ProjectActionsTarget
  onNotice: (text: string) => void
  /** The project went to the trash: the page of it leaves for the list. */
  onRemoved?: () => void
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const actions = useProjectActions()
  const menuId = useId()
  const open = anchor !== null
  const item = (icon: Parameters<typeof AppIcon>[0]['name'], label: string, press: () => void) => (
    <MenuItem
      onClick={() => {
        setAnchor(null)
        press()
      }}
      sx={{ minHeight: { xs: 44 }, fontSize: 14 }}
    >
      <ListItemIcon>
        <AppIcon name={icon} size={18} />
      </ListItemIcon>
      {label}
    </MenuItem>
  )
  const said = (refused: string | null, done: string) => onNotice(refused ?? done)
  return (
    <>
      <IconButton
        aria-label={projectsText.menu(project.name)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setAnchor(event.currentTarget)
        }}
        sx={{
          width: 44,
          height: 44,
          flex: 'none',
          color: 'text.secondary',
          '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
        }}
      >
        <AppIcon name="more" size={20} />
      </IconButton>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={open}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { borderRadius: '12px', minWidth: 220 } } }}
      >
        {project.archived
          ? null
          : item(
              'star',
              project.starred ? projectsText.unstar : projectsText.star,
              () =>
                void actions.star(project.id, !project.starred).then((refused) => {
                  if (refused !== null) onNotice(refused)
                }),
            )}
        {item('pencil', projectsText.rename, () => setRenaming(true))}
        {item(
          'archive',
          project.archived ? projectsText.unarchive : projectsText.archive,
          () =>
            void actions
              .archive(project.id, !project.archived)
              .then((refused) =>
                said(
                  refused,
                  project.archived
                    ? projectsText.unarchived(project.name)
                    : projectsText.archived(project.name),
                ),
              ),
        )}
        <MenuItem
          onClick={() => {
            setAnchor(null)
            setRemoveError(null)
            setRemoving(true)
          }}
          sx={{
            minHeight: { xs: 44 },
            fontSize: 14,
            color: 'error.main',
            alignItems: 'flex-start',
          }}
        >
          <ListItemIcon sx={{ color: 'inherit', mt: 0.25 }}>
            <AppIcon name="trash" size={18} />
          </ListItemIcon>
          <ListItemText
            primary={projectsText.remove}
            secondary={projectsText.removeHint}
            slotProps={{
              primary: { sx: { fontSize: 14 } },
              secondary: { sx: { fontSize: 12 } },
            }}
          />
        </MenuItem>
      </Menu>
      <RenameProjectDialog project={project} open={renaming} onClose={() => setRenaming(false)} />
      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        title={projectsText.removeTitle(project.name)}
        busy={actions.removing}
        error={removeError}
        keepLabel={projectsText.removeKeep}
        confirmLabel={projectsText.removeConfirm}
        danger
        onConfirm={() =>
          void actions.remove(project.id).then((refused) => {
            if (refused !== null) {
              setRemoveError(refused)
              return
            }
            setRemoving(false)
            onNotice(projectsText.removed(project.name))
            onRemoved?.()
          })
        }
      >
        <Typography sx={{ mt: 1.5 }}>{projectsText.removeBody}</Typography>
      </ConfirmDialog>
    </>
  )
}

/** «Переименовать»: the name in a small window, «Сохранить» and «Отмена». */
export function RenameProjectDialog({
  project,
  open,
  onClose,
}: {
  project: { id: string; name: string }
  open: boolean
  onClose: () => void
}) {
  const titleId = useId()
  return (
    <Dialog
      open={open}
      onClose={onClose}
      aria-labelledby={titleId}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: '100%',
            maxWidth: 480,
            m: 2,
            border: 1,
            borderColor: 'divider',
            borderRadius: '14px',
          },
        },
      }}
    >
      {open ? <RenameForm project={project} titleId={titleId} onClose={onClose} /> : null}
    </Dialog>
  )
}

function RenameForm({
  project,
  titleId,
  onClose,
}: {
  project: { id: string; name: string }
  titleId: string
  onClose: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const update = useMutation(trpc.project.update.mutationOptions())
  const [name, setName] = useState(project.name)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const next = name.replace(/\s+/gu, ' ').trim()
    if (next === '' || next === project.name) {
      onClose()
      return
    }
    setError(null)
    try {
      await update.mutateAsync({ projectId: project.id, name: next })
      void queryClient.invalidateQueries({ queryKey: trpc.project.pathKey() })
      // The rows of its chats name the project.
      void queryClient.invalidateQueries({ queryKey: dialogListKey })
      onClose()
    } catch (failure) {
      setError(callErrorText(failure))
    }
  }

  return (
    <Box
      component="form"
      noValidate
      onSubmit={(event: FormEvent) => void submit(event)}
      sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, p: 3 }}
    >
      <Typography id={titleId} component="h2" sx={{ fontSize: 20, fontWeight: 600 }}>
        {projectsText.renameTitle}
      </Typography>
      <TextField
        label={projectsText.nameLabel}
        value={name}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        slotProps={{ htmlInput: { maxLength: projectLimits.nameChars } }}
      />
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
        <Button onClick={onClose} disabled={update.isPending} sx={{ minHeight: 44 }}>
          {projectsText.cancel}
        </Button>
        <Button type="submit" variant="contained" loading={update.isPending} sx={{ minHeight: 44 }}>
          {projectsText.save}
        </Button>
      </Box>
    </Box>
  )
}
