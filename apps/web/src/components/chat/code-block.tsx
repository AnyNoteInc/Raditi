'use client'

import Box from '@mui/material/Box'
import type { ReactNode } from 'react'

import { copyText } from './chat-texts'
import { CopyButton } from './copy-button'

// A block of code in an answer of the agent (docs/plan/91-chat-diagrams.md, Д6): a head with the
// name of its language and «Скопировать код», the code below, coloured by the page's palette.

/** The names people know a language by; another language is shown as its block names it. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  bash: 'Bash',
  sh: 'Shell',
  shell: 'Shell',
  zsh: 'Shell',
  powershell: 'PowerShell',
  ps1: 'PowerShell',
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TSX',
  json: 'JSON',
  html: 'HTML',
  xml: 'XML',
  svg: 'SVG',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  php: 'PHP',
  python: 'Python',
  py: 'Python',
  sql: 'SQL',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  ini: 'INI',
  go: 'Go',
  java: 'Java',
  kotlin: 'Kotlin',
  kt: 'Kotlin',
  c: 'C',
  cpp: 'C++',
  'c++': 'C++',
  csharp: 'C#',
  cs: 'C#',
  rust: 'Rust',
  rs: 'Rust',
  ruby: 'Ruby',
  rb: 'Ruby',
  swift: 'Swift',
  diff: 'Diff',
  patch: 'Diff',
  dockerfile: 'Dockerfile',
  docker: 'Dockerfile',
  nginx: 'nginx',
  markdown: 'Markdown',
  md: 'Markdown',
  graphql: 'GraphQL',
  mermaid: 'Mermaid',
  plantuml: 'PlantUML',
  puml: 'PlantUML',
  uml: 'PlantUML',
}

export function languageName(language: string): string {
  return LANGUAGE_NAMES[language.toLowerCase()] ?? language
}

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
        <Box sx={{ '& .MuiIconButton-root': { width: 36, height: 36 } }}>
          <CopyButton text={text.replace(/\n$/, '')} label={copyText.code} />
        </Box>
      </Box>
      <pre>{children ?? <code>{text}</code>}</pre>
    </Box>
  )
}
