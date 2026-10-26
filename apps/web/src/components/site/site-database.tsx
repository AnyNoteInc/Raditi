import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { fontFamilies } from '@repo/ui/theme/tokens'
import type { ReactNode } from 'react'

import { fileSizeText } from '@/components/chat/chat-format'
import { formatMoscowDay, formatMoscowMoment } from '@/lib/moscow-date'
import { plural } from '@/lib/plural'

import { engineText, tlsText } from './history-text'
import { SectionTitle } from './section-empty'
import type { SiteBlock } from './site-block-nav'
import { Fact, Facts, SiteCard } from './site-cards'
import { SiteLink } from './site-link'
import { siteHref } from './site-nav'

export interface DatabaseView {
  engine: 'postgres' | 'mysql'
  databaseName: string
  tls: 'verified' | 'unverified' | 'plain'
  updatedAt: Date
}

export interface BackupView {
  id: string
  kind: 'release' | 'initial'
  at: Date
  bytes: number | null
  version: string
  /** siteHistory.backups: `ready` — «Скачать»; `pending` — core is making it; `none` — not offered. */
  download: 'ready' | 'pending' | 'none'
}

/** Where «Скачать» of a copy leads: the server streams it to a member of the site. */
export const backupDownloadHref = (siteId: string, backupId: string) =>
  `/api/projects/${siteId}/backups/${backupId}`

const cell = { px: { xs: 2, sm: 2.75 }, py: 1.5 } as const

/** The blocks of «База и бэкап», each a page beside the menu (owner's request of 26.10.2026). */
export const DATABASE_BLOCK = 'connection'
export const BACKUPS_BLOCK = 'backups'

/**
 * The menu of «База и бэкап»: what each block holds now. `database` — undefined when it could not
 * be read; `backups` — null then.
 */
export function databaseBlocks(
  database: DatabaseView | null | undefined,
  backups: readonly BackupView[] | null,
): SiteBlock[] {
  const latest =
    backups?.reduce<Date | null>(
      (newest, backup) => (newest === null || backup.at > newest ? backup.at : newest),
      null,
    ) ?? null
  return [
    {
      segment: DATABASE_BLOCK,
      title: 'База данных сайта',
      icon: 'database',
      note:
        database === undefined
          ? 'Не удалось загрузить'
          : database === null
            ? 'Не подключена'
            : `${engineText[database.engine]} · ${database.databaseName}`,
    },
    {
      segment: BACKUPS_BLOCK,
      title: 'Копии',
      icon: 'folder',
      note:
        backups === null
          ? 'Не удалось загрузить'
          : latest === null
            ? 'Копий пока нет'
            : `${backups.length} ${plural(backups.length, 'копия', 'копии', 'копий')} · последняя ${formatMoscowDay(latest)}`,
    },
  ]
}

/**
 * «База данных сайта»: the database as the platform knows it — only its kind, name and protection;
 * the address, the user and the password stay in the vault. Without a live database, `dump` —
 * where a preview takes its copy from (the SQL dump form). `nested` — at the root of the section,
 * where the menu holds the h1.
 */
export function DatabaseBlock({
  database,
  dump,
  nested = false,
}: {
  database: DatabaseView | null
  dump?: ReactNode
  nested?: boolean
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
      <SectionTitle level={nested ? 'h2' : 'h1'}>База данных сайта</SectionTitle>
      <SiteCard>
        {database ? (
          <>
            <Facts>
              <Fact name="Система">{engineText[database.engine]}</Fact>
              <Fact name="Имя базы">
                <Box component="span" translate="no" sx={{ fontFamily: fontFamilies.mono }}>
                  {database.databaseName}
                </Box>
              </Fact>
              <Fact name="Соединение">{tlsText[database.tls]}</Fact>
              <Fact name="Подключение записано">{formatMoscowMoment(database.updatedAt)}</Fact>
            </Facts>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ px: { xs: 2, sm: 2.75 }, pb: 2.25 }}
            >
              Адрес, пользователь и пароль хранятся в защищённом хранилище и здесь не показываются.
            </Typography>
          </>
        ) : (
          <Box sx={{ ...cell, py: 2.25, display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Typography sx={{ fontWeight: 600 }}>База данных не подключена</Typography>
            <Typography color="text.secondary">
              При добавлении проекта базу не указали — например, потому что хостинг пускает к ней
              только с самого сервера сайта. Сайт работает и без этого: перед каждым обновлением
              Радити сохраняет копию того, что обновление перезапишет, — файлы и записи сайта.
            </Typography>
            {dump}
          </Box>
        )}
      </SiteCard>
    </Box>
  )
}

/**
 * «Копии»: the copies the platform made — of the files at the connection, and before every update.
 * A schedule of copies is not made yet, so none is offered. `nested` — as in `DatabaseBlock`.
 */
export function BackupsBlock({
  siteId,
  backups,
  nested = false,
}: {
  siteId: string
  backups: readonly BackupView[] | null
  nested?: boolean
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
      <SectionTitle level={nested ? 'h2' : 'h1'}>Копии</SectionTitle>
      <SiteCard>
        {backups === null ? (
          <Typography role="alert" sx={{ ...cell, py: 2.25 }}>
            Не удалось загрузить список копий. Обновите страницу через пару минут.
          </Typography>
        ) : backups.length === 0 ? (
          <Typography color="text.secondary" sx={{ ...cell, py: 2.25 }}>
            Копий пока нет. Первая появится перед первым обновлением сайта.
          </Typography>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Box
              component="table"
              sx={{ width: '100%', minWidth: 560, borderCollapse: 'collapse' }}
            >
              <Box component="thead" sx={{ bgcolor: 'action.hover' }}>
                <tr>
                  {['Когда', 'Откуда', 'Что внутри', 'Размер', 'Версия', 'Действие'].map((name) => (
                    <Box
                      component="th"
                      key={name}
                      scope="col"
                      sx={{
                        ...cell,
                        py: 1.25,
                        textAlign: 'left',
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: 'text.secondary',
                      }}
                    >
                      {name}
                    </Box>
                  ))}
                </tr>
              </Box>
              <tbody>
                {backups.map((backup) => (
                  <Box component="tr" key={backup.id} sx={{ borderTop: 1, borderColor: 'divider' }}>
                    <Box component="td" sx={cell}>
                      <time dateTime={backup.at.toISOString()}>
                        {formatMoscowMoment(backup.at)}
                      </time>
                    </Box>
                    <Box component="td" sx={cell}>
                      {backup.kind === 'initial'
                        ? 'При подключении сайта'
                        : 'Перед обновлением сайта'}
                    </Box>
                    <Box component="td" sx={cell}>
                      {backup.kind === 'initial'
                        ? 'Файлы сайта'
                        : 'Файлы и записи, которые меняло обновление'}
                    </Box>
                    <Box component="td" sx={cell}>
                      {backup.bytes === null ? '—' : fileSizeText(backup.bytes)}
                    </Box>
                    <Box component="td" sx={cell}>
                      <SiteLink
                        href={`${siteHref(siteId, 'changes')}/${backup.kind === 'initial' ? 'initial' : backup.id}`}
                      >
                        {backup.version}
                      </SiteLink>
                    </Box>
                    <Box component="td" sx={cell}>
                      <BackupAction siteId={siteId} backup={backup} />
                    </Box>
                  </Box>
                ))}
              </tbody>
            </Box>
          </Box>
        )}
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', ...cell, borderTop: 1, borderColor: 'divider' }}
        >
          Если обновление не прошло проверку, сайт возвращается к прежнему виду из такой копии сам.
        </Typography>
      </SiteCard>
    </Box>
  )
}

/** «Скачать» of a copy that is in the bucket; what is said instead of it otherwise. */
function BackupAction({ siteId, backup }: { siteId: string; backup: BackupView }) {
  if (backup.download === 'ready')
    return (
      <Box
        component="a"
        href={backupDownloadHref(siteId, backup.id)}
        download
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          minHeight: 40,
          px: 1.75,
          borderRadius: '999px',
          border: 1,
          borderColor: 'text.primary',
          color: 'text.primary',
          fontSize: 14,
          fontWeight: 600,
          textDecoration: 'none',
          whiteSpace: 'nowrap',
          '&:hover': { bgcolor: 'action.hover' },
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2,
          },
        }}
      >
        Скачать
      </Box>
    )
  return (
    <Typography variant="body2" color="text.secondary">
      {backup.download === 'pending' ? 'Готовим копию' : 'Только для возврата сайта'}
    </Typography>
  )
}
