import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'

import { statusLabels } from '@/components/projects/project-labels'

import { SectionTitle } from './section-empty'
import { SiteCard } from './site-cards'
import { closedSectionsNote } from './site-nav'

type OverviewSite = { status: keyof typeof statusLabels; state: 'free' | 'busy' | 'held' }

/** What is going on at the site right now, by its state. */
const stateNotes: Readonly<Record<OverviewSite['state'], string>> = {
  free: 'Сейчас на сайте ничего не выполняется.',
  busy: 'На сайте идёт работа. Пока она не закончится, другие правки подождут.',
  held: 'Сайт временно закрыт для новых правок: мы проверяем, чем закончилась последняя операция.',
}

/** Why a site that is not working with the platform is in that state, in the owner's words. */
const statusNotes: Readonly<Partial<Record<OverviewSite['status'], string>>> = {
  onboarding:
    'Сайт добавлен, но ещё не подключён: агент пока не может его менять. Подключение из кабинета мы ещё делаем.',
  paused: 'Работа с сайтом приостановлена: новые правки не принимаются.',
  disconnected: 'Мы потеряли связь с сайтом, поэтому правки для него не принимаются.',
  archived: 'Сайт в архиве: правки для него не принимаются.',
}

/** «Обзор» while it has only what the platform already knows: connection and whether it is busy. */
export function SiteOverview({ site }: { site: OverviewSite }) {
  const note = statusNotes[site.status]
  // A paused, a disconnected and an archived site keep this section alone open.
  const closed = closedSectionsNote(site.status)
  return (
    <Box sx={{ maxWidth: 880, display: 'flex', flexDirection: 'column', gap: 2.25 }}>
      <SectionTitle>Обзор</SectionTitle>
      <SiteCard title="Подключение">
        <Box
          sx={{
            px: { xs: 2, sm: 2.75 },
            py: 2.25,
            display: 'flex',
            flexDirection: 'column',
            gap: 0.75,
          }}
        >
          <Typography sx={{ fontWeight: 600 }}>{statusLabels[site.status]}</Typography>
          {note ? <Typography color="text.secondary">{note}</Typography> : null}
          {closed ? <Typography color="text.secondary">{closed}</Typography> : null}
        </Box>
      </SiteCard>
      <SiteCard title="Что сейчас происходит">
        <Typography sx={{ px: { xs: 2, sm: 2.75 }, py: 2.25 }}>{stateNotes[site.state]}</Typography>
      </SiteCard>
    </Box>
  )
}
