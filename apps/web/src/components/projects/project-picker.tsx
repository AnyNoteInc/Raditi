'use client'

import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Drawer from '@mui/material/Drawer'
import InputAdornment from '@mui/material/InputAdornment'
import ListItemText from '@mui/material/ListItemText'
import MenuItem from '@mui/material/MenuItem'
import MenuList from '@mui/material/MenuList'
import Popover from '@mui/material/Popover'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useQuery } from '@tanstack/react-query'
import { useId, useRef, useState, type KeyboardEvent } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { fieldControl } from '@/components/chat/composer'
import { useTRPC } from '@/trpc/client'

import { ProjectCreateDialog } from './project-create-dialog'
import { projectPickerText } from './project-texts'
import { pickedOf, type PickedProject, type ProjectListItem } from './project-types'

/**
 * The projects a chat can start in (docs/plan/84-projects.md, ПР30): those of «Все» — not in the
 * archive, not in the trash —, the starred first, each part latest activity first.
 */
export function useProjectChoices(enabled = true) {
  const trpc = useTRPC()
  const list = useQuery({ ...trpc.project.list.queryOptions({ view: 'all' }), enabled })
  const items = list.data?.items ?? []
  const choices = [...items.filter((p) => p.starred), ...items.filter((p) => !p.starred)]
  return { choices, loaded: list.isSuccess }
}

/** «Инструкции» or «Без инструкций»: what the agent will take from a project, for now. */
const detailsOf = (project: ProjectListItem) =>
  project.hasInstructions ? projectPickerText.instructions : projectPickerText.plain

/**
 * The pill of the project in the row of the field of «Новый чат» (ПР30; C-new-chat-menu,
 * C-phone-new-chat): «Без проекта» by default; its menu opens upwards — a search, «Без проекта»,
 * the projects with what will be taken, «Новый проект», which comes back with the new project
 * chosen. On a phone it is a sheet from the bottom. The field keeps its words and its files.
 */
export function ProjectPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: PickedProject | null
  onChange: (project: PickedProject | null) => void
  disabled?: boolean
}) {
  const phone = useMediaQuery(useTheme().breakpoints.down('sm'))
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [creating, setCreating] = useState(false)
  const open = anchor !== null
  const { choices, loaded } = useProjectChoices(open)
  const [query, setQuery] = useState('')
  const listId = useId()
  const titleId = useId()
  const list = useRef<HTMLUListElement>(null)
  const words = query.trim().toLocaleLowerCase('ru')
  const shown = choices.filter((project) => project.name.toLocaleLowerCase('ru').includes(words))

  function close() {
    setAnchor(null)
    setQuery('')
  }
  function choose(project: PickedProject | null) {
    close()
    onChange(project)
  }
  function searchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      list.current?.querySelector<HTMLElement>('[role="menuitemradio"], [role="menuitem"]')?.focus()
    }
  }

  const content = (
    <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <Typography id={titleId} sx={phone ? { px: 2, pt: 2, fontWeight: 600 } : offscreen}>
        {projectPickerText.label}
      </Typography>
      <Box sx={{ p: 1.5, pb: 0.5 }}>
        <TextField
          size="small"
          fullWidth
          autoFocus={!phone}
          placeholder={projectPickerText.search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={searchKey}
          slotProps={{
            htmlInput: { 'aria-label': projectPickerText.search, 'aria-controls': listId },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <AppIcon name="search" size={16} />
                </InputAdornment>
              ),
            },
          }}
        />
      </Box>
      <MenuList
        ref={list}
        id={listId}
        aria-labelledby={titleId}
        sx={{ maxHeight: { xs: '55dvh', sm: 360 }, overflowY: 'auto', py: 0.5 }}
      >
        {words === '' ? (
          <MenuItem
            role="menuitemradio"
            aria-checked={value === null}
            selected={value === null}
            onClick={() => choose(null)}
            sx={itemSx}
          >
            <ListItemText
              primary={projectPickerText.none}
              secondary={projectPickerText.noneHint}
              slotProps={textSlots}
            />
            <Check on={value === null} />
          </MenuItem>
        ) : null}
        {shown.length > 0 ? (
          <Typography
            component="li"
            role="presentation"
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', px: 2, pt: 1, pb: 0.5, fontWeight: 500 }}
          >
            {projectPickerText.projects}
          </Typography>
        ) : null}
        {shown.map((project) => (
          <MenuItem
            key={project.id}
            role="menuitemradio"
            aria-checked={value?.id === project.id}
            selected={value?.id === project.id}
            onClick={() => choose(pickedOf(project))}
            sx={itemSx}
          >
            <Box component="span" sx={{ display: 'flex', color: 'text.secondary', mt: 0.25 }}>
              <AppIcon name="projects" size={18} />
            </Box>
            <ListItemText
              primary={
                <>
                  {project.name}
                  {project.starred ? (
                    <Box
                      component="span"
                      sx={{ ml: 0.75, color: 'primary.main', display: 'inline-flex' }}
                    >
                      <AppIcon name="star" size={13} filled />
                      <Box component="span" sx={offscreen}>
                        , {projectPickerText.starred}
                      </Box>
                    </Box>
                  ) : null}
                </>
              }
              secondary={detailsOf(project)}
              slotProps={textSlots}
            />
            <Check on={value?.id === project.id} />
          </MenuItem>
        ))}
        {loaded && words !== '' && shown.length === 0 ? (
          <Typography
            component="li"
            role="presentation"
            sx={{ px: 2, py: 1, fontSize: 14, color: 'text.secondary' }}
          >
            {projectPickerText.nothingFound}
          </Typography>
        ) : null}
        <MenuItem
          onClick={() => {
            close()
            setCreating(true)
          }}
          sx={{ ...itemSx, borderTop: 1, borderColor: 'divider', mt: 0.5 }}
        >
          <Box component="span" sx={{ display: 'flex', color: 'text.secondary', mt: 0.25 }}>
            <AppIcon name="plus" size={18} />
          </Box>
          <ListItemText primary={projectPickerText.newProject} slotProps={textSlots} />
        </MenuItem>
      </MenuList>
    </Box>
  )

  return (
    <>
      <ButtonBase
        aria-label={value === null ? projectPickerText.none : projectPickerText.pill(value.name)}
        aria-haspopup={phone ? 'dialog' : 'menu'}
        aria-expanded={open}
        disabled={disabled}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{
          ...fieldControl(value === null ? 'transparent' : 'var(--mui-palette-action-selected)'),
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.75,
          pl: 0.875,
          pr: 1,
          maxWidth: { xs: 160, sm: 220 },
          borderRadius: '999px',
          fontSize: 13,
          color: value === null ? 'text.secondary' : 'text.primary',
          whiteSpace: 'nowrap',
          '&:hover': { bgcolor: 'transparent', color: 'text.primary' },
          '&:hover::before': { bgcolor: 'action.hover' },
          '&.Mui-disabled': { opacity: 0.5 },
        }}
      >
        <AppIcon name="projects" size={17} />
        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {value === null ? projectPickerText.none : value.name}
        </Box>
        <AppIcon name="down" size={14} />
      </ButtonBase>
      {phone ? (
        <Drawer
          anchor="bottom"
          open={open}
          onClose={close}
          slotProps={{
            paper: {
              role: 'dialog',
              'aria-labelledby': titleId,
              sx: {
                borderTopLeftRadius: 18,
                borderTopRightRadius: 18,
                pb: 'env(safe-area-inset-bottom)',
              },
            },
          }}
        >
          {content}
        </Drawer>
      ) : (
        <Popover
          open={open}
          anchorEl={anchor}
          onClose={close}
          anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
          transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          slotProps={{ paper: { sx: { borderRadius: '14px', width: 340, mt: -1 } } }}
        >
          {content}
        </Popover>
      )}
      <ProjectCreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(project) => {
          setCreating(false)
          onChange(project)
        }}
      />
    </>
  )
}

function Check({ on }: { on: boolean }) {
  return (
    <Box
      component="span"
      aria-hidden="true"
      sx={{ ml: 'auto', mt: 0.25, pl: 1, visibility: on ? 'visible' : 'hidden' }}
    >
      <AppIcon name="check" size={18} />
    </Box>
  )
}

const itemSx = { gap: 1.5, py: 1, minHeight: { xs: 44 }, alignItems: 'flex-start' } as const
const textSlots = {
  primary: { sx: { fontSize: 14, fontWeight: 500, overflowWrap: 'anywhere' } },
  secondary: { sx: { fontSize: 13 } },
} as const
const offscreen = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  m: '-1px',
  p: 0,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
} as const
