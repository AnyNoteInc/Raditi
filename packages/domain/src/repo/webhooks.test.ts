import { describe, expect, it } from 'vitest'

import { rerunIsDeploy, rerunPassedRepeatsJobs, repoRunTexts } from './index.ts'

type Run = Parameters<typeof rerunPassedRepeatsJobs>[0]

// The conditions of the cards of «Запустить снова» (docs/plan/84-projects.md, ПР15, ПР36): which
// rerun is a card of a deploy, and which plain card of a build that passed warns that its rerun
// repeats every automatic job, a deploy without a manual start included.

const run = (over: Partial<Run> = {}): Run => ({
  ref: 'staging',
  defaultBranch: 'main',
  event: 'push',
  manualJobs: false,
  status: 'success',
  ...over,
})

describe('rerunIsDeploy (ПР15)', () => {
  it('the main branch, a manual job and a workflow started by hand make a card of a deploy', () => {
    expect(rerunIsDeploy(run())).toBe(false)
    expect(rerunIsDeploy(run({ ref: 'main' }))).toBe(true)
    expect(rerunIsDeploy(run({ manualJobs: true }))).toBe(true)
    expect(rerunIsDeploy(run({ event: 'workflow_dispatch' }))).toBe(true)
  })
})

describe('rerunPassedRepeatsJobs (ПР36)', () => {
  it('a build of a plain branch that passed warns that every automatic job runs again', () => {
    expect(rerunPassedRepeatsJobs(run())).toBe(true)
  })
  it('a build that did not pass does not warn', () => {
    for (const status of ['pending', 'running', 'manual', 'failed', 'canceled', 'skipped'] as const)
      expect(rerunPassedRepeatsJobs(run({ status }))).toBe(false)
  })
  it('a card of a deploy says it in its own words and does not warn twice', () => {
    expect(rerunPassedRepeatsJobs(run({ ref: 'main' }))).toBe(false)
    expect(rerunPassedRepeatsJobs(run({ manualJobs: true }))).toBe(false)
    expect(rerunPassedRepeatsJobs(run({ event: 'workflow_dispatch' }))).toBe(false)
  })
  it('the words of the warning are Russian and on «вы»', () => {
    expect(repoRunTexts.rerunPassedWarning).toMatch(/[а-яё]/)
    expect(repoRunTexts.rerunPassedWarning).toMatch(/вы/)
    expect(repoRunTexts.rerunBody).toMatch(/[а-яё]/)
  })
})
