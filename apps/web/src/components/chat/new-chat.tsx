'use client'

import Box from '@mui/material/Box'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import NextLink from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { UsageWindowHint } from '@/components/billing/usage-window-hint'
import { ProjectPicker, useProjectChoices } from '@/components/projects/project-picker'
import { projectHref, projectPickerText } from '@/components/projects/project-texts'
import { useArtifactMentions } from '@/components/artifacts/use-artifact-mentions'
import { useContextMentions } from '@/components/projects/use-context-mentions'
import {
  pickedOf,
  type PickedProject,
  type ProjectListItem,
} from '@/components/projects/project-types'

import { projectOfSearch, rememberProjectInAddress } from './chat-address'
import { takeChatDraft } from './chat-draft'
import { useRememberedEffort } from './chat-effort'
import { useGreeting } from './chat-greeting'
import { riseIn } from './chat-motion'
import { composerText, taskWayText } from './chat-texts'
import { isPageCommand, useClientCommands } from './client-commands'
import { Composer } from './composer'
import { EffortMenu, type EffortMenuHandle } from './effort-menu'
import { readPromptHistory } from './prompt-history'
import { useAttachments } from './use-attachments'
import { useSlashSkills } from './use-slash-skills'
import { useStartChat } from './use-start-chat'

/**
 * The screen a chat starts from (docs/plan/53-chat-preview-release.md, R9; docs/plan/61-chats-
 * first.md, К6). The first words start a chat: the browser invents its id, so a repeat of the
 * same request after a lost answer finds the same chat, and the screen moves to it. The pill of the
 * field chooses the project the chat starts in, «Без проекта» by default; `?project=<id>` and the
 * page of a project choose it at once (docs/plan/84-projects.md, ПР30), and the pill writes its
 * choice into `?project=<id>`, so a reload keeps it (owner's request of 19.11.2026). Changing it keeps the words
 * and the files of the field. «Размышление» picks how hard the model thinks — the same menu changes it
 * later in the chat. Beside the list at the root of the section (`beside`) the heading of the page
 * is the list's, so the screen takes the level below; below `md` that screen stands hidden on the
 * page, and it leaves the words kept for a new chat to the one the client will see.
 */
export function NewChat({
  userId,
  userName = null,
  beside = false,
  speech = false,
  projectId = null,
}: {
  userId: string
  /** The client's name: the greeting calls them by it (owner's request of 09.11.2026). */
  userName?: string | null
  beside?: boolean
  /** Dictation is set up here (docs/plan/75-chat-input-output.md, ВВ16). */
  speech?: boolean
  /** `?project=<id>`: the project chosen at once, when it is one of the user's (ПР30). */
  projectId?: string | null
}) {
  // The level chosen last in this browser (owner's request of 09.11.2026).
  const [effort, setEffort] = useRememberedEffort()
  const greeting = useGreeting(userName)
  const attachments = useAttachments()
  const { start: startChat, error, busy } = useStartChat({ userId, effort })
  // The project chosen by the pill; `undefined` — the one of the address, once the list says it.
  const [chosen, setChosen] = useState<PickedProject | null | undefined>(
    projectId === null ? null : undefined,
  )
  // The pill writes the address itself (ПИ6). An address it did not write — «Создать», a link with
  // `?project=` — starts the choice over from the address: Next keeps this screen mounted when only
  // the query of the address changes, so the choice would outlive it.
  const addressed = projectOfSearch(useSearchParams().get('project') ?? undefined)?.toLowerCase()
  const [seen, setSeen] = useState(addressed)
  if (addressed !== seen) {
    setSeen(addressed)
    if (addressed === undefined) setChosen(null)
    else if (chosen !== undefined && (chosen?.id ?? undefined) !== addressed) setChosen(undefined)
  }
  const { choices, loaded } = useProjectChoices(chosen === undefined)
  const project =
    chosen !== undefined
      ? chosen
      : projectOfAddress(addressed ?? projectId, loaded ? choices : null)
  // `@` names the files of the context of the chosen project (docs/plan/84-projects.md, ПР24).
  const contextMentions = useContextMentions(project?.id ?? null)
  // …and the artifacts of the client (docs/plan/88-artifacts.md, Ар47).
  const mentions = useArtifactMentions(contextMentions)
  // The words kept for a new chat come back here.
  const [draft, setDraft] = useState<string | null>(null)
  // The requests this browser sent before: the arrows of the field bring them back (ВВ23).
  const [history, setHistory] = useState<readonly string[]>([])
  const wide = useMediaQuery(useTheme().breakpoints.up('md'))
  const shown = !beside || wide
  const field = useRef<HTMLTextAreaElement>(null)
  const effortMenu = useRef<EffortMenuHandle>(null)
  const clientCommands = useClientCommands({ anchor: field })
  const slashSkills = useSlashSkills()
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

  const start = (text: string, attachmentIds: readonly string[]) =>
    startChat(text, attachmentIds, project?.id ?? null)

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
            overflowWrap: 'anywhere',
          }}
        >
          {project === null
            ? greeting
            : project.pending
              ? projectPickerText.headingLoading
              : projectPickerText.heading(project.name)}
        </Typography>
        {project?.goal ? (
          <Typography sx={{ mt: 1, color: 'text.secondary', fontSize: 15 }}>
            {project.goal}
          </Typography>
        ) : null}
      </Box>

      <Composer
        placeholder={project === null ? composerText.newPlaceholder : projectPickerText.placeholder}
        error={error}
        busy={busy}
        onSend={start}
        attachments={attachments}
        mentions={mentions}
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
          skills: slashSkills,
        }}
        fieldRef={field}
        restored={draft}
        history={history}
        speech={speech}
        project={
          <ProjectPicker
            value={project}
            onChange={(next) => {
              setChosen(next)
              rememberProjectInAddress(next?.id ?? null)
            }}
            disabled={busy}
          />
        }
        effort={<EffortMenu value={effort} onChange={setEffort} handle={effortMenu} />}
      />
      {project !== null ? (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ display: 'flex', flexWrap: 'wrap', gap: '0 12px', mt: -1.5, px: 1 }}
        >
          {project.pending ? null : projectPickerText.applies(project.hasInstructions)}
          <Link component={NextLink} href={projectHref(project.id)} sx={{ fontWeight: 500 }}>
            {projectPickerText.openProject}
          </Link>
        </Typography>
      ) : null}
      <UsageWindowHint />
      {clientCommands.menu}
    </Box>
  )
}

/**
 * The project the address chose (ПР30). Until the list of projects comes (`choices` null) the id
 * of the address stands, so words sent in that moment start the chat in it — the server decides
 * whose project it is. Once the list is read, a project that is not one of the user's live ones
 * is none.
 */
export function projectOfAddress(
  projectId: string | null,
  choices: readonly ProjectListItem[] | null,
): PickedProject | null {
  if (projectId === null) return null
  const id = projectId.toLowerCase()
  if (choices === null)
    return {
      id,
      name: projectPickerText.loading,
      goal: null,
      hasInstructions: false,
      pending: true,
    }
  const found = choices.find((each) => each.id === id)
  return found ? pickedOf(found) : null
}
