'use client'

import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import Link from 'next/link'
import { useId, useState, useTransition } from 'react'

import { signOut } from '@/app/(protected)/app/actions'
import { hardNavigate } from '@/lib/hard-navigate'

import { AppIcon } from './app-icon'
import { applicationUserName, UserAvatar, type ApplicationUser } from './user-avatar'

type Placement = 'toolbar' | 'sidebar' | 'panel'

/** Where the menu opens: below a toolbar avatar, beside a rail avatar, above a sidebar block. */
const menuPosition = {
  toolbar: {
    anchorOrigin: { vertical: 'bottom', horizontal: 'right' },
    transformOrigin: { vertical: 'top', horizontal: 'right' },
    mt: 1,
  },
  sidebar: {
    anchorOrigin: { vertical: 'top', horizontal: 'right' },
    transformOrigin: { vertical: 'bottom', horizontal: 'left' },
    mt: 0,
  },
  panel: {
    anchorOrigin: { vertical: 'top', horizontal: 'left' },
    transformOrigin: { vertical: 'bottom', horizontal: 'left' },
    mt: -1,
  },
} as const

/**
 * `toolbar` and `sidebar` show the avatar alone. `panel` is the block at the foot of an expanded
 * sidebar: the avatar with the name and the address. All three open the same menu.
 */
export function UserMenu({
  user,
  placement = 'toolbar',
}: {
  user: ApplicationUser
  placement?: Placement
}) {
  const id = useId()
  const name = applicationUserName(user) || 'Мой аккаунт'
  const panel = placement === 'panel'
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [pending, startTransition] = useTransition()
  const close = () => setAnchor(null)
  const leave = () =>
    startTransition(async () => {
      await signOut().catch(() => undefined)
      hardNavigate('/sign-in')
    })
  return (
    <>
      {/* The block already shows the name, so it needs no tooltip. */}
      <Tooltip title={panel ? '' : name} placement={placement === 'toolbar' ? 'bottom' : 'right'}>
        <IconButton
          id={`${id}-trigger`}
          aria-label={
            panel
              ? `Меню пользователя: ${name}, ${user.email}`
              : placement === 'sidebar'
                ? 'Меню пользователя в боковой панели'
                : 'Меню пользователя'
          }
          aria-haspopup="menu"
          aria-expanded={Boolean(anchor)}
          aria-controls={anchor ? `${id}-menu` : undefined}
          onClick={(event) => setAnchor(event.currentTarget)}
          sx={
            panel
              ? {
                  width: '100%',
                  minHeight: 52,
                  px: '7px',
                  // Two lines of text and this padding still fit the 44px of a rail.
                  py: 0.5,
                  gap: 1.25,
                  justifyContent: 'flex-start',
                  // A sidebar narrowed to a rail leaves room for the avatar only.
                  overflow: 'hidden',
                  borderRadius: '12px',
                  color: 'text.primary',
                  textAlign: 'left',
                }
              : { p: 0.75, borderRadius: 2, minWidth: 44, minHeight: 44 }
          }
        >
          <UserAvatar user={user} size={30} />
          {panel ? (
            <>
              <Box component="span" sx={{ flex: '1 1 0', minWidth: 0 }}>
                <Typography
                  component="span"
                  noWrap
                  variant="body2"
                  sx={{ display: 'block', fontWeight: 600, lineHeight: 1.3 }}
                >
                  {name}
                </Typography>
                <Typography
                  component="span"
                  noWrap
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', lineHeight: 1.3 }}
                >
                  {user.email}
                </Typography>
              </Box>
              <Box component="span" sx={{ display: 'flex', color: 'text.secondary' }}>
                <AppIcon name="expand" size={16} />
              </Box>
            </>
          ) : null}
        </IconButton>
      </Tooltip>
      <Menu
        id={`${id}-menu`}
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={close}
        anchorOrigin={menuPosition[placement].anchorOrigin}
        transformOrigin={menuPosition[placement].transformOrigin}
        slotProps={{
          list: { 'aria-labelledby': `${id}-trigger` },
          paper: {
            sx: {
              minWidth: 240,
              maxWidth: 'calc(100vw - 32px)',
              borderRadius: '12px',
              mt: menuPosition[placement].mt,
            },
          },
        }}
      >
        <Box sx={{ px: 2, py: 1, maxWidth: 300 }}>
          <Typography noWrap variant="body2" sx={{ fontWeight: 600 }}>
            {name}
          </Typography>
          <Typography noWrap variant="caption" color="text.secondary">
            {user.email}
          </Typography>
        </Box>
        <Divider />
        <MenuItem component={Link} href="/projects" onClick={close} sx={{ minHeight: 44 }}>
          <ListItemIcon>
            <AppIcon name="projects" size={18} />
          </ListItemIcon>
          <ListItemText>Проекты</ListItemText>
        </MenuItem>
        <MenuItem component={Link} href="/profile" onClick={close} sx={{ minHeight: 44 }}>
          <ListItemIcon>
            <AppIcon name="profile" size={18} />
          </ListItemIcon>
          <ListItemText>Профиль</ListItemText>
        </MenuItem>
        <MenuItem component={Link} href="/settings" onClick={close} sx={{ minHeight: 44 }}>
          <ListItemIcon>
            <AppIcon name="settings" size={18} />
          </ListItemIcon>
          <ListItemText>Настройки</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem onClick={leave} disabled={pending} sx={{ minHeight: 44 }}>
          <ListItemIcon>
            {pending ? (
              <CircularProgress size={18} color="inherit" />
            ) : (
              <AppIcon name="logout" size={18} />
            )}
          </ListItemIcon>
          <ListItemText>{pending ? 'Выходим…' : 'Выход'}</ListItemText>
        </MenuItem>
      </Menu>
    </>
  )
}
