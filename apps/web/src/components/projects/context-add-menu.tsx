'use client'

import { projectFileAcceptAttribute } from '@repo/domain/projects'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Drawer from '@mui/material/Drawer'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import MenuList from '@mui/material/MenuList'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'

import { contextText } from './project-texts'
import { chosenFiles, type ChosenFile } from './use-context-uploads'

/**
 * «Добавить контекст» and «Добавить» of «Контекст» (docs/plan/84-projects.md, §4.8; P-create-menu,
 * P-context-menu, P-phone-sheet): «Загрузить с устройства» with «Файлы…» and «Папку…», «Добавить
 * текстовое содержимое», and the repository's three ways: «Ссылка на GitHub» and «Подключить GitLab»
 * since slice 84.17, when the page gives them a handler, and «Подключить GitHub» — «Скоро» until the GitHub App is offered (84.25).
 * Under them — the bounds of the files. On a phone it is a sheet from the bottom, and «Загрузить с
 * устройства» opens the files at once.
 */
export function ContextAddMenu({
  onFiles,
  onText,
  variant,
  disabled = false,
  label,
  title,
  onLink,
  onGitlab,
  onGithub,
  repositoryAttached = false,
}: {
  onFiles: (files: ChosenFile[]) => void
  onText: () => void
  /** «Ссылка на GitHub» (ПР9); absent — «Скоро». */
  onLink?: () => void
  /** «Подключить GitLab» (ПР10); absent — «Скоро». */
  onGitlab?: () => void
  /** «Подключить GitHub» (ПР10, slice 84.25): only once the GitHub App is offered; absent — «Скоро». */
  onGithub?: () => void
  /**
   * The project has its repository already (ПР6: one a project): the ways of a repository say
   * how to change it instead of «Скоро» (ревью P1).
   */
  repositoryAttached?: boolean
  /** `pill` — «Добавить контекст» of the window of a new project; `text` — «Добавить» of a row. */
  variant: 'pill' | 'text'
  disabled?: boolean
  /** What the button says to a screen reader, when its words are short. */
  label?: string
  /** The words of the pill, if not «Добавить контекст». */
  title?: string
}) {
  const phone = useMediaQuery(useTheme().breakpoints.down('sm'))
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [device, setDevice] = useState<HTMLElement | null>(null)
  const filesInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const open = anchor !== null

  function close() {
    setDevice(null)
    setAnchor(null)
  }
  function pick(input: HTMLInputElement | null) {
    close()
    input?.click()
  }
  function text() {
    close()
    onText()
  }

  const inputs = (
    <>
      <input
        ref={filesInput}
        type="file"
        multiple
        hidden
        accept={projectFileAcceptAttribute}
        data-context-files=""
        onChange={(event) => {
          const list = event.currentTarget.files
          if (list && list.length > 0) onFiles(chosenFiles(list))
          event.currentTarget.value = ''
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        data-context-folder=""
        // A folder with its paths (ПР8): what the browser names `webkitRelativePath`.
        {...{ webkitdirectory: '' }}
        onChange={(event) => {
          const list = event.currentTarget.files
          if (list && list.length > 0) onFiles(chosenFiles(list))
          event.currentTarget.value = ''
        }}
      />
    </>
  )

  const trigger =
    variant === 'pill' ? (
      <Button
        variant="outlined"
        color="inherit"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => setAnchor(event.currentTarget)}
        startIcon={<AppIcon name="plus" size={18} />}
        sx={{
          minHeight: 44,
          flex: 'none',
          borderRadius: '999px',
          borderColor: 'divider',
          px: 2,
          fontWeight: 500,
        }}
      >
        {title ?? contextText.addContext}
      </Button>
    ) : (
      <Button
        size="small"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label ?? contextText.addLabel}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{ minHeight: 44 }}
      >
        {contextText.add}
      </Button>
    )

  const choose = (handler: (() => void) | undefined) =>
    handler
      ? () => {
          close()
          handler()
        }
      : undefined
  const taken = repositoryAttached ? contextText.oneRepository : undefined
  const repository: readonly {
    icon: AppIconName
    title: string
    hint: string
    onClick: (() => void) | undefined
    note: string | undefined
  }[] = [
    {
      icon: 'github',
      title: contextText.githubLink,
      hint: taken ?? contextText.githubLinkHint,
      onClick: taken ? undefined : choose(onLink),
      note: taken,
    },
    {
      icon: 'gitlab',
      title: contextText.gitlab,
      hint: taken ?? contextText.gitlabHint,
      onClick: taken ? undefined : choose(onGitlab),
      note: taken,
    },
    // The GitHub App (slice 84.25): «Скоро» until it is offered here.
    {
      icon: 'github',
      title: contextText.github,
      hint: onGithub ? (taken ?? contextText.githubHint) : contextText.githubHint,
      onClick: taken ? undefined : choose(onGithub),
      note: onGithub ? taken : undefined,
    },
  ]

  const limits = (
    <Typography sx={{ px: 2, pt: 1, pb: 1.5, fontSize: 12.5, color: 'text.secondary' }}>
      {contextText.limits}
    </Typography>
  )

  if (phone)
    return (
      <>
        {trigger}
        {inputs}
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
          <Typography id={titleId} sx={{ px: 2, pt: 2, pb: 0.5, fontWeight: 600 }}>
            {contextText.addTitle}
          </Typography>
          <MenuList autoFocusItem sx={{ py: 0.5 }}>
            <Row
              icon="upload"
              title={contextText.device}
              hint={contextText.deviceHint}
              onClick={() => pick(filesInput.current)}
            />
            <Row icon="text" title={contextText.text} hint={contextText.textHint} onClick={text} />
            {repository.map((item) => (
              <Row
                key={item.title}
                icon={item.icon}
                title={item.title}
                hint={item.hint}
                soon={item.onClick === undefined && item.note === undefined}
                disabled={item.onClick === undefined}
                {...(item.onClick ? { onClick: item.onClick } : {})}
              />
            ))}
          </MenuList>
          {limits}
        </Drawer>
      </>
    )

  function deviceKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setDevice(event.currentTarget)
    }
  }

  return (
    <>
      {trigger}
      {inputs}
      <Menu
        anchorEl={anchor}
        open={open}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: { sx: { width: 340, maxWidth: 'calc(100vw - 32px)', borderRadius: '14px' } },
          list: { 'aria-label': contextText.addTitle },
        }}
      >
        <MenuItem
          aria-haspopup="menu"
          aria-expanded={device !== null}
          onClick={(event) => setDevice(event.currentTarget)}
          onKeyDown={deviceKey}
          sx={{ minHeight: 44 }}
        >
          <ListItemIcon>
            <AppIcon name="upload" size={18} />
          </ListItemIcon>
          <ListItemText primary={contextText.device} />
          <Box component="span" sx={{ display: 'flex', color: 'text.secondary' }}>
            <AppIcon name="chevron" size={16} />
          </Box>
        </MenuItem>
        <Row icon="text" title={contextText.text} onClick={text} />
        {repository.map((item) => (
          <Row
            key={item.title}
            icon={item.icon}
            title={item.title}
            hint={item.hint}
            soon={item.onClick === undefined && item.note === undefined}
            disabled={item.onClick === undefined}
            {...(item.onClick ? { onClick: item.onClick } : {})}
          />
        ))}
        {limits}
      </Menu>
      <Menu
        anchorEl={device}
        open={device !== null}
        onClose={() => setDevice(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: { sx: { minWidth: 180, borderRadius: '14px' } },
          list: { 'aria-label': contextText.device },
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') setDevice(null)
        }}
      >
        <Row icon="file" title={contextText.files} onClick={() => pick(filesInput.current)} />
        <Row icon="folder" title={contextText.folder} onClick={() => pick(folderInput.current)} />
      </Menu>
    </>
  )
}

function Row({
  icon,
  title,
  hint,
  soon = false,
  disabled = soon,
  onClick,
}: {
  icon: AppIconName
  title: string
  hint?: string
  /** The repository's ways: not yet, shown so the client knows they will come. */
  soon?: boolean
  /** Not now, with the reason in its hint. */
  disabled?: boolean
  onClick?: () => void
}): ReactNode {
  return (
    <MenuItem disabled={disabled} onClick={onClick} sx={{ minHeight: 44, alignItems: 'center' }}>
      <ListItemIcon>
        <AppIcon name={icon} size={18} />
      </ListItemIcon>
      <ListItemText
        primary={title}
        secondary={hint}
        slotProps={{ secondary: { sx: { fontSize: 12.5 } } }}
      />
      {soon ? (
        <Box
          component="span"
          sx={{
            ml: 1,
            px: 1,
            py: 0.25,
            borderRadius: '999px',
            fontSize: 12,
            bgcolor: 'action.selected',
            color: 'text.secondary',
          }}
        >
          {contextText.soon}
        </Box>
      ) : null}
    </MenuItem>
  )
}
