import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { fontFamilies } from '@repo/ui/theme/tokens'

import { statusLabels } from '@/components/projects/project-labels'
import { formatMoscowMoment } from '@/lib/moscow-date'

import { SectionTitle } from './section-empty'
import { Fact, Facts, SiteCard } from './site-cards'
import { SiteLink } from './site-link'
import { runTitle, type RunView } from './history-text'
import { closedSectionsNote, siteHref, type SiteSetup } from './site-nav'
import { versionTitle, type VersionView } from './site-versions'

/** The first commit of the site repository, once `main` and its tag are on the remote. */
export type InitialVersion = { tag: string; commitSha: string; importedAt: Date }

type OverviewSite = {
  id?: string
  status: keyof typeof statusLabels
  state: 'free' | 'busy' | 'held'
  setup?: SiteSetup
  initialVersion?: InitialVersion | null
  /** What the site can be worked on with now (docs/plan/57-browser-tasks.md, Б9). */
  capabilities?: { repository: string; browser: string }
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

/** A site added without access to its files (docs/plan/57-browser-tasks.md, Б8). */
const BROWSER_ONLY_NOTE =
  'Сайт добавлен без доступа к файлам: агент работает в админке сайта через браузер. Начните задачу в разделе «Чат».'

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
  const browserOnly =
    site.status === 'onboarding' &&
    site.capabilities?.browser === 'ready' &&
    site.capabilities.repository === 'absent'
  const note = browserOnly
    ? BROWSER_ONLY_NOTE
    : imported && site.status === 'onboarding'
      ? IMPORTED_ONBOARDING_NOTE
      : statusNotes[site.status]
  // A paused, a disconnected and an archived site keep this section alone open.
  const closed = closedSectionsNote(site.status)
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
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
