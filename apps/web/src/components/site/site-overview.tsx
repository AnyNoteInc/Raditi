import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { fontFamilies } from '@repo/ui/theme/tokens'

import { statusLabels } from '@/components/projects/project-labels'
import { formatMoscowMoment } from '@/lib/moscow-date'

import { SectionTitle } from './section-empty'
import { Fact, Facts, SiteCard } from './site-cards'
import { closedSectionsNote, type SiteSetup } from './site-nav'

/** The first commit of the site repository, once `main` and its tag are on the remote. */
export type InitialVersion = { tag: string; commitSha: string; importedAt: Date }

type OverviewSite = {
  status: keyof typeof statusLabels
  state: 'free' | 'busy' | 'held'
  setup?: SiteSetup
  initialVersion?: InitialVersion | null
}

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

/**
 * A site whose files the wizard copied: what is saved and what is not there yet. The rest of the
 * connection — the access to WordPress and the deploys — is still being built.
 */
const IMPORTED_ONBOARDING_NOTE =
  'Файлы сайта сохранены, но агент пока не может менять сайт: остальную часть подключения мы ещё делаем.'

/** The saved first version: its tag and when it was saved, by the Moscow clock. */
function InitialVersionCard({ version }: { version: InitialVersion | null }) {
  return (
    <SiteCard
      title="Первоначальная версия сайта сохранена"
      note="Копия файлов сайта на момент подключения: с неё начнётся история его изменений."
    >
      {version ? (
        <Facts>
          <Fact name="Версия">
            <Box component="span" translate="no" sx={{ fontFamily: fontFamilies.mono }}>
              {version.tag}
            </Box>
          </Fact>
          <Fact name="Сохранена">
            <time dateTime={version.importedAt.toISOString()}>
              {formatMoscowMoment(version.importedAt)}
            </time>
          </Fact>
        </Facts>
      ) : (
        <Typography sx={{ px: { xs: 2, sm: 2.75 }, py: 2.25 }}>Файлы сайта скопированы.</Typography>
      )}
    </SiteCard>
  )
}

/** «Обзор» while it has only what the platform already knows: connection and whether it is busy. */
export function SiteOverview({ site }: { site: OverviewSite }) {
  const imported = site.setup === 'done' || Boolean(site.initialVersion)
  const note =
    imported && site.status === 'onboarding' ? IMPORTED_ONBOARDING_NOTE : statusNotes[site.status]
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
      {imported ? <InitialVersionCard version={site.initialVersion ?? null} /> : null}
      <SiteCard title="Что сейчас происходит">
        <Typography sx={{ px: { xs: 2, sm: 2.75 }, py: 2.25 }}>{stateNotes[site.state]}</Typography>
      </SiteCard>
    </Box>
  )
}
