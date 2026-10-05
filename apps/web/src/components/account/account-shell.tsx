'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import { BrandMark } from '@repo/ui/components'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { applicationSurface } from '@/components/application/application-surface'
import type { ApplicationUser } from '@/components/application/user-avatar'
import { UserMenu } from '@/components/application/user-menu'

/** Personal pages have a shared header and a centered reading width. */
export function AccountShell({ user, children }: { user: ApplicationUser; children: ReactNode }) {
  return (
    <Box sx={{ ...applicationSurface, bgcolor: 'background.default' }}>
      <Box
        component="a"
        href="#account-content"
        sx={{
          position: 'fixed',
          top: -100,
          left: 20,
          zIndex: 1500,
          p: 1.5,
          bgcolor: 'background.paper',
          color: 'text.primary',
          '&:focus': { top: 8 },
        }}
      >
        Перейти к содержимому
      </Box>
      <Box
        component="header"
        aria-label="Панель аккаунта"
        sx={{ bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}
      >
        <Box
          sx={{
            maxWidth: 1200,
            mx: 'auto',
            px: { xs: 2.5, sm: 4 },
            height: 72,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
          }}
        >
          <Box
            component={Link}
            href="/"
            aria-label="Радити — главная страница"
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 44,
              borderRadius: 1,
              textDecoration: 'none',
            }}
          >
            <BrandMark size={30} />
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 1, sm: 2 } }}>
            <Button
              href="/projects"
              color="inherit"
              aria-label="К проектам"
              startIcon={<AppIcon name="back" size={18} />}
              sx={{
                minWidth: { xs: 44, sm: 'auto' },
                px: { xs: 1.5, sm: 2 },
                color: 'text.secondary',
                '& .MuiButton-startIcon': { mr: { xs: 0, sm: 1 }, ml: 0 },
              }}
            >
              <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                К проектам
              </Box>
            </Button>
            <UserMenu user={user} />
          </Box>
        </Box>
      </Box>
      <Box
        component="main"
        id="account-content"
        tabIndex={-1}
        sx={{
          maxWidth: 864,
          mx: 'auto',
          px: { xs: 2.5, sm: 4 },
          pt: { xs: 4, sm: 5 },
          pb: { xs: 6, sm: 10 },
          outline: 'none',
        }}
      >
        {children}
      </Box>
    </Box>
  )
}
