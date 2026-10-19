'use client'

import Alert from '@mui/material/Alert'
import AlertTitle from '@mui/material/AlertTitle'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { fontFamilies } from '@repo/ui/theme/tokens'
import type { ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'

// What a check of the access may stop at: a key of the server to compare, or a refusal.

/** The key the server presented and whether one was confirmed before. */
export interface HostKeyPrompt {
  kind: 'unknown' | 'changed'
  hostKey: string
}

/** A fingerprint is one long word: it wraps anywhere, in a fixed-width face, and can be selected. */
function Fingerprint({ value }: { value: string }) {
  return (
    <Box
      component="code"
      translate="no"
      sx={{
        display: 'block',
        mt: 1.5,
        px: 1.5,
        py: 1.25,
        borderRadius: '10px',
        bgcolor: 'action.hover',
        color: 'text.primary',
        fontFamily: fontFamilies.mono,
        fontSize: 13,
        lineHeight: 1.6,
        overflowWrap: 'anywhere',
        wordBreak: 'break-all',
        userSelect: 'all',
      }}
    >
      {value}
    </Box>
  )
}

/**
 * The key of an SSH server before anything is sent to it. `unknown` — the first check: compare
 * it with the hosting panel and confirm. `changed` — not the key confirmed before: a server that
 * moved looks so, and so does someone in between; it is taken only by its own explicit button.
 */
export function HostKeyPanel({
  titleId,
  prompt,
  onAccept,
  disabled,
}: {
  /** The heading of the panel: the focus moves to it when the panel appears. */
  titleId: string
  prompt: HostKeyPrompt
  onAccept: () => void
  disabled: boolean
}) {
  const changed = prompt.kind === 'changed'
  return (
    <Box
      component="section"
      aria-labelledby={titleId}
      sx={{
        p: { xs: 2, sm: 2.5 },
        border: 1,
        borderColor: changed ? 'warning.main' : 'divider',
        borderRadius: '14px',
        bgcolor: 'background.paper',
      }}
    >
      <Box sx={{ display: 'flex', gap: 1.25, alignItems: 'flex-start' }}>
        <Box
          sx={{
            color: changed ? 'warning.main' : 'primary.main',
            display: 'flex',
            mt: '2px',
          }}
        >
          <AppIcon name={changed ? 'warning' : 'key'} size={22} />
        </Box>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography
            id={titleId}
            component="h3"
            tabIndex={-1}
            sx={{ fontSize: 16, fontWeight: 600, outline: 'none' }}
          >
            {changed ? 'Ключ сервера изменился' : 'Сверьте ключ сервера'}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, lineHeight: 1.6 }}>
            {changed
              ? 'Сервер назвал не тот ключ, который вы подтвердили раньше. Так бывает после переезда или переустановки сервера — но так же выглядит и подмена. Сверьте новый отпечаток с панелью хостинга или узнайте его у поддержки хостинга и принимайте, только если они совпадают.'
              : 'Так сервер подтверждает, что он — ваш. Сравните этот отпечаток с отпечатком ключа в панели хостинга или узнайте его у поддержки хостинга. Пока вы не подтвердите ключ, мы не отправим серверу ни пользователя, ни пароль.'}
          </Typography>
          <Fingerprint value={prompt.hostKey} />
          <Button
            variant={changed ? 'outlined' : 'contained'}
            color={changed ? 'warning' : 'primary'}
            onClick={onAccept}
            disabled={disabled}
            sx={{ mt: 2, width: { xs: '100%', sm: 'auto' } }}
          >
            {changed ? 'Принять новый ключ' : 'Ключ совпадает, продолжить'}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}

/**
 * Why a check did not pass, with the one fix the server can name: the folder one level down
 * that holds the site. `children` are the ways on of a refusal no field can cure.
 */
export function CheckProblem({
  id,
  text,
  suggestedRoot,
  onUseRoot,
  disabled,
  children,
}: {
  /** The focus moves to the message when it appears. */
  id: string
  text: string
  suggestedRoot?: string
  onUseRoot?: (root: string) => void
  disabled: boolean
  children?: ReactNode
}) {
  return (
    <Alert
      id={id}
      severity="error"
      tabIndex={-1}
      sx={{
        overflowWrap: 'anywhere',
        outline: 'none',
        '&:focus-visible': { outline: '2px solid' },
      }}
    >
      {suggestedRoot ? <AlertTitle sx={{ fontWeight: 600 }}>{text}</AlertTitle> : text}
      {suggestedRoot && onUseRoot ? (
        <>
          <Box component="span" sx={{ display: 'block' }}>
            Похоже, сайт лежит в папке{' '}
            <Box component="code" translate="no" sx={{ fontFamily: fontFamilies.mono }}>
              {suggestedRoot}
            </Box>
            .
          </Box>
          <Button
            color="inherit"
            variant="outlined"
            onClick={() => onUseRoot(suggestedRoot)}
            disabled={disabled}
            sx={{ mt: 1.5, maxWidth: '100%', whiteSpace: 'normal', textAlign: 'left' }}
          >
            Подставить папку «{suggestedRoot}»
          </Button>
        </>
      ) : null}
      {children}
    </Alert>
  )
}
