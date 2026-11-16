'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Snackbar from '@mui/material/Snackbar'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useId, useRef, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { UsageWindowHint } from '@/components/billing/usage-window-hint'
import { useRememberedEffort } from '@/components/chat/chat-effort'
import { riseIn } from '@/components/chat/chat-motion'
import { composerText, taskWayText } from '@/components/chat/chat-texts'
import { isPageCommand, useClientCommands } from '@/components/chat/client-commands'
import { Composer } from '@/components/chat/composer'
import { ProjectChats } from '@/components/chat/dialog-list'
import { EffortMenu, type EffortMenuHandle } from '@/components/chat/effort-menu'
import { readPromptHistory } from '@/components/chat/prompt-history'
import { useAttachments } from '@/components/chat/use-attachments'
import { useStartChat } from '@/components/chat/use-start-chat'
import { useTRPC } from '@/trpc/client'

import { ProjectMenuButton, ProjectStarButton, useProjectActions } from './project-actions'
import { ProjectContext } from './project-context'
import { ProjectInstructionsDialog } from './project-instructions'
import { ProjectMemoryRow } from './project-memory'
import { ProjectSchedulesRow } from './project-schedules'
import { PROJECTS_HREF, projectPageText, projectsText } from './project-texts'
import type { ProjectDetails } from './project-types'
import { useContextMentions } from './use-context-mentions'

/**
 * The page of a project (docs/plan/84-projects.md, ПР6; Main, P-project, P-phone): «← Все
 * проекты», the name and the goal, the star and «⋯»; the field «Новый чат в проекте «X»» — the
 * same `Composer` — that starts a chat in it, and «Чаты проекта». Beside them from `lg` — under
 * them below it — the column of the project: «Инструкции», «Контекст» (84.10) and «Приватный ·
 * Видите только вы»; `@` in the field names the files of the context (ПР24); «Память» (84.13)
 * opens its window; «Запланировано» (84.14) — its scheduled tasks and «Добавить».
 */
export function ProjectView({
  initial,
  userId,
  speech = false,
}: {
  initial: ProjectDetails
  userId: string
  speech?: boolean
}) {
  const trpc = useTRPC()
  const router = useRouter()
  const query = useQuery({
    ...trpc.project.get.queryOptions({ projectId: initial.id }),
    initialData: initial,
  })
  const project = query.data
  const [effort, setEffort] = useRememberedEffort()
  const attachments = useAttachments()
  const { start, error, busy } = useStartChat({ userId, effort })
  const [history, setHistory] = useState<readonly string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const effortMenu = useRef<EffortMenuHandle>(null)
  const clientCommands = useClientCommands({ anchor: field })
  const actions = useProjectActions()
  const chatsId = useId()
  const mentions = useContextMentions(project.id)

  useEffect(() => {
    const later = setTimeout(() => setHistory(readPromptHistory(userId)), 0)
    return () => clearTimeout(later)
  }, [userId])

  return (
    <Box sx={{ width: '100%', maxWidth: 1200, mx: 'auto', ...riseIn }}>
      <Box
        component={Link}
        href={PROJECTS_HREF}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.75,
          minHeight: 44,
          color: 'text.secondary',
          textDecoration: 'none',
          fontSize: 14,
          borderRadius: '8px',
          '&:hover': { color: 'text.primary' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
        }}
      >
        <AppIcon name="back" size={16} />
        {projectPageText.back}
      </Box>

      <Box
        sx={{
          mt: 1,
          display: 'grid',
          gap: { xs: 4, lg: 6 },
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 340px' },
          alignItems: 'start',
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
            <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
              <Typography
                component="h1"
                sx={{ fontSize: 28, fontWeight: 600, lineHeight: 1.25, overflowWrap: 'anywhere' }}
              >
                {project.name}
              </Typography>
              {project.goal ? (
                <Typography sx={{ mt: 1, color: 'text.secondary', fontSize: 16 }}>
                  {project.goal}
                </Typography>
              ) : null}
            </Box>
            <Box sx={{ display: 'flex', flex: 'none', mr: -1.25 }}>
              {project.archived ? null : (
                <ProjectStarButton project={project} onNotice={setNotice} />
              )}
              <ProjectMenuButton
                project={project}
                onNotice={setNotice}
                onRemoved={() => router.push(PROJECTS_HREF)}
              />
            </Box>
          </Box>

          {project.archived ? (
            <Alert
              severity="info"
              action={
                <Button
                  color="inherit"
                  size="small"
                  sx={{ minHeight: 44 }}
                  onClick={() =>
                    void actions.archive(project.id, false).then((refused) => {
                      if (refused !== null) setNotice(refused)
                    })
                  }
                >
                  {projectPageText.unarchive}
                </Button>
              }
            >
              {projectPageText.archived}
            </Alert>
          ) : null}

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Composer
              placeholder={projectPageText.placeholder(project.name)}
              disabledReason={project.archived ? projectPageText.archived : null}
              error={error}
              busy={busy}
              onSend={(text, ids) => start(text, ids, project.id)}
              attachments={attachments}
              mentions={mentions}
              noSecrets={taskWayText.noSecrets}
              commands={{
                verdicts: [],
                onRun: (id) => {
                  if (id === 'models') effortMenu.current?.open()
                  else if (isPageCommand(id)) return clientCommands.run(id)
                },
                closedReason: composerText.commandsInDialog,
                plain: true,
              }}
              fieldRef={field}
              history={history}
              speech={speech}
              effort={<EffortMenu value={effort} onChange={setEffort} handle={effortMenu} />}
            />
            <Typography variant="body2" color="text.secondary" sx={{ px: 1 }}>
              {projectPageText.appliesHere}
            </Typography>
            <UsageWindowHint />
            {clientCommands.menu}
          </Box>

          <Box component="section" aria-labelledby={chatsId}>
            <Typography id={chatsId} component="h2" sx={{ fontSize: 16, fontWeight: 600, mb: 1.5 }}>
              {projectPageText.chats}
              {project.chats > 0 ? (
                <Box component="span" sx={{ ml: 1, color: 'text.secondary', fontWeight: 400 }}>
                  · {project.chats}
                </Box>
              ) : null}
            </Typography>
            <ProjectChats projectId={project.id} labelledBy={chatsId} empty={<NoChats />} />
          </Box>
        </Box>

        <Box
          component="aside"
          aria-label={projectsText.title}
          sx={{
            border: 1,
            borderColor: 'divider',
            borderRadius: '14px',
            bgcolor: 'background.paper',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Box sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box sx={{ display: 'flex', color: 'text.secondary' }} aria-hidden>
                <AppIcon name="instructions" size={18} />
              </Box>
              <Typography component="h2" sx={{ flex: '1 1 auto', fontSize: 15, fontWeight: 600 }}>
                {projectPageText.instructions}
              </Typography>
              <Button
                size="small"
                aria-haspopup="dialog"
                aria-label={
                  project.instructions
                    ? `${projectPageText.instructionsEdit}: ${projectPageText.instructions}`
                    : `${projectPageText.instructionsAdd}: ${projectPageText.instructions}`
                }
                onClick={() => setEditing(true)}
                sx={{ minHeight: 44 }}
              >
                {project.instructions
                  ? projectPageText.instructionsEdit
                  : projectPageText.instructionsAdd}
              </Button>
            </Box>
            <Typography
              sx={{
                color: 'text.secondary',
                fontSize: 14,
                display: '-webkit-box',
                WebkitLineClamp: 4,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                whiteSpace: 'pre-line',
                overflowWrap: 'anywhere',
              }}
            >
              {project.instructions ?? projectPageText.instructionsEmpty}
            </Typography>
          </Box>
          <Box sx={{ borderTop: 1, borderColor: 'divider' }}>
            <ProjectContext project={project} />
          </Box>
          <Box sx={{ borderTop: 1, borderColor: 'divider' }}>
            <ProjectMemoryRow project={project} />
          </Box>
          <Box sx={{ borderTop: 1, borderColor: 'divider' }}>
            <ProjectSchedulesRow project={project} userId={userId} />
          </Box>
          <Box
            sx={{
              borderTop: 1,
              borderColor: 'divider',
              px: 2.5,
              py: 2,
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              color: 'text.secondary',
              fontSize: 13,
            }}
          >
            <AppIcon name="lock" size={16} />
            <Box component="span">
              <Box component="span" sx={{ color: 'text.primary', fontWeight: 500 }}>
                {projectPageText.privacy}
              </Box>{' '}
              · {projectPageText.privacyHint}
            </Box>
          </Box>
        </Box>
      </Box>

      <ProjectInstructionsDialog
        projectId={project.id}
        initial={project.instructions ?? ''}
        open={editing}
        onClose={() => setEditing(false)}
      />
      <Snackbar
        open={notice !== null}
        autoHideDuration={5000}
        onClose={() => setNotice(null)}
        message={notice}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  )
}

/** A project without chats (Main): what the list will hold and two ways to begin. */
function NoChats() {
  return (
    <Box
      sx={{
        border: 1,
        borderStyle: 'dashed',
        borderColor: 'divider',
        borderRadius: '14px',
        p: 2.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      <Typography sx={{ fontSize: 15 }}>{projectPageText.noChats}</Typography>
      <Box component="ul" sx={{ m: 0, pl: 2.5, color: 'text.secondary', fontSize: 14 }}>
        {projectPageText.hints.map((hint) => (
          <li key={hint}>{hint}</li>
        ))}
      </Box>
    </Box>
  )
}
