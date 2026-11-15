'use client'

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { useTRPC } from '@/trpc/client'

import { sendErrorText } from './call-error'
import { chatHref } from './chat-address'
import { takeChatDraft } from './chat-draft'
import { useRememberedEffort } from './chat-effort'
import { useGreeting } from './chat-greeting'
import { riseIn } from './chat-motion'
import { composerText, taskWayText } from './chat-texts'
import { isPageCommand, useClientCommands } from './client-commands'
import { Composer } from './composer'
import { dialogListKey } from './dialog-list'
import { EffortMenu, type EffortMenuHandle } from './effort-menu'
import { markNewDialog } from './new-dialog-hint'
import { readPromptHistory, rememberPrompt } from './prompt-history'
import { useAttachments } from './use-attachments'
import { uuidv7 } from './uuid'
import { UsageWindowHint } from '@/components/billing/usage-window-hint'

/**
 * The screen a chat starts from (docs/plan/53-chat-preview-release.md, R9; docs/plan/61-chats-
 * first.md, К6). The first words start a chat: the browser invents its id, so a repeat of the
 * same request after a lost answer finds the same chat, and the screen moves to it. A chat has no
 * project (docs/plan/83-remove-projects.md): the server decides how the agent works. «Размышление» picks how hard the model thinks — the same menu changes it
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
  // The level chosen last in this browser (owner's request of 09.11.2026).
  const [effort, setEffort] = useRememberedEffort()
  const greeting = useGreeting(userName)
  const attachments = useAttachments()
  // One id per chat being started: a repeat after a lost answer lands on the same one.
  const pending = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const create = useMutation(trpc.task.create.mutationOptions())
  // The words kept for a new chat come back here.
  const [draft, setDraft] = useState<string | null>(null)
  // The requests this browser sent before: the arrows of the field bring them back (ВВ23).
  const [history, setHistory] = useState<readonly string[]>([])
  const wide = useMediaQuery(useTheme().breakpoints.up('md'))
  const shown = !beside || wide
  const field = useRef<HTMLTextAreaElement>(null)
  const effortMenu = useRef<EffortMenuHandle>(null)
  const clientCommands = useClientCommands({ anchor: field })
  // After the first paint: the server draws the field empty, and Strict Mode mounts this twice.
  useEffect(() => {
    if (!shown) return
    const later = setTimeout(() => {
      setDraft(takeChatDraft(userId))
      setHistory(readPromptHistory(userId))
    }, 0)
    return () => clearTimeout(later)
  }, [shown, userId])

  // The field takes the caret as the screen opens (owner's request of 15.11.2026, docs/plan/79, П4).
  useEffect(() => {
    if (shown) field.current?.focus({ preventScroll: true })
  }, [shown])

  async function start(text: string, attachmentIds: readonly string[]): Promise<boolean> {
    pending.current ??= uuidv7()
    setError(null)
    try {
      const created = await create.mutateAsync({
        taskId: pending.current,
        text,
        ...(attachmentIds.length > 0 ? { attachments: [...attachmentIds] } : {}),
        effort,
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
      setError(sendErrorText(failure))
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
        noSecrets={taskWayText.noSecrets}
        // The window of commands is here as in a chat: the page's own commands work, and of the
        // others it says that they work there.
        commands={{
          verdicts: [],
          onRun: (id) => {
            if (id === 'models') effortMenu.current?.open()
            else if (isPageCommand(id)) return clientCommands.run(id)
          },
          closedReason: composerText.commandsInDialog,
          // A chat has no site and no repository: none of their commands (К27).
          plain: true,
        }}
        fieldRef={field}
        restored={draft}
        history={history}
        speech={speech}
        effort={<EffortMenu value={effort} onChange={setEffort} handle={effortMenu} />}
      />
      <UsageWindowHint />
      {clientCommands.menu}
    </Box>
  )
}
