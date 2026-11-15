'use client'

import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import { useEffect, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { copyText } from './chat-texts'

/**
 * «Скопировать текст» of a message of the chat — the client's words or the agent's answer (owner's
 * request of 14.11.2026). For a moment after the press it says «Скопировано» with a tick.
 */
export function CopyButton({ text, label = copyText.copy }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])
  const shown = copied ? copyText.copied : label
  return (
    <Tooltip title={shown}>
      <IconButton
        size="small"
        aria-label={shown}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(text)
            .then(() => setCopied(true))
            .catch(() => undefined)
        }}
        sx={{
          width: 36,
          height: 36,
          color: 'text.secondary',
          '&:hover': { color: 'text.primary' },
        }}
      >
        <AppIcon name={copied ? 'check' : 'copy'} size={16} />
      </IconButton>
    </Tooltip>
  )
}
