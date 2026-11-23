import { vi } from 'vitest'

// The procedures of the repository of a project, as the tests of the components mock
// `@/trpc/client` (docs/plan/84-projects.md, 84.17): every call answers what `answers` says.

export interface RepoAnswers {
  get?: (input: { projectId: string }) => unknown
  list?: () => unknown
  repositories?: (input: { connectionId: string; query?: string }) => unknown
  branches?: (input: { connectionId: string; providerRepoId: string }) => unknown
  attach?: (input: unknown) => unknown
  addToken?: (input: unknown) => unknown
  detach?: (input: unknown) => unknown
  retry?: (input: unknown) => unknown
  refresh?: (input: unknown) => unknown
  runs?: (input: { projectId: string }) => unknown
  artifacts?: (input: { projectId: string }) => unknown
}

const query = (key: string, fn: (input: never) => unknown) => ({
  queryOptions: (input?: unknown) => ({
    queryKey: [key, input],
    queryFn: async () => fn(input as never),
  }),
})
const mutation = (fn: (input: never) => unknown) => ({
  mutationOptions: () => ({ mutationFn: fn }),
})

export function repoTrpc(answers: RepoAnswers = {}) {
  return {
    // «Артефакты проекта» of «Контекст» (docs/plan/88-artifacts.md, Ар42): none here.
    artifact: { list: query('artifact.list', answers.artifacts ?? (() => [])) },
    projectRepo: {
      pathKey: () => ['projectRepo'],
      get: query('projectRepo.get', answers.get ?? (() => null)),
      branches: query(
        'projectRepo.branches',
        answers.branches ?? (() => ({ state: 'ready', names: ['main'] })),
      ),
      attach: mutation(answers.attach ?? vi.fn(async () => ({ projectRepositoryId: 'x' }))),
      detach: mutation(answers.detach ?? vi.fn(async () => ({ detached: true }))),
      retry: mutation(answers.retry ?? vi.fn(async () => ({ queued: true }))),
      runs: query(
        'projectRepo.runs',
        answers.runs ?? (() => ({ items: [], next: null, polledAt: null, refreshing: false })),
      ),
      // `@` over the paths of the repository (ПР24; slice 84.26).
      paths: query('projectRepo.paths', () => ({ state: 'none' })),
    },
    gitConnection: {
      pathKey: () => ['gitConnection'],
      list: query(
        'gitConnection.list',
        answers.list ??
          (() => ({
            connections: [],
            available: { github: false, gitlabCom: false, ownServer: true },
          })),
      ),
      repositories: query(
        'gitConnection.repositories',
        answers.repositories ?? (() => ({ state: 'ready', reason: null, items: [] })),
      ),
      addToken: mutation(answers.addToken ?? vi.fn(async () => ({ connectionId: 'c' }))),
      refresh: mutation(answers.refresh ?? vi.fn(async () => ({ queued: true }))),
    },
  }
}
