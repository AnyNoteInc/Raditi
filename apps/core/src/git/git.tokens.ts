/** The jobs of the queue `git` (GitJobs). */
export const GIT_JOBS = Symbol('GIT_JOBS')

export const GIT_QUEUE = 'git'

/** The presses of the client on cards of a repository (RepoActions, `git.action`). */
export const REPO_ACTIONS = Symbol('REPO_ACTIONS')

/** The builds and logs of repositories (RepoCi: `git.poll`, `git.log`, `git.repo.deploy_actions`). */
export const REPO_CI = Symbol('REPO_CI')
