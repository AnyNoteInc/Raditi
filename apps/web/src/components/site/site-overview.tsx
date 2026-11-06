import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { fontFamilies } from '@repo/ui/theme/tokens'

import { formatMoscowMoment } from '@/lib/moscow-date'

import { SectionTitle } from './section-empty'
import { Fact, Facts, SiteCard } from './site-cards'
import { SiteLink } from './site-link'
import { runTitle, type RunView } from './history-text'
import { SiteConnection, type ConnectionSite } from './site-connection'
import { siteHref } from './site-nav'
import { versionTitle, type VersionView } from './site-versions'

/** The first commit of the site repository, once `main` and its tag are on the remote. */
export type InitialVersion = { tag: string; commitSha: string; importedAt: Date }

type OverviewSite = ConnectionSite & {
  id?: string
  state: 'free' | 'busy' | 'held'
  initialVersion?: InitialVersion | null
}

/** What is going on at the site right now, by its state. */
const stateNotes: Readonly<Record<OverviewSite['state'], string>> = {
  free: 'Сейчас на сайте ничего не выполняется.',
  busy: 'На сайте идёт работа. Пока она не закончится, другие правки подождут.',
  held: 'Сайт временно закрыт для новых правок: мы проверяем, чем закончилась последняя операция.',
}

/** The saved first version: its tag and when it was saved, by the Moscow clock. */
function InitialVersionCard({
  version,
  siteId,
}: {
  version: InitialVersion | null
  siteId?: string
}) {
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
      {siteId ? <AllChanges siteId={siteId} /> : null}
    </SiteCard>
  )
}

function AllChanges({ siteId }: { siteId: string }) {
  return (
    <Box sx={{ px: { xs: 2, sm: 2.75 }, pb: 2.25 }}>
      <SiteLink href={siteHref(siteId, 'changes')}>Все изменения</SiteLink>
    </Box>
  )
}

/** «Сейчас на сайте»: the release installed last — what it was, when, and its version. */
function CurrentVersionCard({ siteId, version }: { siteId: string; version: VersionView }) {
  return (
    <SiteCard title="Сейчас на сайте">
      <Box
        sx={{
          px: { xs: 2, sm: 2.75 },
          py: 2.25,
          display: 'flex',
          flexDirection: 'column',
          gap: 0.75,
        }}
      >
        <Typography sx={{ fontWeight: 600, fontSize: 18 }}>{versionTitle(version)}</Typography>
        <Typography color="text.secondary">
          <time dateTime={version.installedAt.toISOString()}>
            {formatMoscowMoment(version.installedAt)}
          </time>
          {' · версия '}
          <Box component="span" translate="no" sx={{ fontFamily: fontFamilies.mono }}>
            {version.version}
          </Box>
        </Typography>
      </Box>
      <AllChanges siteId={siteId} />
    </SiteCard>
  )
}

/**
 * «Обзор»: what the platform knows — the connection, the version on the site, whether something
 * goes on and what was done last. `current` and `lastRun` — from the history of the site, when it
 * could be read.
 */
export function SiteOverview({
  site,
  current,
  lastRun,
}: {
  site: OverviewSite
  current?: VersionView | null
  lastRun?: RunView | null
}) {
  const imported = site.setup === 'done' || Boolean(site.initialVersion)
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <SiteConnection site={site} />
        <SectionTitle>Обзор</SectionTitle>
      </Box>
      {current && current.kind !== 'initial' && site.id ? (
        <CurrentVersionCard siteId={site.id} version={current} />
      ) : imported ? (
        <InitialVersionCard
          version={site.initialVersion ?? null}
          {...(site.id ? { siteId: site.id } : {})}
        />
      ) : null}
      <SiteCard title="Что сейчас происходит">
        <Box
          sx={{
            px: { xs: 2, sm: 2.75 },
            py: 2.25,
            display: 'flex',
            flexDirection: 'column',
            gap: 0.5,
          }}
        >
          <Typography>{stateNotes[site.state]}</Typography>
          {lastRun && site.id ? (
            <Typography variant="body2" color="text.secondary">
              Последняя работа — {formatMoscowMoment(lastRun.finishedAt ?? lastRun.startedAt)}:{' '}
              <SiteLink href={`${siteHref(site.id, 'runs')}/${lastRun.id}`}>
                запуск № {lastRun.number} «{runTitle(lastRun)}»
              </SiteLink>
            </Typography>
          ) : null}
        </Box>
      </SiteCard>
    </Box>
  )
}
