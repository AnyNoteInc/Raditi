'use client'

import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Divider from '@mui/material/Divider'
import Drawer from '@mui/material/Drawer'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import MenuList from '@mui/material/MenuList'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import Link from 'next/link'
import { useId, useState, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { chatsText, taskWayText } from './chat-texts'
import type { ProjectListItem } from './chat-types'
import { fieldControl, offScreen } from './composer'
import { ProjectMark } from './project-mark'

/** Why a project cannot be chosen, or what the client should know of it; null — its address. */
const noteOfState: Readonly<Record<ProjectListItem['chat']['state'], string | null>> = {
  ready: null,
  importing: chatsText.importingProject,
  import_failed: chatsText.importFailedProject,
  closed: chatsText.closedProject,
  insecure: taskWayText.insecure,
  unavailable: chatsText.unavailableProject,
}

/** Whether a new chat can start on this project: the server gave it requirements. */
export const projectChoosable = (project: ProjectListItem) => project.chat.requirements !== null

/** The wizard that comes back to a new chat (docs/plan/61-chats-first.md, §5.11). */
const ADD_PROJECT_HREF = '/projects/new?from=chats'

/** One line of the choice: a mark, a name and what is said of it under the name. */
function Choice({ mark, name, note }: { mark: ReactNode; name: string; note?: string | null }) {
  return (
    <>
      {mark}
      <Box component="span" sx={{ flex: '1 1 auto', minWidth: 0 }}>
        <Box
          component="span"
          sx={{
            display: 'block',
            fontSize: 15,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {name}
        </Box>
        {note ? (
          <Box
            component="span"
            sx={{
              display: 'block',
              fontSize: 13,
              lineHeight: 1.4,
              color: 'text.secondary',
              whiteSpace: 'normal',
            }}
          >
            {note}
          </Box>
        ) : null}
      </Box>
    </>
  )
}

const itemSx = {
  // MUI lets the height of an item go from `sm` up: a value by breakpoint keeps it for a finger.
  minHeight: { xs: 52 },
  gap: 1.5,
  px: 1.25,
  py: 0.75,
  borderRadius: '12px',
  '&.Mui-disabled': { opacity: 1 },
} as const

/**
 * The project of a new chat (docs/plan/61-chats-first.md, К6, К9): a pill at the field, and under
 * it «Без проекта», the projects and «Добавить проект». A menu on a computer, a sheet from the
 * bottom on a phone. «Без проекта» is there before the list is, and when it could not be read.
 * While files are attached the pill is locked: a file is bound to the site it was sent for.
 */
export function ProjectPicker({
  projects,
  value,
  locked,
  onChange,
  onAddProject,
}: {
  /** The list as far as it is known: nothing while it loads or when it failed. */
  projects: readonly ProjectListItem[]
  /** The chosen project; null — «Без проекта». */
  value: ProjectListItem | null
  locked: boolean
  onChange: (project: ProjectListItem | null) => void
  /** Called as the client leaves for the wizard, with time to keep what was written. */
  onAddProject: () => void
}) {
  const theme = useTheme()
  const sheet = useMediaQuery(theme.breakpoints.down('sm'))
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const titleId = useId()
  const lockedId = useId()
  const open = anchor !== null
  const close = () => setAnchor(null)
  const choose = (project: ProjectListItem | null) => {
    close()
    // Said even of what is shown: an address may still move a pill the client has not touched.
    onChange(project)
  }
  const shownName = value?.name ?? chatsText.noProject
  const shownMark = value ? <ProjectMark name={value.name} size={18} /> : null

  const pillBody = (
    <>
      {shownMark}
      <Box
        component="span"
        sx={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {shownName}
      </Box>
    </>
  )
  const pillSx = {
    ...fieldControl(),
    display: 'inline-flex',
    alignItems: 'center',
    gap: 0.75,
    minWidth: 0,
    maxWidth: 240,
    pl: 1.25,
    pr: 1,
    fontSize: 13,
    color: 'text.primary',
    whiteSpace: 'nowrap',
    '&::before': {
      content: '""',
      position: 'absolute',
      zIndex: -1,
      inset: '6px 0',
      borderRadius: '999px',
      boxShadow: 'inset 0 0 0 1px var(--mui-palette-divider)',
    },
  } as const

  if (locked) {
    return (
      <>
        <ButtonBase
          aria-disabled="true"
          aria-describedby={lockedId}
          title={chatsText.lockedProject}
          disableRipple
          sx={{ ...pillSx, pr: 1.25, cursor: 'default' }}
        >
          {pillBody}
        </ButtonBase>
        <Box id={lockedId} sx={offScreen}>
          {chatsText.lockedProject}
        </Box>
      </>
    )
  }

  const items = [
    <MenuItem key="none" selected={value === null} onClick={() => choose(null)} sx={itemSx}>
      <Choice
        mark={<ProjectMark sign={<AppIcon name="chat" size={15} />} size={28} />}
        name={chatsText.noProject}
      />
      {value === null ? <AppIcon name="check" size={18} /> : null}
    </MenuItem>,
    <Divider key="after-none" component="li" sx={{ my: 0.75 }} />,
    ...projects.map((project) => {
      const note = noteOfState[project.chat.state]
      return (
        <MenuItem
          key={project.id}
          selected={project.id === value?.id}
          disabled={!projectChoosable(project)}
          onClick={() => choose(project)}
          sx={itemSx}
        >
          <Choice
            mark={<ProjectMark name={project.name} size={28} />}
            name={project.name}
            note={note ?? project.host}
          />
          {project.id === value?.id ? <AppIcon name="check" size={18} /> : null}
        </MenuItem>
      )
    }),
    ...(projects.length > 0
      ? [<Divider key="after-projects" component="li" sx={{ my: 0.75 }} />]
      : []),
    <MenuItem
      key="add"
      component={Link}
      href={ADD_PROJECT_HREF}
      onClick={() => {
        close()
        onAddProject()
      }}
      sx={itemSx}
    >
      <Choice
        mark={<ProjectMark sign={<AppIcon name="plus" size={16} />} size={28} />}
        name={chatsText.addProject}
      />
    </MenuItem>,
  ]

  return (
    <>
      <ButtonBase
        aria-label={`${chatsText.pickerTitle}: ${shownName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{ ...pillSx, '&:hover::before': { bgcolor: 'action.hover' } }}
      >
        {pillBody}
        <AppIcon name="down" size={14} />
      </ButtonBase>
      {sheet ? (
        <Drawer
          anchor="bottom"
          open={open}
          onClose={close}
          slotProps={{
            paper: {
              'aria-labelledby': titleId,
              sx: {
                px: 1.5,
                pt: 1.5,
                pb: 'max(24px, env(safe-area-inset-bottom))',
                borderRadius: '20px 20px 0 0',
                maxHeight: '80dvh',
              },
            },
          }}
        >
          <Typography id={titleId} sx={{ px: 1, pb: 1, fontSize: 15, fontWeight: 500 }}>
            {chatsText.pickerTitle}
          </Typography>
          <MenuList aria-labelledby={titleId} autoFocusItem={open} disablePadding>
            {items}
          </MenuList>
        </Drawer>
      ) : (
        <Menu
          anchorEl={anchor}
          open={open}
          onClose={close}
          anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
          transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          slotProps={{
            paper: {
              sx: { width: 360, maxWidth: 'calc(100vw - 32px)', borderRadius: '18px', mt: -1 },
            },
            list: { 'aria-label': chatsText.pickerTitle, sx: { p: 1.5 } },
          }}
        >
          {items}
        </Menu>
      )}
    </>
  )
}
