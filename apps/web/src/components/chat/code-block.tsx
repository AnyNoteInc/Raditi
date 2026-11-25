'use client'

import Box from '@mui/material/Box'
import type { ReactNode } from 'react'

import { copyText } from './chat-texts'
import { CopyButton } from './copy-button'
import { languageName } from './code-languages'

// A block of code in an answer of the agent (docs/plan/91-chat-diagrams.md, Д6): a head with the
// name of its language and «Скопировать код», the code below, coloured by the page's palette.

/** The colours of the tokens: of the palette of the scheme, so both schemes keep their contrast. */
const TOKENS = {
  '& .hljs-keyword, & .hljs-selector-tag, & .hljs-built_in, & .hljs-meta': {
    color: 'var(--mui-palette-primary-main)',
  },
  '& .hljs-string, & .hljs-attr, & .hljs-template-variable': {
    color: 'var(--mui-palette-success-main)',
  },
  '& .hljs-number, & .hljs-literal, & .hljs-variable, & .hljs-symbol': {
    color: 'var(--mui-palette-warning-main)',
  },
  '& .hljs-title, & .hljs-name, & .hljs-selector-class, & .hljs-selector-id': {
    color: 'var(--mui-palette-secondary-main)',
  },
  '& .hljs-comment, & .hljs-quote': {
    color: 'var(--mui-palette-text-secondary)',
    fontStyle: 'italic',
  },
  '& .hljs-deletion': { color: 'var(--mui-palette-error-main)' },
} as const

export function CodeBlock({
  language,
  text,
  children,
}: {
  /** The language the block names; empty — none. */
  language: string
  /** The code as text, for «Скопировать код». */
  text: string
  /** The `<code>` as Markdown drew it, coloured; none — the text. */
  children?: ReactNode
}) {
  return (
    <Box
      data-code-block=""
      sx={{
        my: 1.5,
        borderRadius: '12px',
        overflow: 'hidden',
        bgcolor: 'var(--mui-palette-action-hover)',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          pl: 1.5,
          minHeight: 36,
          borderBottom: 1,
          borderColor: 'divider',
          color: 'text.secondary',
          fontSize: 12,
          fontFamily: 'var(--raditi-font-mono, ui-monospace, monospace)',
        }}
      >
        <span>{language ? languageName(language) : ''}</span>
        <CopyButton text={text.replace(/\n$/, '')} label={copyText.code} size={36} />
      </Box>
      <Box
        component="pre"
        sx={{
          m: 0,
          p: 1.5,
          overflowX: 'auto',
          fontSize: 14,
          lineHeight: 1.55,
          '& code': { fontFamily: 'var(--raditi-font-mono, ui-monospace, monospace)' },
          ...TOKENS,
        }}
      >
        {children ?? <code>{text}</code>}
      </Box>
    </Box>
  )
}
