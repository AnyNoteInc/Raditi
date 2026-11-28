import { describe, expect, it } from 'vitest'

import {
  agentSkillAuthKinds,
  agentSkillAuthStates,
  attachmentStatuses,
  browserCheckpointStates,
  browserControllers,
  browserSessionStatuses,
  consentDocumentTypes,
  creditAccountUnits,
  orderKinds,
  orderStatuses,
  subscriptionStatuses,
  taskKinds,
  taskStatuses,
  taskWaitingReasons,
  todoTurnStatuses,
  turnAssignmentOutcomes,
  turnExecutorKinds,
  turnResultSchema,
} from '@repo/domain'
import { quickEditStates } from '@repo/domain/artifacts'
import {
  AgentSkillAuthKind,
  ArtifactQuickEditState,
  AgentSkillAuthState,
  AttachmentStatus,
  BillingUnit,
  BrowserCheckpointState,
  BrowserController,
  BrowserSessionStatus,
  ChangeType,
  ConsentDocumentType,
  OrderKind,
  OrderStatus,
  SubscriptionStatus,
  TaskKind,
  TaskStatus,
  TaskWaiting,
  TurnAssignmentOutcome,
  TurnExecutorKind,
  TurnStatus,
} from './index.ts'

describe('database enums match the domain', () => {
  it('TaskStatus has exactly the statuses of spec §7', () => {
    expect(Object.values(TaskStatus)).toEqual([...taskStatuses])
  })

  it('TaskKind and ArtifactQuickEditState match quick edits (plan 98)', () => {
    expect(Object.values(TaskKind)).toEqual([...taskKinds])
    expect(Object.values(ArtifactQuickEditState)).toEqual([...quickEditStates])
  })

  it('ConsentDocumentType has exactly the domain consent document types', () => {
    expect(Object.values(ConsentDocumentType)).toEqual([...consentDocumentTypes])
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

  it('TurnStatus has exactly the statuses of a turn the plan of the agent reads', () => {
    expect(Object.values(TurnStatus)).toEqual([...todoTurnStatuses])
  })

  it('TaskWaiting matches the head of a task in the feed', () => {
    expect(Object.values(TaskWaiting)).toEqual([...taskWaitingReasons])
  })

  it('AttachmentStatus has exactly the statuses of an attachment', () => {
    expect(Object.values(AttachmentStatus)).toEqual([...attachmentStatuses])
  })

  it('BrowserSessionStatus, BrowserController and BrowserCheckpointState match the browser of a task', () => {
    expect(Object.values(BrowserSessionStatus)).toEqual([...browserSessionStatuses])
    expect(Object.values(BrowserController)).toEqual([...browserControllers])
    expect(Object.values(BrowserCheckpointState)).toEqual([...browserCheckpointStates])
  })

  it('AgentSkillAuthKind and AgentSkillAuthState match the authorization of an MCP server', () => {
    expect(Object.values(AgentSkillAuthKind)).toEqual([...agentSkillAuthKinds])
    expect(Object.values(AgentSkillAuthState)).toEqual([...agentSkillAuthStates])
  })
})
