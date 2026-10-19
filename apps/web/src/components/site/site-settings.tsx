import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import type { ReactNode } from 'react'

import { stackLabels } from '@/components/projects/project-labels'
import { formatMoscowMoment } from '@/lib/moscow-date'

import { SectionTitle } from './section-empty'
import { Fact, Facts, SiteCard } from './site-cards'
import { accessLabel } from './site-format'

type SettingsSite = { name: string; host: string; stack: keyof typeof stackLabels }
type Access = { kind: string; version: number; updatedAt: Date }

/**
 * «Настройки»: what the site is and which accesses are saved. Of an access the cabinet knows its
 * kind, version and date — the values live in the vault and never come back. `children` — the
 * sections below them (the client's variables of the site).
 */
export function SiteSettings({
  site,
  accesses,
  children,
}: {
  site: SettingsSite
  accesses: readonly Access[] | null
  children?: ReactNode
}) {
  return (
    <Box sx={{ maxWidth: 920, display: 'flex', flexDirection: 'column', gap: 2.25 }}>
      <SectionTitle>Настройки</SectionTitle>
      <SiteCard title="Сайт">
        <Facts>
          <Fact name="Название">{site.name}</Fact>
          <Fact name="Адрес">{site.host}</Fact>
          <Fact name="Платформа">{stackLabels[site.stack]}</Fact>
        </Facts>
      </SiteCard>
      <SiteCard
        title="Доступы"
        note="Пароли и ключи лежат в защищённом хранилище. Посмотреть их нельзя — ни вам, ни нам в этом кабинете. Здесь видно, какие доступы записаны и когда."
      >
        {accesses === null ? (
          <Typography role="alert" sx={{ px: { xs: 2, sm: 2.75 }, py: 2.25 }}>
            Не удалось загрузить список доступов. Обновите страницу через пару минут.
          </Typography>
        ) : accesses.length === 0 ? (
          <Typography color="text.secondary" sx={{ px: { xs: 2, sm: 2.75 }, py: 2.25 }}>
            Доступов пока нет. Они появятся, когда сайт будет подключён.
          </Typography>
        ) : (
          <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
            {accesses.map((access, index) => (
              <Box
                component="li"
                key={`${access.kind}-${index}`}
                sx={{
                  px: { xs: 2, sm: 2.75 },
                  py: 1.75,
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: '4px 24px',
                  borderTop: index === 0 ? 0 : 1,
                  borderColor: 'divider',
                }}
              >
                <Typography sx={{ fontWeight: 600 }}>{accessLabel(access.kind)}</Typography>
                <Typography variant="body2" color="text.secondary">
                  версия {access.version} · {formatMoscowMoment(access.updatedAt)} · значения скрыты
                </Typography>
              </Box>
            ))}
          </Box>
        )}
      </SiteCard>
      {children}
    </Box>
  )
}
