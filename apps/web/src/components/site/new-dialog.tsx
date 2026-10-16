import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'

import { AppIcon } from '@/components/application/app-icon'

/** A native control that stays in the accessibility tree and off the screen. */
const offScreen = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  m: '-1px',
  p: 0,
  border: 0,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
} as const

const MESSAGE = 'new-dialog-message'
const SEND_OFF = 'new-dialog-send-off'
const CHAT_OFF = 'new-dialog-chat-off'

/** One word of the mode switch: a native radio inside its label. */
function Mode({
  value,
  label,
  checked = false,
  describedBy,
}: {
  value: string
  label: string
  checked?: boolean
  /** Set on a mode that cannot be chosen: the id of the phrase that says why. */
  describedBy?: string
}) {
  const off = describedBy !== undefined
  return (
    <Box
      component="label"
      sx={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        minHeight: 44,
        px: 2.25,
        borderRadius: '999px',
        fontSize: 14,
        fontWeight: checked ? 600 : 400,
        color: checked ? 'background.paper' : 'text.secondary',
        bgcolor: checked ? 'text.primary' : 'transparent',
        cursor: off ? 'not-allowed' : 'pointer',
        '&:has(input:focus-visible)': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: '3px',
        },
      }}
    >
      <Box
        component="input"
        type="radio"
        name="mode"
        value={value}
        defaultChecked={checked}
        disabled={off}
        aria-describedby={describedBy}
        sx={offScreen}
      />
      {/* The clock, not the colour, says that the mode is yet to come. */}
      {off && <AppIcon name="clock" size={16} />}
      {label}
    </Box>
  )
}

/**
 * The screen a dialog starts from. Tasks from the cabinet are not accepted yet, so nothing on
 * it pretends to work: sending is off and the screen says why; the «Чат» mode is shown and
 * cannot be chosen. Beside the list at the root of the section the heading of the page is the
 * list's, so the screen takes the level below.
 */
export function NewDialog({ heading = 'h1' }: { heading?: 'h1' | 'h2' }) {
  return (
    <Box
      sx={{
        flex: '1 0 auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        // On a phone the field stays by the thumb; from `sm` the screen is centred.
        justifyContent: { xs: 'flex-end', sm: 'center' },
        pb: { sm: 4 },
      }}
    >
      <Box sx={{ width: '100%', maxWidth: 780, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography
          component={heading}
          sx={{ fontSize: 26, fontWeight: 600, lineHeight: 1.25, textAlign: 'center' }}
        >
          Новый диалог
        </Typography>

        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 0.5,
            p: 1,
            border: 1,
            // The edge of the field: the divider is too faint to mark a control.
            borderColor: 'var(--raditi-rule-strong)',
            borderRadius: '22px',
            bgcolor: 'background.default',
          }}
        >
          <Box component="label" htmlFor={MESSAGE} sx={offScreen}>
            Сообщение
          </Box>
          <Box
            component="textarea"
            id={MESSAGE}
            rows={2}
            placeholder="Что поменять на сайте?"
            aria-describedby={SEND_OFF}
            sx={{
              display: 'block',
              width: '100%',
              minHeight: 44,
              px: 1.5,
              py: 1.25,
              border: 0,
              borderRadius: '14px',
              resize: 'none',
              bgcolor: 'transparent',
              color: 'text.primary',
              font: 'inherit',
              '&::placeholder': { color: 'text.secondary', opacity: 1 },
            }}
          />
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Box
              role="radiogroup"
              aria-label="Режим диалога"
              sx={{
                display: 'flex',
                p: '3px',
                border: 1,
                borderColor: 'divider',
                borderRadius: '999px',
                bgcolor: 'background.paper',
              }}
            >
              <Mode value="chat" label="Чат" describedBy={CHAT_OFF} />
              <Mode value="work" label="Работа" checked />
            </Box>
            <IconButton
              disabled
              aria-label="Отправить"
              aria-describedby={SEND_OFF}
              sx={{ width: 44, height: 44, flex: 'none', border: 1, borderColor: 'divider' }}
            >
              <AppIcon name="send" />
            </IconButton>
          </Box>
        </Box>

        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
          <span id={SEND_OFF}>
            Задания из кабинета мы пока не принимаем — этот раздел ещё в работе.
          </span>{' '}
          <span id={CHAT_OFF}>Режим «Чат» появится позже.</span>
        </Typography>
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary', textAlign: 'center' }}>
          ИИ может допускать ошибки. Проверяйте важное.
        </Typography>
      </Box>
    </Box>
  )
}
