import { describe, expect, it } from 'vitest'

import {
  consentDocumentTypes,
  gitProviderKinds,
  siteStacks,
  taskStatuses,
  turnResultSchema,
} from '@repo/domain'
import { ChangeType, ConsentDocumentType, GitProviderKind, SiteStack, TaskStatus } from './index.ts'

describe('database enums match the domain', () => {
  it('TaskStatus has exactly the statuses of spec §7', () => {
    expect(Object.values(TaskStatus)).toEqual([...taskStatuses])
  })

  it('ConsentDocumentType has exactly the domain consent document types', () => {
    expect(Object.values(ConsentDocumentType)).toEqual([...consentDocumentTypes])
  })

  it('SiteStack has exactly the site adapter stacks', () => {
    expect(Object.values(SiteStack)).toEqual([...siteStacks])
  })

  it('GitProviderKind has exactly the git provider kinds', () => {
    expect(Object.values(GitProviderKind)).toEqual([...gitProviderKinds])
  })

  it('ChangeType has exactly the change types of the turn result', () => {
    expect(Object.values(ChangeType)).toEqual([...turnResultSchema.shape.change_type.options])
  })
})
