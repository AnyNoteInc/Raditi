'use client'

import { chatSuggestionsFor } from '@repo/domain/tasks/chat-suggestions'
import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { useTRPC } from '@/trpc/client'

import { sendErrorText } from './call-error'
import { chatHref } from './chat-address'
import { keepChatDraft, takeChatDraft } from './chat-draft'
import { useRememberedEffort } from './chat-effort'
import { useGreeting } from './chat-greeting'
import { riseIn } from './chat-motion'
import { composerText, taskWayText } from './chat-texts'
import type { ProjectListItem } from './chat-types'
import { isPageCommand, useClientCommands } from './client-commands'
import { Composer } from './composer'
import { dialogListKey } from './dialog-list'
import { EffortMenu, type EffortMenuHandle } from './effort-menu'
import { markNewDialog } from './new-dialog-hint'
import { PlanToggle, useRememberedPlan } from './plan-toggle'
import { ProjectPicker, projectChoosable } from './project-picker'
import { readPromptHistory, rememberPrompt } from './prompt-history'
import { useAttachments } from './use-attachments'
import { uuidv7 } from './uuid'
import { UsageWindowHint } from '@/components/billing/usage-window-hint'

/**
 * The screen a chat starts from (docs/plan/53-chat-preview-release.md, R9; docs/plan/61-chats-
 * first.md, К6–К9). The first words start a chat: the browser invents its id, so a repeat of the
 * same request after a lost answer finds the same chat, and the screen moves to it. The pill at
 * the field chooses the project: none is chosen by default, and nothing here ever closes sending.
 * The server reads from the project how the agent works, the client sends only the project.
 * `?project=` chooses one the client may choose; a project of someone else, a closed or an unknown
 * one is «Без проекта». «Размышление» picks how hard the model thinks — the same menu changes it
 * later in the chat. Beside the list at the root of the section (`beside`) the heading of the page
 * is the list's, so the screen takes the level below; below `md` that screen stands hidden on the
 * page, and it leaves the words kept for a new chat to the one the client will see.
 */
export function NewChat({
  userId,
  userName = null,
  beside = false,
  speech = false,
}: {
  userId: string
  /** The client's name: the greeting calls them by it (owner's request of 09.11.2026). */
  userName?: string | null
  beside?: boolean
  /** Dictation is set up here (docs/plan/75-chat-input-output.md, ВВ16). */
  speech?: boolean
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  const asked = useSearchParams().get('project')?.toLowerCase() ?? null
  // Nothing is known while it loads or after it failed: the field works all the same.
  const list = useQuery(trpc.project.list.queryOptions())
  const projects: readonly ProjectListItem[] = list.data ?? []
  // undefined — the client has not chosen: the address speaks. null — «Без проекта».
  const [chosen, setChosen] = useState<string | null | undefined>(undefined)
  // A file is bound to the project of the moment (К9): while one is attached, neither an answer of
  // the list nor the address moves it. A project closed meanwhile stays too, for the server to say
  // so: the same words without it would be refused because of the file.
  const [held, setHeld] = useState<{ siteId: string | null } | null>(null)
  const wanted = held !== null ? held.siteId : chosen === undefined ? asked : chosen
  const found = projects.find((project) => project.id.toLowerCase() === wanted?.toLowerCase())
  const project = found !== undefined && (held !== null || projectChoosable(found)) ? found : null
  const siteId = held !== null ? held.siteId : (project?.id ?? null)
  // The level chosen last in this browser (owner's request of 09.11.2026).
  const [effort, setEffort] = useRememberedEffort()
  // «Сначала план» (docs/plan/75, ВВ12), remembered as the level is.
  const [plan, setPlan] = useRememberedPlan()
  const greeting = useGreeting(userName)
  const attachments = useAttachments(siteId)
  const attached = attachments.items.length > 0
  if (attached !== (held !== null)) setHeld(attached ? { siteId } : null)
  // One id per chat being started: a repeat after a lost answer lands on the same one. The id is of
  // its project: the same id with another `siteId` would find nothing (`sameDialog`), and the
  // project changes by more than a press — by the address and by the list that arrives.
  const pending = useRef<{ siteId: string | null; id: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const create = useMutation(trpc.task.create.mutationOptions())
  // The words kept while the client added a project come back here.
  const written = useRef('')
  const [draft, setDraft] = useState<string | null>(null)
  // Something is written: the suggestions step aside (ВВ24).
  const [typed, setTyped] = useState(false)
  // The requests this browser sent before: the arrows of the field bring them back (ВВ23).
  const [history, setHistory] = useState<readonly string[]>([])
  const wide = useMediaQuery(useTheme().breakpoints.up('md'))
  const shown = !beside || wide
  const field = useRef<HTMLTextAreaElement>(null)
  const effortMenu = useRef<EffortMenuHandle>(null)
  const clientCommands = useClientCommands({ projectId: siteId, anchor: field })
  // After the first paint: the server draws the field empty, and Strict Mode mounts this twice.
  useEffect(() => {
    if (!shown) return
    const later = setTimeout(() => {
      setDraft(takeChatDraft(userId))
      setHistory(readPromptHistory(userId))
    }, 0)
    return () => clearTimeout(later)
  }, [shown, userId])

  async function start(text: string, attachmentIds: readonly string[]): Promise<boolean> {
    if (pending.current?.siteId !== siteId) pending.current = { siteId, id: uuidv7() }
    setError(null)
    try {
      const created = await create.mutateAsync({
        siteId,
        taskId: pending.current.id,
        text,
        ...(attachmentIds.length > 0 ? { attachments: [...attachmentIds] } : {}),
        effort,
        ...(plan ? { plan: true } : {}),
      })
      pending.current = null
      rememberPrompt(userId, text)
      void queryClient.invalidateQueries({ queryKey: dialogListKey })
      // The new chat set credits aside: the ring of the credits reads them again.
      void queryClient.invalidateQueries({ queryKey: trpc.billing.usage.queryKey() })
      // The client watches the chat from its start: a browser launched before its first read
      // opens beside it too (docs/plan/59, И3).
      markNewDialog(created.taskId)
      router.push(chatHref(created.taskId))
      return true
    } catch (failure) {
      setError(sendErrorText(failure, { withProject: siteId !== null }))
      return false
    }
  }

  return (
    <Box
      sx={{
        flex: '1 0 auto',
        width: '100%',
        maxWidth: 780,
        mx: 'auto',
        display: 'flex',
        flexDirection: 'column',
        // On a phone the field stays by the thumb; from `sm` the screen is centred.
        justifyContent: { xs: 'flex-end', sm: 'center' },
        gap: 3,
        pb: { sm: 4 },
        // The one entrance of the screen: the field comes up as the page opens.
        ...riseIn,
      }}
    >
      <Box sx={{ textAlign: 'center' }}>
        <Typography
          component={beside ? 'h2' : 'h1'}
          sx={{
            fontSize: { xs: 24, sm: 28 },
            fontWeight: 500,
            letterSpacing: '-0.01em',
            lineHeight: 1.25,
          }}
        >
          {greeting}
        </Typography>
      </Box>

      <Composer
        placeholder={composerText.newPlaceholder}
        error={error}
        busy={create.isPending}
        onSend={start}
        attachments={attachments}
        noSecrets={
          project === null
            ? taskWayText.noSecretsPlain
            : project.chat.requirements?.browser
              ? taskWayText.noSecrets
              : undefined
        }
        // The window of commands is here as in a chat: the page's own commands work, and of the
        // others it says that they work there.
        commands={{
          verdicts: [],
          onRun: (id) => {
            if (id === 'models') effortMenu.current?.open()
            else if (isPageCommand(id)) return clientCommands.run(id)
          },
          closedReason: composerText.commandsInDialog,
          // Without the files of a project the chat will not have the site's commands (К27).
          plain: project?.chat.requirements?.repository !== true,
        }}
        fieldRef={field}
        restored={draft}
        onTextChange={(text) => {
          written.current = text
          setTyped(text.trim() !== '')
        }}
        history={history}
        speech={speech}
        project={
          <ProjectPicker
            projects={projects}
            value={project}
            locked={attached}
            onChange={(next) => setChosen(next?.id ?? null)}
            onAddProject={() => keepChatDraft(userId, written.current)}
          />
        }
        effort={
          <>
            <EffortMenu value={effort} onChange={setEffort} handle={effortMenu} />
            <PlanToggle on={plan} onChange={setPlan} />
          </>
        }
      />
      {typed ? null : (
        <Box
          component="ul"
          aria-label={composerText.suggestions}
          sx={{
            listStyle: 'none',
            m: 0,
            p: 0,
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: 1,
          }}
        >
          {chatSuggestionsFor(project?.chat.requirements ?? null).map((words) => (
            <Box component="li" key={words} sx={{ display: 'flex' }}>
              <ButtonBase
                onClick={() => {
                  setDraft(words)
                  field.current?.focus()
                }}
                sx={{
                  minHeight: 44,
                  px: 2,
                  borderRadius: '999px',
                  border: '1px solid',
                  borderColor: 'divider',
                  color: 'text.secondary',
                  fontSize: 14,
                  textAlign: 'left',
                  '&:hover': { color: 'text.primary', bgcolor: 'action.hover' },
                  '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' },
                }}
              >
                {words.replace(/[: ]+$/, '')}
              </ButtonBase>
            </Box>
          ))}
        </Box>
      )}
      <UsageWindowHint />
      {clientCommands.menu}
    </Box>
  )
}
