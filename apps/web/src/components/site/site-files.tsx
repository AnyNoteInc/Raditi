'use client'

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import { fontFamilies } from '@repo/ui/theme/tokens'
import { useMemo, useRef, useState, type RefObject } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { fileSizeText } from '@/components/chat/chat-format'
import { plural } from '@/lib/plural'
import { useTRPC } from '@/trpc/client'

import { SectionTitle } from './section-empty'
import {
  siteFileTree,
  viewerLines,
  type SiteFolderNode,
  type SiteTreeNode,
} from './site-files-tree'

// «Терминал» of a project (owner's request of 06.11.2026: «сделай в левом меню терминал и там
// файловую структуру с возможностью просмотра файлов»): the files of the version the site has, a
// tree on the left and the file chosen beside it. Read only: files change through a chat.

/** How often a list or a file core is still reading is asked for again. */
const WAIT_MS = 2_000

export const siteFilesText = Object.freeze({
  title: 'Терминал',
  intro: (version: string | null) =>
    `Файлы ${version ? `версии ${version}, которая` : 'версии, которая'} сейчас на сайте. Здесь их можно только посмотреть, а изменить — в чате с агентом.`,
  tree: 'Файлы проекта',
  preparing: 'Готовим список файлов…',
  none: 'У этого проекта нет файлов в репозитории: он подключён без доступа к файлам.',
  failed: 'Не удалось загрузить файлы. Обновите страницу немного позже.',
  truncated: (count: number) =>
    `Показаны первые ${count.toLocaleString('ru-RU')} ${plural(count, 'файл', 'файла', 'файлов')}.`,
  count: (count: number) =>
    `${count.toLocaleString('ru-RU')} ${plural(count, 'файл', 'файла', 'файлов')}`,
  pick: 'Выберите файл в списке, чтобы посмотреть его.',
  opening: 'Открываем файл…',
  binary: 'Это не текстовый файл — показать его здесь нельзя.',
  tooLarge: 'Файл больше 256 КБ — показать его здесь нельзя.',
  missing: 'Такого файла в этой версии нет.',
  fileFailed: 'Не удалось открыть файл. Попробуйте ещё раз.',
})

const panelSx = {
  border: 1,
  borderColor: 'divider',
  borderRadius: '12px',
  bgcolor: 'background.paper',
  minWidth: 0,
  overflow: 'auto',
} as const

export function SiteFiles({ siteId }: { siteId: string }) {
  const trpc = useTRPC()
  const list = useQuery({
    ...trpc.siteFiles.list.queryOptions({ siteId }),
    refetchInterval: (query) => (query.state.data?.state === 'preparing' ? WAIT_MS : false),
  })
  const [chosen, setChosen] = useState<string | null>(null)
  const viewer = useRef<HTMLElement>(null)
  // On a phone the file stands under the tree: the page goes to it.
  const choose = (path: string) => {
    setChosen(path)
    if (window.matchMedia?.('(max-width: 899.95px)').matches)
      window.requestAnimationFrame(() => viewer.current?.scrollIntoView({ block: 'start' }))
  }
  const data = list.data
  const ready = data?.state === 'ready' ? data : null
  const tree = useMemo(() => (ready ? siteFileTree(ready.files) : null), [ready])

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <SectionTitle>{siteFilesText.title}</SectionTitle>
        {ready ? (
          <Typography color="text.secondary">{siteFilesText.intro(ready.version)}</Typography>
        ) : null}
      </Box>
      {list.isError ? (
        <Typography role="alert" color="error.main">
          {siteFilesText.failed}
        </Typography>
      ) : data?.state === 'none' ? (
        <Typography color="text.secondary">{siteFilesText.none}</Typography>
      ) : !ready ? (
        <Typography role="status" color="text.secondary">
          {siteFilesText.preparing}
        </Typography>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: '320px minmax(0, 1fr)' },
            gap: 2,
            alignItems: 'start',
          }}
        >
          <Box
            component="nav"
            aria-label={siteFilesText.tree}
            sx={{ ...panelSx, maxHeight: { md: '72vh' }, py: 1 }}
          >
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', px: 1.5, pb: 0.5 }}
            >
              {siteFilesText.count(ready.files.length)}
              {ready.truncated ? ` · ${siteFilesText.truncated(ready.files.length)}` : ''}
            </Typography>
            {tree ? <Folder folder={tree} depth={0} chosen={chosen} onChoose={choose} /> : null}
          </Box>
          <FileView siteId={siteId} path={chosen} viewer={viewer} />
        </Box>
      )}
    </Box>
  )
}

function Folder({
  folder,
  depth,
  chosen,
  onChoose,
}: {
  folder: SiteFolderNode
  depth: number
  chosen: string | null
  onChoose: (path: string) => void
}) {
  return (
    <Box
      component="ul"
      role={depth === 0 ? undefined : 'group'}
      sx={{ m: 0, p: 0, listStyle: 'none' }}
    >
      {folder.children.map((node) => (
        <Entry key={node.path} node={node} depth={depth} chosen={chosen} onChoose={onChoose} />
      ))}
    </Box>
  )
}

const rowSx = (depth: number, current: boolean) =>
  ({
    display: 'flex',
    alignItems: 'center',
    gap: 0.75,
    width: '100%',
    minHeight: 32,
    pl: 1.5 + depth * 1.75,
    pr: 1.5,
    border: 0,
    bgcolor: current ? 'action.selected' : 'transparent',
    color: 'text.primary',
    font: 'inherit',
    fontSize: 14,
    textAlign: 'left',
    cursor: 'pointer',
    '&:hover': { bgcolor: current ? 'action.selected' : 'action.hover' },
    '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
  }) as const

const nameSx = {
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as const

function Entry({
  node,
  depth,
  chosen,
  onChoose,
}: {
  node: SiteTreeNode
  depth: number
  chosen: string | null
  onChoose: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (node.kind === 'file') {
    const current = node.path === chosen
    return (
      <li>
        <Box
          component="button"
          type="button"
          aria-current={current ? 'true' : undefined}
          title={node.path}
          onClick={() => onChoose(node.path)}
          sx={rowSx(depth, current)}
        >
          <Box component="span" sx={{ flex: 'none', display: 'inline-flex', width: 16 }} />
          <Box
            component="span"
            sx={{ flex: 'none', display: 'inline-flex', color: 'text.secondary' }}
          >
            <AppIcon name="file" size={15} />
          </Box>
          <Box component="span" sx={nameSx}>
            {node.name}
          </Box>
        </Box>
      </li>
    )
  }
  return (
    <li>
      <Box
        component="button"
        type="button"
        aria-expanded={open}
        title={node.path}
        onClick={() => setOpen((value) => !value)}
        sx={rowSx(depth, false)}
      >
        <Box
          component="span"
          sx={{
            flex: 'none',
            display: 'inline-flex',
            width: 16,
            color: 'text.secondary',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform var(--raditi-motion-fast) var(--raditi-ease-out)',
          }}
        >
          <AppIcon name="chevron" size={14} />
        </Box>
        <Box
          component="span"
          sx={{ flex: 'none', display: 'inline-flex', color: 'text.secondary' }}
        >
          <AppIcon name="folder" size={15} />
        </Box>
        <Box component="span" sx={nameSx}>
          {node.name}
        </Box>
        <Box
          component="span"
          sx={{ ml: 'auto', flex: 'none', fontSize: 12, color: 'text.secondary' }}
        >
          {node.files.toLocaleString('ru-RU')}
        </Box>
      </Box>
      {open ? <Folder folder={node} depth={depth + 1} chosen={chosen} onChoose={onChoose} /> : null}
    </li>
  )
}

function FileView({
  siteId,
  path,
  viewer,
}: {
  siteId: string
  path: string | null
  viewer: RefObject<HTMLElement | null>
}) {
  const trpc = useTRPC()
  const file = useQuery({
    ...trpc.siteFiles.read.queryOptions({ siteId, path: path ?? '-' }),
    enabled: path !== null,
    refetchInterval: (query) => (query.state.data?.state === 'preparing' ? WAIT_MS : false),
  })
  const data = file.data
  const note =
    path === null
      ? siteFilesText.pick
      : file.isError
        ? siteFilesText.fileFailed
        : data === undefined || data.state === 'preparing'
          ? siteFilesText.opening
          : data.state === 'binary'
            ? siteFilesText.binary
            : data.state === 'too_large'
              ? siteFilesText.tooLarge
              : data.state === 'missing' || data.state === 'none'
                ? siteFilesText.missing
                : null
  const lines = data?.state === 'ready' ? viewerLines(data.text) : null
  return (
    <Box
      component="section"
      ref={viewer}
      aria-label={path ?? siteFilesText.pick}
      sx={{ ...panelSx, maxHeight: { md: '72vh' }, display: 'flex', flexDirection: 'column' }}
    >
      {path !== null ? (
        <Box
          sx={{
            position: 'sticky',
            top: 0,
            zIndex: 1,
            display: 'flex',
            alignItems: 'baseline',
            gap: 1,
            px: 2,
            py: 1.25,
            borderBottom: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
          }}
        >
          <Typography
            component="h2"
            sx={{ fontFamily: fontFamilies.mono, fontSize: 13.5, fontWeight: 600, ...nameSx }}
            title={path}
          >
            {path}
          </Typography>
          {lines ? (
            <Typography variant="caption" color="text.secondary" sx={{ flex: 'none', ml: 'auto' }}>
              {`${lines.length.toLocaleString('ru-RU')} ${plural(lines.length, 'строка', 'строки', 'строк')} · ${fileSizeText(new TextEncoder().encode(data?.state === 'ready' ? data.text : '').byteLength)}`}
            </Typography>
          ) : null}
        </Box>
      ) : null}
      {lines ? (
        <Box
          component="pre"
          sx={{
            m: 0,
            py: 1,
            fontFamily: fontFamilies.mono,
            fontSize: 13,
            lineHeight: 1.6,
            display: 'grid',
            gridTemplateColumns: 'max-content 1fr',
            minWidth: 'max-content',
          }}
        >
          {lines.map((line, index) => (
            <Box key={index} component="span" sx={{ display: 'contents' }}>
              <Box
                component="span"
                aria-hidden="true"
                sx={{ px: 1.5, color: 'text.secondary', textAlign: 'right', userSelect: 'none' }}
              >
                {index + 1}
              </Box>
              <Box component="span" sx={{ pr: 2, whiteSpace: 'pre' }}>
                {line === '' ? ' ' : line}
              </Box>
            </Box>
          ))}
        </Box>
      ) : (
        <Typography
          role={path !== null && data?.state === 'preparing' ? 'status' : undefined}
          color={file.isError ? 'error.main' : 'text.secondary'}
          sx={{ p: 2 }}
        >
          {note}
        </Typography>
      )}
    </Box>
  )
}
