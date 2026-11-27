'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { fontFamilies } from '@repo/ui/theme/tokens'
import type { AppRouter } from '@repo/trpc'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { inferRouterOutputs } from '@trpc/server'
import { useEffect, useState, type ReactNode } from 'react'

import { AgentMarkdown } from '@/components/chat/agent-markdown'
import { callErrorText } from '@/components/chat/call-error'
import { fileSizeText } from '@/components/chat/chat-format'
import { formatMoscowMoment } from '@/lib/moscow-date'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { SkillDialog } from './account-skill-install'
import { accountSkillsText as text } from './account-skills-text'

// The dialogs of a row of «Установленные» (docs/plan/97-skills.md, Нв11, Нв21): «Открыть» — the
// SKILL.md drawn as Markdown and its files, read only; «Обновить» — what the new commit adds,
// changes and removes, and its SKILL.md, then the update to exactly that commit; «Вернуть прошлую
// версию» — the versions kept.

export type AccountSkill = inferRouterOutputs<AppRouter>['accountSkills']['list']['skills'][number]

/** SKILL.md without its frontmatter: the name and description are shown above it already. */
export function skillMdBody(skillMd: string): string {
  return skillMd.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u, '').trimStart()
}

/** The first characters of a commit, as hosts show them. */
export const shortCommit = (commit: string | null) => (commit ? commit.slice(0, 7) : null)

/** The SKILL.md of a skill in a frame that scrolls. */
function SkillMd({ skillMd }: { skillMd: string }) {
  return (
    <Box
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: '12px',
        px: { xs: 1.5, sm: 2 },
        py: 1,
        maxHeight: '50dvh',
        overflowY: 'auto',
        minWidth: 0,
      }}
    >
      <AgentMarkdown text={skillMdBody(skillMd)} />
    </Box>
  )
}

/** A line «what: value» of the card of a skill. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
      <Box component="span" sx={{ color: 'text.secondary' }}>
        {label}:{' '}
      </Box>
      {children}
    </Typography>
  )
}

/** «Открыть»: the card of a skill (Нв12) — source, version, license, size — its SKILL.md and files. */
export function ViewSkillDialog({
  skill,
  onClose,
}: {
  skill: AccountSkill | null
  onClose: () => void
}) {
  const trpc = useTRPC()
  const skillId = skill?.id ?? null
  const view = useQuery({
    ...trpc.accountSkills.view.queryOptions({ skillId: skillId ?? '' }),
    enabled: skillId !== null,
  })
  return (
    <SkillDialog
      open={skill !== null}
      onClose={onClose}
      title={skill ? text.viewTitle(skill.title) : ''}
      wide
      actions={<Button onClick={onClose}>{text.close}</Button>}
    >
      {skill ? (
        <>
          <Typography color="text.secondary">{nbsp(skill.summary ?? skill.description)}</Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
            <Fact label={text.source}>{skill.sourceLabel}</Fact>
            {skill.commit ? (
              <Fact label={text.version}>
                <Box component="span" sx={{ fontFamily: fontFamilies.mono }} translate="no">
                  {shortCommit(skill.commit)}
                </Box>
              </Fact>
            ) : null}
            {skill.license ? <Fact label={text.license}>{skill.license}</Fact> : null}
            {skill.sizeBytes > 0 ? (
              <Fact label={text.size}>{fileSizeText(skill.sizeBytes)}</Fact>
            ) : null}
          </Box>
          {skillId === null ? (
            <Typography variant="body2" color="text.secondary">
              {text.builtinFiles}
            </Typography>
          ) : view.isError ? (
            <Alert severity="error">{text.viewFailed}</Alert>
          ) : view.data ? (
            <>
              <SkillMd skillMd={view.data.skillMd} />
              <Box>
                <Typography component="h3" sx={{ fontWeight: 600, mb: 0.5 }}>
                  {text.files}
                </Typography>
                <Box component="ul" sx={{ m: 0, pl: 0, listStyle: 'none' }}>
                  {view.data.files.map((file) => (
                    <Box
                      component="li"
                      key={file.path}
                      sx={{
                        display: 'flex',
                        gap: 1,
                        justifyContent: 'space-between',
                        py: 0.25,
                        fontSize: 14,
                      }}
                    >
                      <Box
                        component="span"
                        translate="no"
                        sx={{
                          fontFamily: fontFamilies.mono,
                          overflowWrap: 'anywhere',
                          minWidth: 0,
                        }}
                      >
                        {file.path}
                        {file.executable ? (
                          <Box
                            component="span"
                            sx={{ color: 'text.secondary', fontFamily: 'inherit' }}
                          >
                            {` · ${text.executable}`}
                          </Box>
                        ) : null}
                      </Box>
                      <Box component="span" sx={{ color: 'text.secondary', flexShrink: 0 }}>
                        {fileSizeText(file.sizeBytes)}
                      </Box>
                    </Box>
                  ))}
                </Box>
              </Box>
            </>
          ) : (
            <Box role="status" aria-label={text.loading}>
              <Skeleton height={32} />
              <Skeleton height={32} />
              <Skeleton height={32} />
            </Box>
          )}
        </>
      ) : null}
    </SkillDialog>
  )
}

/** A list of paths under its head, when there are any. */
function Paths({ label, paths }: { label: string; paths: readonly string[] }) {
  if (paths.length === 0) return null
  return (
    <Box>
      <Typography component="h3" sx={{ fontWeight: 600 }}>
        {label}
      </Typography>
      <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
        {paths.map((path) => (
          <Box
            component="li"
            key={path}
            translate="no"
            sx={{ fontFamily: fontFamilies.mono, fontSize: 14, overflowWrap: 'anywhere' }}
          >
            {path}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

/**
 * «Обновить» (Нв11), keyed by the skill: the preview of the newest commit of the source, then the update to the commit
 * the client saw — not to whatever the source has by the time they confirm.
 */
export function UpdateSkillDialog({
  skill,
  onClose,
  onUpdated,
}: {
  skill: AccountSkill | null
  onClose: () => void
  onUpdated: (skill: AccountSkill) => void
}) {
  const trpc = useTRPC()
  const preview = useMutation(trpc.accountSkills.updatePreview.mutationOptions())
  const update = useMutation(trpc.accountSkills.update.mutationOptions())
  const [problem, setProblem] = useState<string | null>(null)
  const skillId = skill?.id ?? null
  // The page keys the dialog by the skill: every skill opens it anew, with nothing of the last.
  const { mutate: readPreview } = preview
  useEffect(() => {
    if (skillId !== null) readPreview({ skillId })
  }, [skillId, readPreview])
  const data = preview.data
  const confirm = async () => {
    if (skill === null || skillId === null || !data) return
    setProblem(null)
    try {
      await update.mutateAsync({ skillId, commit: data.commit })
      onUpdated(skill)
      onClose()
    } catch (failure) {
      setProblem(callErrorText(failure))
    }
  }
  const unchanged = data && data.added.length + data.changed.length + data.removed.length === 0
  return (
    <SkillDialog
      open={skill !== null}
      onClose={onClose}
      title={skill ? text.updateTitle(skill.title) : ''}
      busy={update.isPending}
      wide
      actions={
        <>
          <Button onClick={onClose} disabled={update.isPending}>
            {text.cancel}
          </Button>
          <Button
            variant="contained"
            disabled={!data}
            loading={update.isPending}
            onClick={() => void confirm()}
          >
            {text.update}
          </Button>
        </>
      }
    >
      {preview.isError ? (
        <Alert severity="error" role="alert">
          {callErrorText(preview.error)}
        </Alert>
      ) : data ? (
        <>
          {skill?.commit ? (
            <Typography variant="body2" color="text.secondary" translate="no">
              {shortCommit(skill.commit)} → {shortCommit(data.commit)}
            </Typography>
          ) : null}
          {unchanged ? <Typography color="text.secondary">{text.nothingChanged}</Typography> : null}
          <Paths label={text.added} paths={data.added} />
          <Paths label={text.changed} paths={data.changed} />
          <Paths label={text.removed} paths={data.removed} />
          <Typography component="h3" sx={{ fontWeight: 600 }}>
            {text.newSkillMd}
          </Typography>
          <SkillMd skillMd={data.skillMd} />
        </>
      ) : (
        <Box role="status" aria-label={text.updateLoading}>
          <Skeleton height={32} />
          <Skeleton height={32} />
        </Box>
      )}
      {problem ? (
        <Alert severity="error" role="alert">
          {problem}
        </Alert>
      ) : null}
    </SkillDialog>
  )
}

/** «Вернуть прошлую версию»: the versions kept (Нв: five), the newest first. */
export function HistorySkillDialog({
  skill,
  onClose,
  onRestored,
}: {
  skill: AccountSkill | null
  onClose: () => void
  onRestored: (skill: AccountSkill) => void
}) {
  const trpc = useTRPC()
  const restore = useMutation(trpc.accountSkills.restore.mutationOptions())
  const [problem, setProblem] = useState<string | null>(null)
  const back = async (versionId: string) => {
    if (skill?.id == null) return
    setProblem(null)
    try {
      await restore.mutateAsync({ skillId: skill.id, versionId })
      onRestored(skill)
      onClose()
    } catch (failure) {
      setProblem(callErrorText(failure))
    }
  }
  return (
    <SkillDialog
      open={skill !== null}
      onClose={() => {
        setProblem(null)
        onClose()
      }}
      title={skill ? text.historyTitle(skill.title) : ''}
      busy={restore.isPending}
      actions={
        <Button onClick={onClose} disabled={restore.isPending}>
          {text.close}
        </Button>
      }
    >
      {skill && skill.history.length === 0 ? (
        <Typography color="text.secondary">{text.historyEmpty}</Typography>
      ) : (
        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {skill?.history.map((version) => (
            <Box
              component="li"
              key={version.id}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                py: 1,
                borderTop: 1,
                borderColor: 'divider',
              }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography>{formatMoscowMoment(new Date(version.createdAt))}</Typography>
                {version.commit ? (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    translate="no"
                    sx={{ fontFamily: fontFamilies.mono }}
                  >
                    {shortCommit(version.commit)}
                  </Typography>
                ) : null}
              </Box>
              <Button
                size="small"
                variant="outlined"
                disabled={restore.isPending}
                onClick={() => void back(version.id)}
                sx={{ flexShrink: 0 }}
              >
                {text.restoreVersion}
              </Button>
            </Box>
          ))}
        </Box>
      )}
      {problem ? (
        <Alert severity="error" role="alert">
          {problem}
        </Alert>
      ) : null}
    </SkillDialog>
  )
}
