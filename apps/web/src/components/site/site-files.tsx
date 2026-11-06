'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import MuiLink from '@mui/material/Link'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { terminalTaskStatuses } from '@repo/domain/tasks/task-status'
import { fontFamilies } from '@repo/ui/theme/tokens'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { callErrorText } from '@/components/chat/call-error'
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

// «Терминал» (owner's requests of 06.11.2026): the files of a project, a tree and the file chosen
// beside it, and an edit of a text file. In a project the files are those of the version on the
// site, and an edit is saved into an open chat of the project; in a chat with the code they are
// the working copy of its agent, and an edit is saved into that chat. Core commits it to the
// chat's branch when its agent waits; the site gets it by `/release` (rule 3).

/** How often a list, a file or an edit core is still at is asked for again. */
const WAIT_MS = 2_000

const fileCount = (count: number) =>
  `${count.toLocaleString('ru-RU')} ${plural(count, 'файл', 'файла', 'файлов')}`

export const siteFilesText = Object.freeze({
  title: 'Терминал',
  intro: (version: string | null) =>
    `Файлы ${version ? `версии ${version}, которая` : 'версии, которая'} сейчас на сайте. Правку файла можно сохранить в открытый чат проекта, а на сайт она попадёт командой /release.`,
  chatIntro: (changed: boolean) =>
    changed
      ? 'Рабочая копия агента: файлы с изменениями этого чата. Сохранённая правка попадёт в изменения чата.'
      : 'Файлы версии, которая сейчас на сайте: изменений в этом чате пока нет. Сохранённая правка станет его изменением.',
  tree: 'Файлы проекта',
  preparing: 'Готовим список файлов…',
  none: 'У этого проекта нет файлов в репозитории: он подключён без доступа к файлам.',
  failed: 'Не удалось загрузить файлы. Обновите страницу немного позже.',
  truncated: (count: number) => `Показаны первые ${fileCount(count)}.`,
  count: fileCount,
  pick: 'Выберите файл в списке, чтобы посмотреть его.',
  opening: 'Открываем файл…',
  binary: 'Это не текстовый файл — показать его здесь нельзя.',
  tooLarge: 'Файл больше 256 КБ — показать его здесь нельзя.',
  missing: 'Такого файла в этой версии нет.',
  fileFailed: 'Не удалось открыть файл. Попробуйте ещё раз.',
  edit: 'Изменить',
  save: 'Сохранить',
  saveTo: 'Сохранить в чат',
  cancel: 'Отмена',
  editor: (path: string) => `Текст файла ${path}`,
  chooseChat: 'Чат для правки',
  noChats:
    'Открытых чатов у проекта нет. Начните чат — после первого ответа агента правку можно будет сохранить в него.',
  newChat: 'Новый чат',
  openChat: 'Открыть чат',
  saving: 'Сохраняем в чат… Если агент сейчас работает, правка ляжет, когда он закончит.',
  outcome: Object.freeze({
    saved:
      'Сохранено в чате: агент продолжит с этим файлом, а на сайт он попадёт командой /release.',
    conflict:
      'Не сохранено: агент изменил этот файл, пока вы его правили. Откройте файл заново и повторите правку.',
    refused:
      'Не сохранено: этот файл менять нельзя — он вне рабочей копии агента, защищён правилами сайта или лежит в медиатеке.',
    failed: 'Не сохранено. Попробуйте ещё раз.',
  }),
})

const panelSx = {
  border: 1,
  borderColor: 'divider',
  borderRadius: '12px',
  bgcolor: 'background.paper',
  minWidth: 0,
  overflow: 'auto',
} as const

export interface SiteFilesProps {
  siteId: string
  /** A chat with the code of the project: its working copy, and edits go into it. */
  taskId?: string
  /** The chat has ended: its files are shown, no edit is taken. */
  ended?: boolean
  /** An edit got its answer: the chat reads its feed again, where its rows are. */
  onEdited?: () => void
}

export function SiteFiles({ siteId, taskId, ended = false, onEdited }: SiteFilesProps) {
  const trpc = useTRPC()
  const inChat = taskId !== undefined
  const list = useQuery({
    ...trpc.siteFiles.list.queryOptions({ siteId, ...(inChat ? { taskId } : {}) }),
    refetchInterval: (query) => (query.state.data?.state === 'preparing' ? WAIT_MS : false),
  })
  const [chosen, setChosen] = useState<string | null>(null)
  const viewer = useRef<HTMLElement>(null)
  // On a phone, and in the panel of a chat, the file stands under the tree: the view goes to it.
  const choose = (path: string) => {
    setChosen(path)
    if (inChat || window.matchMedia?.('(max-width: 899.95px)').matches)
      window.requestAnimationFrame(() => viewer.current?.scrollIntoView?.({ block: 'nearest' }))
  }
  const data = list.data
  // A saved edit moves the working copy: while core lists the new commit, the last list stays on
  // the screen, and with it the file and what came of the edit.
  const [shown, setShown] = useState<Extract<typeof data, { state: 'ready' }> | null>(null)
  if (data?.state === 'ready' && data !== shown) setShown(data)
  const ready = data?.state === 'ready' ? data : data?.state === 'preparing' ? shown : null
  const tree = useMemo(() => (ready ? siteFileTree(ready.files) : null), [ready])

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {inChat ? null : <SectionTitle>{siteFilesText.title}</SectionTitle>}
        {ready ? (
          <Typography color="text.secondary" sx={{ fontSize: inChat ? 14 : undefined }}>
            {inChat ? siteFilesText.chatIntro(ready.changed) : siteFilesText.intro(ready.version)}
          </Typography>
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
            gridTemplateColumns: inChat
              ? 'minmax(0, 1fr)'
              : { xs: 'minmax(0, 1fr)', md: '320px minmax(0, 1fr)' },
            gap: 2,
            alignItems: 'start',
          }}
        >
          <Box
            component="nav"
            aria-label={siteFilesText.tree}
            sx={{ ...panelSx, maxHeight: inChat ? '38vh' : { md: '72vh' }, py: 1 }}
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
          <FileView
            key={chosen ?? ''}
            siteId={siteId}
            taskId={taskId}
            ended={ended}
            sha={ready.sha}
            path={chosen}
            viewer={viewer}
            onEdited={onEdited}
          />
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
  taskId,
  ended,
  sha,
  path,
  viewer,
  onEdited,
}: {
  siteId: string
  taskId: string | undefined
  ended: boolean
  sha: string
  path: string | null
  viewer: RefObject<HTMLElement | null>
  onEdited: (() => void) | undefined
}) {
  const trpc = useTRPC()
  const file = useQuery({
    ...trpc.siteFiles.read.queryOptions({
      siteId,
      ...(taskId === undefined ? {} : { taskId }),
      sha,
      path: path ?? '-',
    }),
    enabled: path !== null,
    refetchInterval: (query) => (query.state.data?.state === 'preparing' ? WAIT_MS : false),
  })
  const [draft, setDraft] = useState<string | null>(null)
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
  const text = data?.state === 'ready' ? data.text : null
  const lines = text === null ? null : viewerLines(text)
  return (
    <Box
      component="section"
      ref={viewer}
      aria-label={path ?? siteFilesText.pick}
      sx={{
        ...panelSx,
        maxHeight: taskId === undefined ? { md: '72vh' } : undefined,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {path !== null ? (
        <Box
          sx={{
            position: 'sticky',
            top: 0,
            zIndex: 1,
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 1,
            px: 2,
            py: 1,
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
          {lines && draft === null ? (
            <Typography variant="caption" color="text.secondary" sx={{ flex: 'none' }}>
              {`${lines.length.toLocaleString('ru-RU')} ${plural(lines.length, 'строка', 'строки', 'строк')} · ${fileSizeText(new TextEncoder().encode(text ?? '').byteLength)}`}
            </Typography>
          ) : null}
          {text !== null && draft === null && !ended ? (
            <Button
              size="small"
              variant="outlined"
              onClick={() => setDraft(text)}
              sx={{ ml: 'auto', minHeight: 32 }}
            >
              {siteFilesText.edit}
            </Button>
          ) : null}
        </Box>
      ) : null}
      {path !== null && draft !== null ? (
        <Editor
          siteId={siteId}
          taskId={taskId}
          sha={sha}
          path={path}
          draft={draft}
          onDraft={setDraft}
          onClose={() => setDraft(null)}
          onEdited={onEdited}
        />
      ) : lines ? (
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

/** The open chats of the project an edit can go into, latest changed first. */
function useOpenChats(siteId: string, enabled: boolean) {
  const trpc = useTRPC()
  const chats = useQuery({ ...trpc.task.list.queryOptions({ folder: siteId }), enabled })
  return (chats.data?.items ?? []).filter((item) => !terminalTaskStatuses.includes(item.status))
}

/**
 * The text of a file being changed and its saving: into the chat of the panel, or — in a project —
 * into the open chat the client chooses. What came of it is asked of the server until core answers.
 */
function Editor({
  siteId,
  taskId,
  sha,
  path,
  draft,
  onDraft,
  onClose,
  onEdited,
}: {
  siteId: string
  taskId: string | undefined
  sha: string
  path: string
  draft: string
  onDraft: (text: string) => void
  onClose: () => void
  onEdited: (() => void) | undefined
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const chats = useOpenChats(siteId, taskId === undefined)
  const [picked, setPicked] = useState<string | null>(null)
  const target = taskId ?? picked ?? chats[0]?.id ?? null
  const save = useMutation(trpc.siteFiles.save.mutationOptions())
  const editId = save.data?.editId ?? null
  const savedTo = save.variables?.taskId ?? null
  const state = useQuery({
    ...trpc.siteFiles.editState.queryOptions({
      siteId,
      taskId: savedTo ?? target ?? '00000000-0000-4000-8000-000000000000',
      editId: editId ?? '00000000-0000-4000-8000-000000000000',
    }),
    enabled: editId !== null && savedTo !== null,
    refetchInterval: (query) =>
      query.state.data?.state === 'saved' ||
      query.state.data?.state === 'conflict' ||
      query.state.data?.state === 'refused' ||
      query.state.data?.state === 'failed'
        ? false
        : WAIT_MS,
  })
  const outcome = state.data && state.data.state !== 'pending' ? state.data.state : null
  // A saved edit moved the working copy of the chat: its list names the new commit.
  useEffect(() => {
    if (outcome === null) return
    if (outcome === 'saved')
      void queryClient.invalidateQueries({ queryKey: trpc.siteFiles.list.queryKey() })
    onEdited?.()
  }, [outcome, queryClient, trpc, onEdited])
  const pending = save.isPending || (editId !== null && outcome === null)
  const status = save.isError
    ? callErrorText(save.error)
    : outcome !== null
      ? siteFilesText.outcome[outcome]
      : editId !== null
        ? siteFilesText.saving
        : null

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, p: 1.5 }}>
      <TextField
        multiline
        minRows={14}
        maxRows={40}
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        disabled={pending || outcome === 'saved'}
        slotProps={{
          htmlInput: {
            'aria-label': siteFilesText.editor(path),
            spellCheck: false,
            style: {
              fontFamily: fontFamilies.mono,
              fontSize: 13,
              lineHeight: 1.6,
              whiteSpace: 'pre',
            },
            wrap: 'off',
          },
        }}
      />
      {taskId === undefined ? (
        chats.length === 0 ? (
          <Typography color="text.secondary" sx={{ fontSize: 14 }}>
            {siteFilesText.noChats}{' '}
            <MuiLink component={Link} href={`/chats/new?project=${siteId}`}>
              {siteFilesText.newChat}
            </MuiLink>
          </Typography>
        ) : (
          <TextField
            select
            size="small"
            label={siteFilesText.chooseChat}
            value={target ?? ''}
            onChange={(event) => setPicked(event.target.value)}
            disabled={pending || outcome === 'saved'}
          >
            {chats.map((chat) => (
              <MenuItem key={chat.id} value={chat.id}>
                {chat.title ?? 'Чат без названия'}
              </MenuItem>
            ))}
          </TextField>
        )
      ) : null}
      {status ? (
        <Typography
          role={outcome === null && !save.isError ? 'status' : 'alert'}
          color={
            outcome === 'saved'
              ? 'success.main'
              : outcome || save.isError
                ? 'error.main'
                : 'text.secondary'
          }
          sx={{ fontSize: 14 }}
        >
          {status}
          {outcome === 'saved' && taskId === undefined && savedTo ? (
            <>
              {' '}
              <MuiLink component={Link} href={`/chats/${savedTo}`}>
                {siteFilesText.openChat}
              </MuiLink>
            </>
          ) : null}
        </Typography>
      ) : null}
      <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
        <Button onClick={onClose} disabled={save.isPending}>
          {outcome === 'saved' ? 'Закрыть' : siteFilesText.cancel}
        </Button>
        {outcome === 'saved' ? null : (
          <Button
            variant="contained"
            disabled={pending || target === null}
            onClick={() =>
              target !== null &&
              save.mutate({ siteId, taskId: target, path, baseSha: sha, text: draft })
            }
            startIcon={<AppIcon name="check" size={16} />}
          >
            {taskId === undefined ? siteFilesText.saveTo : siteFilesText.save}
          </Button>
        )}
      </Box>
    </Box>
  )
}
