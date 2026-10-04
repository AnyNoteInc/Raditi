import { describe, expect, it } from 'vitest'

import {
  consentDocumentTypes,
  editAccountUnits,
  gitProviderKinds,
  orderKinds,
  orderStatuses,
  siteStacks,
  subscriptionStatuses,
  taskStatuses,
  turnAssignmentOutcomes,
  turnExecutorKinds,
  turnResultSchema,
} from '@repo/domain'
import {
  BillingUnit,
  ChangeType,
  ConsentDocumentType,
  GitProviderKind,
  OrderKind,
  OrderStatus,
  SiteStack,
  SubscriptionStatus,
  TaskStatus,
  TurnAssignmentOutcome,
  TurnExecutorKind,
} from './index.ts'

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

  it('TurnExecutorKind and TurnAssignmentOutcome match the turn assignment port', () => {
    expect(Object.values(TurnExecutorKind)).toEqual([...turnExecutorKinds])
    expect(Object.values(TurnAssignmentOutcome)).toEqual([...turnAssignmentOutcomes])
  })

  it('SubscriptionStatus, OrderKind and OrderStatus match the billing statuses', () => {
    expect(Object.values(SubscriptionStatus)).toEqual([...subscriptionStatuses])
    expect(Object.values(OrderKind)).toEqual([...orderKinds])
    expect(Object.values(OrderStatus)).toEqual([...orderStatuses])
  })

  it('BillingUnit has the two edit accounts of the domain and the rouble wallet', () => {
    // In the order of the database type: edit_pack was added after rub.
    expect(Object.values(BillingUnit)).toEqual([
      editAccountUnits.tariff,
      'rub',
      editAccountUnits.pack,
    ])
  })
})
