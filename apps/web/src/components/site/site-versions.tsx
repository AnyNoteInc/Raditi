import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { fontFamilies } from '@repo/ui/theme/tokens'

import { formatMoscowDay, formatMoscowMoment } from '@/lib/moscow-date'

import type { HistoryItem } from './history-list'
import { SectionTitle } from './section-empty'
import { Fact, Facts, SiteCard } from './site-cards'
import { SiteButtonLink, SiteLink } from './site-link'
import { siteHref } from './site-nav'

/** A version that was on the site (siteHistory.versions). */
export interface VersionView {
  id: string
  kind: 'initial' | 'release' | 'undo'
  version: string
  tag: string
  title: string | null
  taskId: string | null
  run: number
  approvedBy: string | null
  installedAt: Date
  current: boolean
  backupAt: Date | null
  undoes: string | null
  undone: boolean
}

/** «Отменить выпуск» is offered for this long after the installation (rule 3). */
const UNDO_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

export function versionTitle(version: Pick<VersionView, 'kind' | 'title' | 'version' | 'undoes'>) {
  if (version.kind === 'initial') return 'Первоначальная версия сайта'
  if (version.kind === 'undo')
    return version.undoes ? `Отмена выпуска версии ${version.undoes}` : 'Отмена выпуска'
  return version.title ?? `Версия ${version.version}`
}

/** The items of the list of «Изменения»: the newest first, the one on the site marked. */
export function versionItems(versions: readonly VersionView[]): HistoryItem[] {
  return versions.map((version) => ({
    segment: version.id,
    title: versionTitle(version),
    note: `версия ${version.version} · ${formatMoscowDay(version.installedAt)}${version.undone ? ' · отменена' : ''}`,
    ...(version.current ? { badge: 'на сайте' } : {}),
    tone: version.current ? 'ok' : 'neutral',
  }))
}

const Mono = ({ children }: { children: string }) => (
  <Box component="span" translate="no" sx={{ fontFamily: fontFamilies.mono }}>
    {children}
  </Box>
)

/**
 * One version of «Изменения»: when it came to the site, who asked for it, the copy made before it,
 * and the run and the dialog it came from. `next` — the version installed after it, if any.
 */
export function VersionDetail({
  siteId,
  version,
  next,
  now,
  nested = false,
}: {
  siteId: string
  version: VersionView
  next: VersionView | null
  now: Date
  /** At the root of the section the list holds the page's heading: this one is the next level. */
  nested?: boolean
}) {
  const undoUntil = new Date(version.installedAt.getTime() + UNDO_DAYS * DAY_MS)
  const undoOpen =
    version.current && version.kind === 'release' && version.taskId !== null && undoUntil > now
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <SectionTitle {...(nested ? { level: 'h2' as const } : {})}>
          {versionTitle(version)}
        </SectionTitle>
        <Typography color="text.secondary">
          {version.current
            ? 'Сейчас на сайте'
            : next
              ? `Была на сайте до ${formatMoscowDay(next.installedAt)}`
              : 'Была на сайте раньше'}
        </Typography>
      </Box>

      <SiteCard>
        <Box
          sx={{
            px: { xs: 2, sm: 2.75 },
            py: 2.25,
            display: 'flex',
            flexDirection: 'column',
            gap: 0.75,
          }}
        >
          <Typography>
            Версия <Mono>{version.version}</Mono>
          </Typography>
          <Typography color="text.secondary">
            {version.kind === 'initial' ? 'сохранена ' : 'установлена '}
            <time dateTime={version.installedAt.toISOString()}>
              {formatMoscowMoment(version.installedAt)}
            </time>
          </Typography>
          {version.kind === 'initial' ? (
            <Typography color="text.secondary">
              Копия файлов сайта на момент подключения: с неё начинается история его изменений.
            </Typography>
          ) : null}
          {version.current ? (
            <Typography variant="body2" color="text.secondary">
              Версию определяем по последнему обновлению, которое закончилось успешно. Если файлы
              сайта меняли в обход Радити, здесь этого не видно.
            </Typography>
          ) : null}
          {version.undone ? (
            <Typography variant="body2" color="text.secondary">
              Этот выпуск потом отменили: на сайт вернули то, что было до него.
            </Typography>
          ) : null}
        </Box>
        <Box sx={{ borderTop: 1, borderColor: 'divider' }}>
          <Facts>
            {version.kind === 'initial' ? null : (
              <Fact name="Кто попросил">{version.approvedBy ?? 'владелец сайта'}</Fact>
            )}
            <Fact name="Копия перед обновлением">
              {version.backupAt ? (
                <SiteLink href={siteHref(siteId, 'database')}>
                  {formatMoscowMoment(version.backupAt)}
                </SiteLink>
              ) : version.kind === 'initial' ? (
                'не нужна: это первая версия'
              ) : (
                'нет'
              )}
            </Fact>
          </Facts>
        </Box>
        <Box
          sx={{
            px: { xs: 2, sm: 2.75 },
            pb: 2.25,
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px 20px',
          }}
        >
          {version.taskId ? (
            <SiteLink href={`${siteHref(siteId, 'chat')}/${version.taskId}`}>
              Открыть диалог
            </SiteLink>
          ) : null}
          <SiteLink
            href={`${siteHref(siteId, 'runs')}/${version.kind === 'initial' ? 'import' : version.id}`}
          >
            Открыть запуск № {version.run}
          </SiteLink>
        </Box>
      </SiteCard>

      {undoOpen && version.taskId ? (
        <SiteCard title="Если нужно вернуть как было">
          <Box
            sx={{
              px: { xs: 2, sm: 2.75 },
              py: 2.25,
              display: 'flex',
              flexDirection: 'column',
              gap: 1.5,
            }}
          >
            <Typography>
              Этот выпуск можно отменить до {formatMoscowDay(undoUntil)}: на сайт вернутся прежние
              файлы и записи. Что изменили на сайте после выпуска, останется.
            </Typography>
            <SiteButtonLink href={`${siteHref(siteId, 'chat')}/${version.taskId}`}>
              Отменить в диалоге
            </SiteButtonLink>
          </Box>
        </SiteCard>
      ) : null}
    </Box>
  )
}

/** «Изменения» of a site with no version yet. The list beside it names the section — the
 * heading of the page — and says it is empty on a phone, where the list is all that is shown.
 */
export function NoVersions() {
  return (
    <Typography color="text.secondary" sx={{ display: { xs: 'none', md: 'block' } }}>
      Версий пока нет. Первая появится, когда Радити сохранит файлы сайта.
    </Typography>
  )
}
