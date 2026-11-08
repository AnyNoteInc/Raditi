'use client'

import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { statusDotColors } from '@repo/ui/theme/tokens'
import { useState } from 'react'

import { stackLabels, statusLabels, type ProjectStack } from '@/components/projects/project-labels'

import {
  closedSectionsNote,
  isBrowserOnly,
  takesBrowserChat,
  type SiteChat,
  type SiteSetup,
} from './site-nav'

export type ConnectionSite = {
  status: keyof typeof statusLabels
  host?: string
  stack?: ProjectStack
  setup?: SiteSetup
  initialVersion?: unknown
  /** What the site can be worked on with now (docs/plan/57-browser-tasks.md, Б9). */
  capabilities?: { repository: string; browser: string }
  /** Whether the server takes a new chat of the project and what it works with. */
  chat?: SiteChat
}

/** Why a site that is not working with the platform is in that state, in the owner's words. */
const statusNotes: Readonly<Partial<Record<ConnectionSite['status'], string>>> = {
  onboarding:
    'Сайт добавлен, но ещё не подключён: агент пока не может его менять. Подключение из кабинета мы ещё делаем.',
  paused: 'Работа с сайтом приостановлена: новые правки не принимаются.',
  disconnected: 'Мы потеряли связь с сайтом, поэтому правки для него не принимаются.',
  archived: 'Сайт в архиве: правки для него не принимаются.',
}

/**
 * A site whose files the wizard copied: what is saved and what is not there yet. The rest of the
 * connection — the access to WordPress and the deploys — is still being built.
 */
const IMPORTED_ONBOARDING_NOTE =
  'Файлы сайта сохранены, но агент пока не может менять сайт: остальную часть подключения мы ещё делаем.'

/**
 * The same site when the server takes a chat of it in the browser (`chatRequirements`): the files
 * wait for the rest of the connection, the live site does not.
 */
const IMPORTED_BROWSER_NOTE =
  'Файлы сайта сохранены, но менять их агент пока не может: остальную часть подключения мы ещё делаем. В браузере, на живом сайте, агент может работать уже сейчас — выберите этот проект в новом чате.'

/** A site added without access to its files (docs/plan/57-browser-tasks.md, Б8). */
const NO_FILES_NOTE = 'Сайт добавлен без доступа к файлам. Выберите этот проект в новом чате.'

/** The hue of the dot; its words are in the name of the button and in the tooltip. */
const statusTones: Readonly<Record<ConnectionSite['status'], keyof typeof statusDotColors>> = {
  active: 'ok',
  onboarding: 'waiting',
  paused: 'waiting',
  disconnected: 'broken',
  archived: 'off',
}

const repositoryTexts: Readonly<Record<string, string>> = {
  ready: 'агент правит их в предпросмотре',
  inactive: 'правки сейчас не принимаются',
  absent: 'нет доступа',
  importing: 'копируем',
  failed: 'не удалось скопировать',
}

const browserTexts: Readonly<Record<string, string>> = {
  ready: 'доступна',
  not_configured: 'пока недоступна',
  closed: 'закрыта',
  insecure: 'сайт должен открываться по https://',
  unsupported: 'для этой платформы пока недоступна',
}

type ConnectionFact = { name: string; value: string; address?: boolean }

/** The phrases that say why the site is in its status and what that closes. */
function reasonsOf(site: ConnectionSite): string[] {
  const imported = site.setup === 'done' || Boolean(site.initialVersion)
  const note = isBrowserOnly(site)
    ? NO_FILES_NOTE
    : imported && site.status === 'onboarding'
      ? takesBrowserChat(site)
        ? IMPORTED_BROWSER_NOTE
        : IMPORTED_ONBOARDING_NOTE
      : statusNotes[site.status]
  // A paused, a disconnected and an archived site keep this section alone open.
  const closed = closedSectionsNote(site.status)
  return [note, closed].filter((phrase) => phrase !== undefined)
}

/** What the platform knows of the site and how the agent can reach it now. */
function factsOf(site: ConnectionSite): ConnectionFact[] {
  const facts: ConnectionFact[] = []
  if (site.host) facts.push({ name: 'Адрес', value: site.host, address: true })
  if (site.stack) facts.push({ name: 'Платформа', value: stackLabels[site.stack] })
  const { repository, browser } = site.capabilities ?? {}
  const files = repositoryTexts[repository ?? '']
  if (files) facts.push({ name: 'Файлы сайта', value: files })
  const inBrowser = browserTexts[browser ?? '']
  if (inBrowser) facts.push({ name: 'Работа через браузер', value: inBrowser })
  return facts
}

function ConnectionDetails({ site }: { site: ConnectionSite }) {
  const facts = factsOf(site)
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Typography component="span" sx={{ font: 'inherit', fontWeight: 600 }}>
        {statusLabels[site.status]}
      </Typography>
      {reasonsOf(site).map((reason) => (
        <Typography key={reason} component="span" sx={{ font: 'inherit' }}>
          {reason}
        </Typography>
      ))}
      {facts.length > 0 ? (
        <Box component="dl" sx={{ m: 0, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
          {facts.map((fact) => (
            <Box key={fact.name} sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 0.75 }}>
              <Box component="dt" sx={{ color: 'text.secondary' }}>
                {fact.name}:
              </Box>
              <Box
                component="dd"
                translate={fact.address ? 'no' : undefined}
                sx={{ m: 0, overflowWrap: 'anywhere' }}
              >
                {fact.value}
              </Box>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

/**
 * The connection of the site as a dot before the heading of «Обзор»: the colour at a glance, the
 * status and why in the tooltip. It is a button so that the keyboard and a touch reach the tooltip
 * too; the name carries the status, the colour alone says nothing. A tap comes as a click: Tooltip's
 * own touch listener loses a short one.
 */
export function SiteConnection({ site }: { site: ConnectionSite }) {
  const [open, setOpen] = useState(false)
  return (
    <Tooltip
      describeChild
      title={<ConnectionDetails site={site} />}
      placement="bottom-start"
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      disableTouchListener
      slotProps={{
        tooltip: {
          sx: {
            maxWidth: 340,
            p: 1.5,
            fontSize: 13,
            lineHeight: 1.45,
            bgcolor: 'background.paper',
            color: 'text.primary',
            border: 1,
            borderColor: 'divider',
            boxShadow: 3,
          },
        },
      }}
    >
      <IconButton
        aria-label={`Подключение: ${statusLabels[site.status]}`}
        onClick={() => setOpen((shown) => !shown)}
        sx={{
          width: { xs: 44, sm: 32 },
          height: { xs: 44, sm: 32 },
          my: { xs: -0.75, sm: 0 },
          // The dot itself stands on the left edge of the page; its target reaches past it.
          ml: { xs: '-16px', sm: '-10px' },
        }}
      >
        <Box
          component="span"
          data-tone={statusTones[site.status]}
          sx={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            bgcolor: statusDotColors[statusTones[site.status]],
          }}
        />
      </IconButton>
    </Tooltip>
  )
}
