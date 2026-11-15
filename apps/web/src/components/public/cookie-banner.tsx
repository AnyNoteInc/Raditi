'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Link from '@mui/material/Link'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useEffect, useState } from 'react'

import {
  COOKIE_CONSENT_CHANGE_EVENT,
  COOKIE_SETTINGS_OPEN_EVENT,
  cookieConsentAssignment,
  type CookieConsent,
} from '@/lib/cookie-consent'
import { legalDocumentHref } from '@/lib/legal'

/**
 * The notice about cookies on the first visit (privacy policy, section 9). It does not block the
 * page: necessary cookies work either way, the choice decides only analytics. The server opens it
 * when the request carries no choice, so it shows with the first paint and never flashes for a
 * visitor who has chosen; «Настройки cookie» opens it again to change or take back the choice.
 */
export function CookieBanner({ initiallyOpen }: { initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)

  useEffect(() => {
    const reopen = () => setOpen(true)
    window.addEventListener(COOKIE_SETTINGS_OPEN_EVENT, reopen)
    return () => window.removeEventListener(COOKIE_SETTINGS_OPEN_EVENT, reopen)
  }, [])

  if (!open) return null

  const choose = (analyticsAllowed: boolean) => {
    const now = new Date()
    document.cookie = cookieConsentAssignment(
      analyticsAllowed,
      now,
      window.location.protocol === 'https:',
    )
    const consent: CookieConsent = { analyticsAllowed, chosenAt: now }
    window.dispatchEvent(new CustomEvent(COOKIE_CONSENT_CHANGE_EVENT, { detail: consent }))
    setOpen(false)
  }

  return (
    <Paper
      role="region"
      aria-label="Файлы cookie"
      elevation={8}
      sx={(theme) => ({
        position: 'fixed',
        zIndex: theme.zIndex.snackbar,
        left: { xs: 16, sm: 24 },
        right: { xs: 16, sm: 24 },
        bottom: { xs: 16, sm: 24 },
        maxWidth: 760,
        mx: 'auto',
        p: { xs: 2, sm: 2.5 },
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
      })}
    >
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={2}
        sx={{ alignItems: { md: 'center' } }}
      >
        <Box sx={{ flex: 1 }}>
          <Typography variant="body2" sx={{ lineHeight: 1.55 }}>
            Мы используем файлы cookie. Необходимые нужны, чтобы сайт и&nbsp;вход в&nbsp;кабинет
            работали, — без них сайт не&nbsp;откроется. Аналитические помогают понять, как
            сайтом пользуются, и&nbsp;ставятся только с&nbsp;вашего согласия. Подробнее —
            в&nbsp;
            <Link href={legalDocumentHref('privacy-policy')} color="primary">
              Политике обработки персональных данных
            </Link>
            . Изменить выбор можно по&nbsp;ссылке «Настройки cookie» внизу главной страницы.
          </Typography>
        </Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ flexShrink: 0 }}>
          <Button variant="outlined" color="inherit" onClick={() => choose(false)}>
            Только необходимые
          </Button>
          <Button variant="contained" onClick={() => choose(true)}>
            Принять все
          </Button>
        </Stack>
      </Stack>
    </Paper>
  )
}

/** «Настройки cookie» in a footer: opens the banner again. */
export function CookieSettingsButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => window.dispatchEvent(new Event(COOKIE_SETTINGS_OPEN_EVENT))}
    >
      Настройки cookie
    </button>
  )
}
