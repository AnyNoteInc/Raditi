'use client'

import { reasoningEfforts, type ReasoningEffort } from '@repo/domain/llm/model-class'
import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import { useId, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { effortText } from './chat-texts'

const hintOf: Readonly<Record<ReasoningEffort, string>> = {
  low: effortText.lowHint,
  high: effortText.highHint,
  max: effortText.maxHint,
}

/**
 * «Размышление»: how hard the model thinks (owner's requests of 26.10.2026) — a quiet button in
 * the row of the field with the level chosen, and a menu of the three under it. The same on a new
 * dialog and in one that goes on, where the level holds from the agent's next turn.
 */
export function EffortMenu({
  value,
  onChange,
  disabled = false,
}: {
  value: ReasoningEffort
  onChange: (effort: ReasoningEffort) => void
  disabled?: boolean
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const menuId = useId()
  const open = anchor !== null
  return (
    <>
      <ButtonBase
        aria-label={`${effortText.label}: ${effortText[value]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          // The pressing area of 44px on every width (DESIGN.md).
          minHeight: 44,
          px: 1.25,
          borderRadius: '999px',
          fontSize: 14,
          color: 'text.secondary',
          whiteSpace: 'nowrap',
          transition: 'background-color var(--raditi-motion-fast) var(--raditi-ease-out)',
          '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
          '&.Mui-focusVisible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2,
          },
          '&.Mui-disabled': { opacity: 0.5 },
        }}
      >
        {effortText[value]}
        <Box component="span" sx={{ display: 'inline-flex', transform: 'rotate(90deg)' }}>
          <AppIcon name="chevron" size={14} />
        </Box>
      </ButtonBase>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={open}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{
          paper: { sx: { borderRadius: '14px', minWidth: 260, mt: -1 } },
          list: { 'aria-label': effortText.label },
        }}
      >
        {reasoningEfforts.map((effort) => (
          <MenuItem
            key={effort}
            role="menuitemradio"
            aria-checked={effort === value}
            selected={effort === value}
            onClick={() => {
              setAnchor(null)
              if (effort !== value) onChange(effort)
            }}
            sx={{ gap: 1.5, py: 1, alignItems: 'flex-start' }}
          >
            <ListItemText
              primary={effortText[effort]}
              secondary={hintOf[effort]}
              slotProps={{
                primary: { sx: { fontSize: 14, fontWeight: 500 } },
                secondary: { sx: { fontSize: 13 } },
              }}
            />
            <Box
              component="span"
              aria-hidden="true"
              sx={{ mt: 0.25, visibility: effort === value ? 'visible' : 'hidden' }}
            >
              <AppIcon name="check" size={18} />
            </Box>
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}
