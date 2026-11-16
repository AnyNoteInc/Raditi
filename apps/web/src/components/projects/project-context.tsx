'use client'

import { projectRoomPercent } from '@repo/domain/projects'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useId, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { callErrorText } from '@/components/chat/call-error'
import { useTRPC } from '@/trpc/client'

import { ContextAddMenu } from './context-add-menu'
import {
  ContextTile,
  ContextUploadChips,
  ContextUsage,
  contextIcon,
  contextMeta,
  contextShownName,
} from './context-parts'
import { ContextTextDialog } from './context-text-dialog'
import { contextText } from './project-texts'
import { ProjectRepositoryRow, useRepositoryWindows } from './project-repository'
import type { ProjectDetails } from './project-types'
import { useContextUploads, type ContextUploads } from './use-context-uploads'

/** The files of «Контекст» the row of the page names before «и ещё N файлов». */
export const CONTEXT_ROW_FILES = 3

/** Where a file of the context is downloaded (ПР8): only to the author of the project. */
export const contextFileHref = (fileId: string) => `/api/project-files/${fileId}`

/**
 * «Контекст» of the column of a project (docs/plan/84-projects.md, ПР8, §4.8; P-project,
 * P-context-menu): «Добавить» with its menu, the first files and «и ещё N файлов», the files on
 * their way and «Занято N % места». A press on the files opens the window «Контекст» (P-context;
 * the whole screen on a phone — P-phone-sheet). A file is taken by the project as soon as its
 * bytes are in.
 */
export function ProjectContext({ project }: { project: ProjectDetails }) {
  const repository = useRepositoryWindows(project)
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [writing, setWriting] = useState(false)
  const titleId = useId()
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: trpc.projectFile.pathKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.project.pathKey() })
  }, [queryClient, trpc])
  const uploads = useContextUploads({ projectId: project.id, onBound: refresh })
  const { files } = project
  const rest = files.count - Math.min(files.count, CONTEXT_ROW_FILES)

  return (
    <Box component="section" aria-labelledby={titleId} data-project-context="">
      <Box sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{ display: 'flex', color: 'text.secondary' }} aria-hidden>
            <AppIcon name="layers" size={18} />
          </Box>
          <Typography
            id={titleId}
            component="h2"
            sx={{ flex: '1 1 auto', fontSize: 15, fontWeight: 600 }}
          >
            {contextText.title}
          </Typography>
          <ContextAddMenu
            variant="text"
            onFiles={uploads.add}
            onText={() => setWriting(true)}
            onLink={repository.onLink}
            onGitlab={repository.onGitlab}
            repositoryAttached={project.repository !== null}
          />
        </Box>
        {repository.notice ? (
          <Alert severity="info" onClose={repository.clearNotice}>
            {repository.notice}
          </Alert>
        ) : null}
        {/* The repository is part of «Контекст» (ПР6): under its title, with its last state. */}
        <ProjectRepositoryRow project={project} compact onSignIn={repository.onGitlab} />
        {files.count === 0 && project.repository !== null ? (
          <Box>
            <Button
              size="small"
              aria-haspopup="dialog"
              onClick={() => setOpen(true)}
              sx={{ minHeight: 44 }}
            >
              {contextText.open}
            </Button>
          </Box>
        ) : files.count === 0 ? (
          <Typography sx={{ color: 'text.secondary', fontSize: 14 }}>
            {contextText.rowEmpty}
          </Typography>
        ) : (
          <ButtonBase
            aria-haspopup="dialog"
            aria-label={contextText.open}
            onClick={() => setOpen(true)}
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'stretch',
              textAlign: 'left',
              gap: 1,
              mx: -1,
              p: 1,
              borderRadius: '10px',
              '&:hover': { bgcolor: 'action.hover' },
              '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' },
            }}
          >
            {files.first.slice(0, CONTEXT_ROW_FILES).map((file) => (
              <Box
                key={file.id}
                sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}
              >
                <Box sx={{ display: 'flex', color: 'text.secondary' }} aria-hidden>
                  <AppIcon name={contextIcon(file.name, file.kind)} size={16} />
                </Box>
                <Box
                  component="span"
                  sx={{
                    flex: '0 1 auto',
                    minWidth: 0,
                    fontSize: 14,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {contextShownName(file.name, file.kind)}
                </Box>
                <Box
                  component="span"
                  sx={{ flex: 'none', fontSize: 12.5, color: 'text.secondary' }}
                >
                  {contextMeta(file.name, file.kind, file.sizeBytes)}
                </Box>
              </Box>
            ))}
            {rest > 0 ? (
              <Box component="span" sx={{ fontSize: 13, color: 'text.secondary' }}>
                {contextText.more(rest)}
              </Box>
            ) : null}
          </ButtonBase>
        )}
        <ContextUploadChips
          uploads={uploads.items}
          onRetry={uploads.retry}
          onRemove={uploads.remove}
        />
        {files.count > 0 ? (
          <ContextUsage
            bytes={files.bytes}
            limitBytes={files.limitBytes}
            percent={projectRoomPercent(files.bytes)}
            compact
          />
        ) : null}
      </Box>
      {repository.windows}
      <ContextDialog
        project={project}
        open={open}
        onClose={() => setOpen(false)}
        uploads={uploads}
        onWrite={() => setWriting(true)}
        onLink={repository.onLink}
        onGitlab={repository.onGitlab}
        onRemoved={refresh}
      />
      <ContextTextDialog open={writing} onClose={() => setWriting(false)} onAdd={uploads.addText} />
    </Box>
  )
}

/**
 * The window «Контекст» (P-context; P-phone-sheet on a phone): what the agent sees of it, the room
 * taken, «Файлы и тексты» with «Скачать» and «Убрать», the files on their way, «Добавить» and
 * «Готово».
 */
export function ContextDialog({
  project,
  open,
  onClose,
  uploads,
  onWrite,
  onLink,
  onGitlab,
  onRemoved,
}: {
  project: Pick<ProjectDetails, 'id' | 'repository'>
  open: boolean
  onClose: () => void
  uploads: ContextUploads
  onWrite: () => void
  /** The ways of a repository of «Добавить» (ревью P1); absent — «Скоро». */
  onLink?: () => void
  onGitlab?: () => void
  onRemoved: () => void
}) {
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'))
  const titleId = useId()
  const listId = useId()
  const trpc = useTRPC()
  const list = useQuery({
    ...trpc.projectFile.list.queryOptions({ projectId: project.id }),
    enabled: open,
  })
  const remove = useMutation(trpc.projectFile.remove.mutationOptions())
  const [error, setError] = useState<string | null>(null)
  const files = list.data?.files ?? []

  async function removeFile(fileId: string) {
    setError(null)
    try {
      await remove.mutateAsync({ projectId: project.id, fileId })
      onRemoved()
    } catch (failure) {
      setError(callErrorText(failure, contextText.removeFailed))
    }
  }

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
          <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
            <Typography id={titleId} component="h2" sx={{ fontSize: 20, fontWeight: 600 }}>
              {contextText.title}
            </Typography>
            <Typography sx={{ mt: 1, color: 'text.secondary', fontSize: 14 }}>
              {contextText.lead}
            </Typography>
          </Box>
          <IconButton
            aria-label={contextText.close}
            onClick={onClose}
            sx={{ width: 44, height: 44, mt: -1, mr: -1 }}
          >
            <AppIcon name="close" size={20} />
          </IconButton>
        </Box>

        {list.data ? (
          <ContextUsage
            bytes={list.data.bytes}
            limitBytes={list.data.limitBytes}
            percent={list.data.percent}
          />
        ) : null}

        <ProjectRepositoryRow project={project} {...(onGitlab ? { onSignIn: onGitlab } : {})} />

        <Box component="section" aria-labelledby={listId}>
          <Typography id={listId} component="h3" sx={{ fontSize: 15, fontWeight: 600, mb: 1 }}>
            {contextText.list}
            {files.length > 0 ? (
              <Box component="span" sx={{ ml: 1, color: 'text.secondary', fontWeight: 400 }}>
                · {files.length}
              </Box>
            ) : null}
          </Typography>
          {list.isPending && open ? (
            <Box role="status" aria-label={contextText.loading} sx={{ py: 2, display: 'flex' }}>
              <CircularProgress size={20} />
            </Box>
          ) : list.isError ? (
            <Alert severity="error">{contextText.loadFailed}</Alert>
          ) : files.length === 0 ? (
            <Typography sx={{ color: 'text.secondary', fontSize: 14 }}>
              {contextText.empty}
            </Typography>
          ) : (
            <Box
              component="ul"
              aria-labelledby={listId}
              sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexDirection: 'column' }}
            >
              {files.map((file) => {
                const name = contextShownName(file.name, file.kind)
                return (
                  <Box
                    component="li"
                    key={file.id}
                    data-context-file={file.name}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1.25,
                      py: 1,
                      borderTop: 1,
                      borderColor: 'divider',
                      '&:first-of-type': { borderTop: 0 },
                    }}
                  >
                    <ContextTile icon={contextIcon(file.name, file.kind)} />
                    <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
                      <Typography
                        title={file.name}
                        sx={{
                          fontSize: 14,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {name}
                      </Typography>
                      <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                        {contextMeta(file.name, file.kind, file.sizeBytes)} ·{' '}
                        {contextText.added(file.createdAt)}
                      </Typography>
                    </Box>
                    <IconButton
                      component="a"
                      href={contextFileHref(file.id)}
                      download
                      aria-label={contextText.download(name)}
                      sx={{ width: 44, height: 44, flex: 'none' }}
                    >
                      <AppIcon name="download" size={18} />
                    </IconButton>
                    <IconButton
                      aria-label={contextText.remove(name)}
                      disabled={remove.isPending}
                      onClick={() => void removeFile(file.id)}
                      sx={{ width: 44, height: 44, flex: 'none' }}
                    >
                      <AppIcon name="trash" size={18} />
                    </IconButton>
                  </Box>
                )
              })}
            </Box>
          )}
        </Box>

        <ContextUploadChips
          uploads={uploads.items}
          onRetry={uploads.retry}
          onRemove={uploads.remove}
        />
        {error ? <Alert severity="error">{error}</Alert> : null}

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <ContextAddMenu
            variant="pill"
            title={contextText.add}
            onFiles={uploads.add}
            onText={onWrite}
            {...(onLink ? { onLink } : {})}
            {...(onGitlab ? { onGitlab } : {})}
            repositoryAttached={project.repository !== null}
          />
          <Box sx={{ flex: '1 1 auto' }} />
          <Button variant="contained" onClick={onClose} sx={{ minHeight: 44 }}>
            {contextText.done}
          </Button>
        </Box>
      </Box>
    </Dialog>
  )
}
