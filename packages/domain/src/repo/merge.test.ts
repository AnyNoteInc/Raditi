import { describe, expect, it } from 'vitest'

import { repoActionArgsSchema, repoPushRefusalTexts } from './actions.ts'
import { repoMergeArgsSchema, repoMergeTexts, repoProviderOffers } from './merge.ts'

// «Принять в основную ветку» and «Выкатить» (docs/plan/84-projects.md, ПР15; slice 84.22).
describe('merge and deploy of a repository', () => {
  it('keeps the choice of the merge card with the token, and only that', () => {
    const token = 'claims.mac'
    expect(
      repoActionArgsSchema.parse({
        token,
        mergeRequest: null,
        merge: { mode: 'when_green', deleteBranch: true },
      }).merge,
    ).toEqual({ mode: 'when_green', deleteBranch: true })
    // Rows of 84.19 and 84.20 carry no `merge`.
    expect(repoActionArgsSchema.parse({ token, mergeRequest: null }).merge).toBeUndefined()
    expect(repoMergeArgsSchema.safeParse({ mode: 'squash', deleteBranch: true }).success).toBe(
      false,
    )
    expect(
      repoMergeArgsSchema.safeParse({ mode: 'now', deleteBranch: true, force: true }).success,
    ).toBe(false)
  })

  it('says its refusals in the client’s words and promises no rollback', () => {
    for (const code of ['REPO_MR_TARGET_CHANGED', 'REPO_AUTO_MERGE_OFF', 'REPO_DEPLOY_GONE'])
      expect(repoPushRefusalTexts).toHaveProperty(code)
    // The review's fix of P-chat-merge: the build of the client is not read by the platform.
    expect(repoMergeTexts.afterMerge).toContain('может выкатить изменения — так, как она настроена')
    expect(repoMergeTexts.afterMerge).not.toMatch(/выкатит сайт/)
    expect(repoMergeTexts.deployBody).toContain('Отката платформа не делает')
  })

  it('offers a wait for the build and manual jobs only where the provider has them', () => {
    expect(repoProviderOffers.gitlab).toEqual({ autoMerge: true, manualJobs: true })
    expect(repoProviderOffers.github).toEqual({ autoMerge: false, manualJobs: false })
  })
})
