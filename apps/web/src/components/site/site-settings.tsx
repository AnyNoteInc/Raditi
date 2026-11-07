import Box from '@mui/material/Box'
import type { ReactNode } from 'react'

import { stackLabels } from '@/components/projects/project-labels'

import { sourceText } from './history-text'
import { SectionTitle } from './section-empty'
import { Fact, Facts, SiteCard } from './site-cards'

type SettingsSite = { name: string; host: string; stack: keyof typeof stackLabels }
type Source = Parameters<typeof sourceText>[0]

/**
 * «Сайт», a block of «Настройки»: what the site is and how its files reach Радити. The saved
 * accesses and their change are in «Переменные» (owner's request of 26.10.2026). `source` —
 * undefined when it could not be read. `nested` — a tab, under the h1 of the section.
 */
export function SiteSettings({
  site,
  source,
  nested = false,
}: {
  site: SettingsSite
  source?: Source
  nested?: boolean
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
      <SectionTitle level={nested ? 'h2' : 'h1'}>Сайт</SectionTitle>
      <SiteCard>
        <Facts>
          <Fact name="Название">{site.name}</Fact>
          <Fact name="Адрес">{site.host}</Fact>
          <Fact name="Платформа">{stackLabels[site.stack]}</Fact>
          {source === undefined ? null : (
            <Fact name="Как Радити получает файлы сайта">{sourceText(source)}</Fact>
          )}
        </Facts>
      </SiteCard>
    </Box>
  )
}

/** «Опасная область», a block of «Настройки»: its heading, and the card of «Удалить проект». */
export function DangerBlock({
  children,
  nested = false,
}: {
  children: ReactNode
  nested?: boolean
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
      <SectionTitle level={nested ? 'h2' : 'h1'}>Опасная область</SectionTitle>
      {children}
    </Box>
  )
}
