'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import type { SxProps, Theme } from '@mui/material/styles'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { browserPushStateText, browserPushText, useBrowserPush } from './use-browser-push'

// «Включить в этом браузере» where a scheduled task shows up (docs/plan/82-scheduled-tasks.md,
// Зп36): its window and its card in the feed. One small control for both, on top of
// `useBrowserPush` — every control on a page reads the same state, so turning notifications on in
// one shows them on in the others.

export interface BrowserPushControlProps {
  /**
   * What the control shows when this browser already takes notifications: nothing (the default —
   * the place around it says enough) or the short line «Уведомления в этом браузере включены».
   * Once the client pressed the button of this control, the line is shown either way.
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
 * - `on` — nothing (no element), or the line of `whenOn: 'line'`; after a press of the button here
 *   — the line, in the same live region, so the change is announced;
 * - `off` — the button «Включить в этом браузере»: it asks the browser's permission and subscribes,
 *   and a failure is told under it;
 * - `unsupported`, `denied`, `ios_install` — the text of Зп36, no button.
 * Changes are announced politely (`aria-live`). When a press is answered the button goes, and the
 * focus it had moves to the line in its place, unless the client moved it elsewhere meanwhile.
 */
export function BrowserPushControl({ whenOn = 'nothing', onEnabled, sx }: BrowserPushControlProps) {
  const push = useBrowserPush()
  const stateText = browserPushStateText(push.state, push.device)
  // The client pressed the button here: from now on this control answers in its place.
  const [pressed, setPressed] = useState(false)
  const lineRef = useRef<HTMLElement>(null)
  const answered = pressed && push.state !== 'off' && push.state !== 'loading'

  useEffect(() => {
    const line = lineRef.current
    if (!answered || line === null) return
    // The button under the focus is gone: the focus fell to the page or to the dialog around it.
    const focus = document.activeElement
    if (focus === null || focus === document.body || focus.contains(line)) line.focus()
  }, [answered])

  const line = (text: string) => (
    <Typography ref={lineRef} tabIndex={-1} variant="body2" sx={{ color: 'text.secondary' }}>
      {text}
    </Typography>
  )

  let content: ReactNode = null
  if (push.state === 'on') {
    content = whenOn === 'line' || pressed ? line(browserPushText.on) : null
  } else if (push.state === 'off') {
    content = (
      <>
        <Button
          size="small"
          variant="outlined"
          disabled={push.working}
          onClick={() => {
            setPressed(true)
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
    content = line(stateText)
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
