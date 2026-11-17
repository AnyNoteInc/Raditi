'use client'

import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'

import type { ComposerMentions } from '@/components/chat/composer'
import { useTRPC } from '@/trpc/client'

import { contextText } from './project-texts'

/**
 * Where the files of the context lie for the agent in every turn (ПР8): `SANDBOX_PROJECT` of the
 * domain and a slash — a test holds the two together; the root of `@repo/domain` is not for pages.
 */
export const CONTEXT_MENTION_ROOT = '/workspace/project/'

/**
 * Where the repository of a project is checked out for the agent: `SANDBOX_WORKDIR` of the domain
 * and a slash, held together by the same test (ПР24; slice 84.26).
 */
export const REPO_MENTION_ROOT = '/workspace/repo/'

/** The folder both roots lie in. */
const WORKSPACE = '/workspace/'

/** While core reads the paths of the repository, `@` asks again this often, this many times. */
const REPO_PATHS_AGAIN_MS = 2_000
const REPO_PATHS_TRIES = 30

/**
 * `@` in a chat of a project names the files of its context (docs/plan/84-projects.md, ПР24): the
 * dormant hook of plan 78 (`ComposerMentions`). The list is read when `@` is first typed, not
 * before; the choice puts `@/workspace/project/<path>` into the words — where the agent finds the
 * file. Since 84.26 it names the paths of the main branch of the project's repository too, from
 * the list core keeps (`projectRepo.paths`): `@/workspace/repo/<path>`. A chat without a project has no list: undefined, and
 * `@` is just a letter.
 */
export function useContextMentions(projectId: string | null): ComposerMentions | undefined {
  const trpc = useTRPC()
  const [asked, setAsked] = useState(false)
  const files = useQuery({
    ...trpc.projectFile.list.queryOptions({ projectId: projectId ?? '' }),
    enabled: projectId !== null && asked,
  })
  const repo = useQuery({
    ...trpc.projectRepo.paths.queryOptions({ projectId: projectId ?? '' }),
    enabled: projectId !== null && asked,
    refetchInterval: (query) =>
      query.state.data?.state === 'loading' && query.state.dataUpdateCount < REPO_PATHS_TRIES
        ? REPO_PATHS_AGAIN_MS
        : false,
  })
  const onOpen = useCallback(() => setAsked(true), [])
  // Without paths of a repository the list is the context's alone, below its own root; with them
  // it is two folders below `/workspace/` — `project/…` and `repo/…` — so the roots stay apart.
  const listed = useMemo(() => {
    if (!files.data) return null
    const own = files.data.files.map((file) => file.name)
    const data = repo.data
    // A failed read of the repository's paths leaves the context's own.
    if (data === undefined && !repo.error) return null
    if (data?.state !== 'ready' || data.paths.length === 0)
      return { paths: own, root: CONTEXT_MENTION_ROOT }
    return {
      paths: [
        ...own.map((name) => `${CONTEXT_MENTION_ROOT.slice(WORKSPACE.length)}${name}`),
        ...data.paths.map((path) => `${REPO_MENTION_ROOT.slice(WORKSPACE.length)}${path}`),
      ],
      root: WORKSPACE,
    }
  }, [files.data, repo.data, repo.error])
  const paths = listed?.paths ?? null
  const repoLoading = repo.data?.state === 'loading'
  return useMemo(() => {
    if (projectId === null) return undefined
    return {
      paths: paths !== null && paths.length > 0 ? paths : null,
      state:
        paths === null || (paths.length === 0 && repoLoading)
          ? 'preparing'
          : paths.length === 0
            ? 'none'
            : 'ready',
      onOpen,
      root: listed?.root ?? CONTEXT_MENTION_ROOT,
      texts: { label: contextText.mentionLabel, none: contextText.mentionNone },
    }
  }, [projectId, paths, listed?.root, repoLoading, onOpen])
}
