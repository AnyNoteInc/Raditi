'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import type { SxProps, Theme } from '@mui/material/styles'
import type { ReactNode } from 'react'

import { browserPushStateText, browserPushText, useBrowserPush } from './use-browser-push'

// «Включить в этом браузере» where a scheduled task shows up (docs/plan/82-scheduled-tasks.md,
// Зп36): its window and its card in the feed. One small control for both, on top of
// `useBrowserPush` — every control on a page reads the same state, so turning notifications on in
// one shows them on in the others.

export interface BrowserPushControlProps {
  /**
   * What the control shows when this browser already takes notifications: nothing (the default —
   * the place around it says enough) or the short line «Уведомления в этом браузере включены».
   */
  whenOn?: 'nothing' | 'line'
  /** Called after notifications were turned on here by this control. */
  onEnabled?: () => void
  /** Placement in the parent (margins, alignment); the control itself has none. */
  sx?: SxProps<Theme>
}

/**
 * The state of Web Push in this browser, in one line, or the button that turns it on:
 * - `loading` — nothing (no element), until the browser and the cabinet have answered;
 * - `on` — nothing (no element), or the line of `whenOn: 'line'`;
 * - `off` — the button «Включить в этом браузере»: it asks the browser's permission and subscribes,
 *   and a failure is told under it;
 * - `unsupported`, `denied`, `ios_install` — the text of Зп36, no button.
 * Changes are announced politely (`aria-live`).
 */
export function BrowserPushControl({ whenOn = 'nothing', onEnabled, sx }: BrowserPushControlProps) {
  const push = useBrowserPush()
  const stateText = browserPushStateText(push.state, push.device)

  let content: ReactNode = null
  if (push.state === 'on') {
    content =
      whenOn === 'line' ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {browserPushText.on}
        </Typography>
      ) : null
  } else if (push.state === 'off') {
    content = (
      <>
        <Button
          size="small"
          variant="outlined"
          disabled={push.working}
          onClick={() => {
            void push.enable().then((on) => {
              if (on) onEnabled?.()
            })
          }}
          sx={{ minHeight: 40, borderRadius: '20px', alignSelf: 'flex-start' }}
        >
          {browserPushText.enable}
        </Button>
        {push.problem ? (
          <Typography role="alert" variant="body2" sx={{ color: 'warning.main' }}>
            {push.problem}
          </Typography>
        ) : null}
      </>
    )
  } else if (stateText !== null) {
    content = (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {stateText}
      </Typography>
    )
  }

  if (content === null) return null
  return (
    <Box
      aria-live="polite"
      sx={[
        { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {content}
    </Box>
  )
}
