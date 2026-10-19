import { describe, expect, it } from 'vitest'

import { isTooLarge } from '../errors.ts'
import type { SiteFacts } from '../ports/site-adapter.ts'
import {
  agentWorkingSetSchema,
  isWorkingSetTooLarge,
  siteWorkspaceRules,
  WORKING_SET_MAX_BYTES,
  workingSetCommitMessage,
  workingSetMatcher,
  workingSetTooLarge,
} from './working-set.ts'

const set = {
  include: ['/wp-content/themes/', '/*'],
  exclude: ['/wp-*.php', '*.sql'],
  maxBytes: WORKING_SET_MAX_BYTES,
}

describe('the agent working set', () => {
  it('takes a file an include matches and no exclude does', () => {
    const inSet = workingSetMatcher(set)
    expect(inSet('wp-content/themes/shop/style.css')).toBe(true)
    expect(inSet('robots.txt')).toBe(true)
    expect(inSet('wp-login.php')).toBe(false)
    expect(inSet('wp-content/themes/shop/dump.sql')).toBe(false)
    expect(inSet('wp-includes/version.php')).toBe(false)
  })

  it('leaves out dumps and secrets in any letter case, and takes includes as written', () => {
    const inSet = workingSetMatcher({ ...set, include: [...set.include, '/wp-content/plugins/'] })
    expect(inSet('wp-content/themes/shop/BACKUP.SQL')).toBe(false)
    expect(inSet('WP-LOGIN.PHP')).toBe(false)
    expect(inSet('WP-CONTENT/themes/shop/style.css')).toBe(false)
    expect(inSet('wp-content/Plugins/x.php')).toBe(false)
  })

  it('refuses patterns it cannot read and a limit above the sandbox one', () => {
    expect(agentWorkingSetSchema.safeParse(set).success).toBe(true)
    expect(agentWorkingSetSchema.safeParse({ ...set, include: ['!/x'] }).success).toBe(false)
    expect(agentWorkingSetSchema.safeParse({ ...set, exclude: ['/a/[b]'] }).success).toBe(false)
    expect(
      agentWorkingSetSchema.safeParse({ ...set, maxBytes: WORKING_SET_MAX_BYTES + 1 }).success,
    ).toBe(false)
  })

  it('is a 413 told apart by its reason', () => {
    const error = workingSetTooLarge()
    expect(isTooLarge(error)).toBe(true)
    expect(isWorkingSetTooLarge(error)).toBe(true)
    expect(isWorkingSetTooLarge(new Error('x'))).toBe(false)
  })

  it('names the full commit in the message of its root commit', () => {
    expect(workingSetCommitMessage('a'.repeat(40))).toBe(
      `Raditi working set of ${'a'.repeat(40)}\n\nRaditi-Base: ${'a'.repeat(40)}\n`,
    )
  })

  it('gives a turn every rule of the adapter at once', () => {
    const site = { id: 's', stack: 'wordpress' } as unknown as SiteFacts
    const rules = siteWorkspaceRules(
      {
        protectedPaths: () => ['wp-config.php'],
        agentWorkingSet: () => set,
        mediaRules: () => ({
          addOnlyPaths: ['wp-content/uploads/raditi/'],
          extensions: { png: [{ offset: 0, hex: '89504e47' }] },
          refusedNameParts: ['.php'],
          maxFileBytes: 1024,
        }),
      },
      site,
    )
    expect(rules).toEqual({
      protectedPaths: ['wp-config.php'],
      workingSet: set,
      addOnlyPaths: ['wp-content/uploads/raditi/'],
      media: {
        extensions: { png: [{ offset: 0, hex: '89504e47' }] },
        refusedNameParts: ['.php'],
        maxFileBytes: 1024,
      },
    })
  })
})
