'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import {
  artifactMention,
  artifactRoleAtLeast,
  sitemapPagesOf,
  sitemapSiteRequest,
  type ArtifactOp,
  type SitemapPage,
} from '@repo/domain/artifacts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { keepChatDraft } from '@/components/chat/chat-draft'
import { uuidv7 } from '@/components/chat/uuid'
import { useTRPC } from '@/trpc/client'

import type { ArtifactBodyProps } from '../artifact-body-props'

// «Структура сайта» in the cabinet (docs/plan/88-artifacts.md, §7.7; slice 88.27): the tree of a
// future site as an outline — a page, then its children —, each with its goal, main action and the
// brief of its text. The pages move up and down among their siblings, go under the page above or
// out of their parent — by buttons, so a phone and a keyboard do it as well as a mouse. «Сделать
// сайт» asks the agent, in a new chat, for a canvas of these pages.

export const sitemapTexts = Object.freeze({
  empty: 'Страниц пока нет. Попросите агента предложить структуру сайта или добавьте страницу.',
  pages: 'Страницы сайта',
  makeSite: 'Сделать сайт',
  add: 'Добавить страницу',
  remove: 'Удалить страницу',
  up: 'Выше',
  down: 'Ниже',
  indent: 'Вложить в страницу выше',
  outdent: 'Вынести на уровень вверх',
  title: 'Страница',
  goal: 'Зачем приходят',
  action: 'Главное действие',
  brief: 'Задание на текст',
  save: 'Сохранить',
  goalShort: 'Цель',
  actionShort: 'Действие',
  failed: 'Не получилось сохранить. Попробуйте ещё раз.',
  stale: 'Структуру только что изменили. Обновите и повторите.',
  newPage: 'Новая страница',
})

const domainCodeOf = (error: unknown) =>
  (error as { data?: { domainCode?: string } } | null)?.data?.domainCode

const newKey = () => `page${uuidv7().replace(/-/g, '').slice(-8)}`

type Block = ArtifactBodyProps['artifact']['blocks'][number]

/** The editing of one page: its title, goal, main action and brief, written with its revision. */
function PageEditor({
  page,
  block,
  canEdit,
  apply,
  busy,
}: {
  page: SitemapPage
  block: Block
  canEdit: boolean
  apply: (ops: ArtifactOp[]) => Promise<void>
  busy: boolean
}) {
  const [draft, setDraft] = useState({
    title: page.title,
    goal: page.goal,
    action: page.action,
    brief: page.brief,
  })
  const changed =
    draft.title !== page.title ||
    draft.goal !== page.goal ||
    draft.action !== page.action ||
    draft.brief !== page.brief
  const field = (name: keyof typeof draft, label: string, multiline = false) => (
    <TextField
      label={label}
      value={draft[name]}
      onChange={(event) => setDraft({ ...draft, [name]: event.target.value })}
      disabled={!canEdit}
      size="small"
      fullWidth
      {...(multiline ? { multiline: true, minRows: 3 } : {})}
    />
  )
  return (
    <Box
      component="section"
      aria-label={page.title}
      sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}
    >
      {field('title', sitemapTexts.title)}
      {field('goal', sitemapTexts.goal)}
      {field('action', sitemapTexts.action)}
      {field('brief', sitemapTexts.brief, true)}
      {canEdit && (
        <Box>
          <Button
            variant="contained"
            disabled={!changed || busy || draft.title.trim() === ''}
            onClick={() =>
              void apply([
                {
                  op: 'replace',
                  block: block.key,
                  ifRev: block.rev,
                  content: draft.brief,
                  // Text properties only: `replace` takes no value (Ар15).
                  props: {
                    title: draft.title.trim(),
                    goal: draft.goal.trim(),
                    action: draft.action.trim(),
                  },
                },
              ])
            }
          >
            {sitemapTexts.save}
          </Button>
        </Box>
      )}
    </Box>
  )
}

export function ArtifactSitemap(props: ArtifactBodyProps & { onAccessLost: () => void }) {
  const { artifact, onChanged, place } = props
  const trpc = useTRPC()
  const router = useRouter()
  const me = useQuery(trpc.user.me.queryOptions())
  const canEdit = artifactRoleAtLeast(artifact.role, 'edit')
  const pages = sitemapPagesOf(artifact.blocks)
  const nodes = artifact.blocks.filter((block) => block.kind === 'node' && block.parent === null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const write = useMutation(trpc.artifact.write.mutationOptions())
  const page = pages.find((each) => each.key === chosen) ?? pages[0] ?? null
  const blockOf = (key: string) => nodes.find((node) => node.key === key)
  const siblingsOf = (target: SitemapPage) => pages.filter((each) => each.up === target.up)

  async function apply(ops: ArtifactOp[]) {
    setProblem(null)
    try {
      await write.mutateAsync({ batch: { artifactId: artifact.id, opId: uuidv7(), ops } })
      onChanged()
    } catch (error) {
      setProblem(
        domainCodeOf(error) === 'ARTIFACT_STALE' ? sitemapTexts.stale : sitemapTexts.failed,
      )
    }
  }

  /** A new parent of a page: a value, «the last one wins» (Ар15); '' — the top. */
  function reparent(target: SitemapPage, up: string | null) {
    const block = blockOf(target.key)
    if (!block) return
    void apply([{ op: 'props', block: block.key, props: { up: up ?? '' } }])
  }

  function move(target: SitemapPage, direction: -1 | 1) {
    const siblings = siblingsOf(target)
    const at = siblings.findIndex((each) => each.key === target.key)
    const other = siblings[at + direction]
    const block = blockOf(target.key)
    if (!other || !block) return
    // Siblings keep the order of the blocks: up — after the block before the one above; down —
    // after the one below.
    const after =
      direction === 1
        ? other.key
        : (nodes[nodes.findIndex((node) => node.key === other.key) - 1]?.key ?? null)
    void apply([{ op: 'move', block: block.key, ifRev: block.rev, after }])
  }

  function add() {
    const key = newKey()
    void apply([
      {
        op: 'insert',
        block: key,
        after: page?.key ?? null,
        kind: 'node',
        content: '',
        props: {
          title: sitemapTexts.newPage,
          ...(page?.up ? { up: page.up } : {}),
        },
      },
    ])
    setChosen(key)
  }

  function remove(target: SitemapPage) {
    const block = blockOf(target.key)
    if (block) void apply([{ op: 'delete', block: block.key, ifRev: block.rev }])
  }

  function makeSite() {
    const userId = me.data?.id
    if (userId) keepChatDraft(userId, sitemapSiteRequest(artifactMention(artifact.id)))
    router.push(artifact.project ? `/chats/new?project=${artifact.project.id}` : '/chats/new')
  }

  if (pages.length === 0)
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-start' }}>
        <Typography sx={{ color: 'text.secondary' }}>{sitemapTexts.empty}</Typography>
        {canEdit && <Button onClick={add}>{sitemapTexts.add}</Button>}
      </Box>
    )

  const siblings = page ? siblingsOf(page) : []
  const at = page ? siblings.findIndex((each) => each.key === page.key) : -1
  const block = page ? blockOf(page.key) : undefined
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <Button variant="contained" onClick={makeSite}>
          {sitemapTexts.makeSite}
        </Button>
        {canEdit && page && (
          <>
            <Button onClick={add} disabled={write.isPending}>
              {sitemapTexts.add}
            </Button>
            <Button onClick={() => move(page, -1)} disabled={write.isPending || at <= 0}>
              {sitemapTexts.up}
            </Button>
            <Button
              onClick={() => move(page, 1)}
              disabled={write.isPending || at < 0 || at === siblings.length - 1}
            >
              {sitemapTexts.down}
            </Button>
            <Button
              onClick={() => reparent(page, siblings[at - 1]!.key)}
              disabled={write.isPending || at <= 0}
            >
              {sitemapTexts.indent}
            </Button>
            <Button
              onClick={() => reparent(page, pages.find((each) => each.key === page.up)?.up ?? null)}
              disabled={write.isPending || page.up === null}
            >
              {sitemapTexts.outdent}
            </Button>
            <Button color="error" onClick={() => remove(page)} disabled={write.isPending}>
              {sitemapTexts.remove}
            </Button>
          </>
        )}
      </Box>
      {problem && <Alert severity="error">{problem}</Alert>}
      <Box
        sx={{
          display: 'flex',
          flexDirection: place === 'pane' ? 'column' : 'row',
          gap: 2,
          alignItems: 'flex-start',
        }}
      >
        <Box
          component="ul"
          aria-label={sitemapTexts.pages}
          sx={{
            listStyle: 'none',
            m: 0,
            p: 0,
            flex: '1 1 0',
            minWidth: 0,
            display: 'grid',
            gap: 1,
          }}
        >
          {pages.map((each) => (
            <Box component="li" key={each.key} sx={{ pl: each.depth * 3 }}>
              <Box
                component="button"
                type="button"
                aria-current={each.key === page?.key ? 'true' : undefined}
                onClick={() => setChosen(each.key)}
                sx={{
                  width: '100%',
                  textAlign: 'left',
                  p: 1.5,
                  border: 2,
                  borderColor: each.key === page?.key ? 'primary.main' : 'divider',
                  borderRadius: '10px',
                  bgcolor: 'background.paper',
                  cursor: 'pointer',
                  font: 'inherit',
                }}
              >
                <Typography component="span" sx={{ fontWeight: 650, display: 'block' }}>
                  {each.title}{' '}
                  <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>
                    {each.path}
                  </Typography>
                </Typography>
                {(each.goal || each.action) && (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {[
                      each.goal && `${sitemapTexts.goalShort}: ${each.goal}`,
                      each.action && `${sitemapTexts.actionShort}: ${each.action}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Typography>
                )}
              </Box>
            </Box>
          ))}
        </Box>
        {page && block && (
          <Box sx={{ flex: place === 'pane' ? '1 1 auto' : '0 0 360px', width: '100%' }}>
            <PageEditor
              key={`${page.key}:${block.rev}`}
              page={page}
              block={block}
              canEdit={canEdit}
              apply={apply}
              busy={write.isPending}
            />
          </Box>
        )}
      </Box>
    </Box>
  )
}
