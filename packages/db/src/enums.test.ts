import { describe, expect, it } from 'vitest'

import {
  connectionTlsModes,
  consentDocumentTypes,
  databaseEngines,
  creditAccountUnits,
  gitProviderKinds,
  orderKinds,
  orderStatuses,
  provisioningStages,
  provisioningStageStatuses,
  siteSourceKinds,
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
  ConnectionTls,
  ConsentDocumentType,
  DatabaseEngine,
  GitProviderKind,
  OrderKind,
  OrderStatus,
  ProvisioningStage,
  ProvisioningStageStatus,
  SiteSourceKind,
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

  it('BillingUnit has the three credit accounts of the domain and the rouble wallet', () => {
    // In the order of the database type, which is the order the labels were added in:
    // credit_pack after rub, credit_gift last. Credits are spent in another order, the one of
    // creditAccountKinds.
    expect(Object.values(BillingUnit)).toEqual([
      creditAccountUnits.tariff,
      'rub',
      creditAccountUnits.pack,
      creditAccountUnits.gift,
    ])
    expect(Object.values(creditAccountUnits)).toEqual([
      'credit_tariff',
      'credit_gift',
      'credit_pack',
    ])
  })

  it('SiteSourceKind has exactly the kinds of a site code source', () => {
    expect(Object.values(SiteSourceKind)).toEqual([...siteSourceKinds])
  })

  it('DatabaseEngine has exactly the engines of a site database', () => {
    expect(Object.values(DatabaseEngine)).toEqual([...databaseEngines])
  })

  it('ConnectionTls has exactly the protection modes of a connection', () => {
    expect(Object.values(ConnectionTls)).toEqual([...connectionTlsModes])
  })

  it('ProvisioningStage has exactly the stages of a site connection', () => {
    expect(Object.values(ProvisioningStage)).toEqual([...provisioningStages])
  })

  it('ProvisioningStageStatus has exactly the statuses of a stage', () => {
    expect(Object.values(ProvisioningStageStatus)).toEqual([...provisioningStageStatuses])
  })
})
