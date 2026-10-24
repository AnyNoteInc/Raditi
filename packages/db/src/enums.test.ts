import { describe, expect, it } from 'vitest'

import {
  attachmentStatuses,
  browserCheckpointStates,
  browserControllers,
  browserSessionStatuses,
  candidateCheckStatuses,
  candidateStatuses,
  connectionTlsModes,
  consentDocumentTypes,
  databaseEngines,
  creditAccountUnits,
  dbJournalKinds,
  deployMethods,
  gitProviderKinds,
  orderKinds,
  orderStatuses,
  previewDbModes,
  previewStatuses,
  provisioningStages,
  provisioningStageStatuses,
  releaseKinds,
  releaseStatuses,
  siteSourceKinds,
  siteStacks,
  subscriptionStatuses,
  taskModes,
  taskStatuses,
  taskWaitingReasons,
  turnAssignmentOutcomes,
  turnExecutorKinds,
  turnResultSchema,
  undoPlanStatuses,
  versionBumps,
} from '@repo/domain'
import {
  AttachmentStatus,
  BillingUnit,
  BrowserCheckpointState,
  BrowserController,
  BrowserSessionStatus,
  CandidateCheckStatus,
  CandidateStatus,
  ChangeType,
  ConnectionTls,
  ConsentDocumentType,
  DatabaseEngine,
  DbOperationKind,
  DeployMethod,
  GitProviderKind,
  OrderKind,
  OrderStatus,
  PreviewDbMode,
  PreviewStatus,
  ProvisioningStage,
  ProvisioningStageStatus,
  ReleaseKind,
  ReleaseStatus,
  SiteSourceKind,
  SiteStack,
  SubscriptionStatus,
  TaskMode,
  TaskStatus,
  TaskWaiting,
  TurnAssignmentOutcome,
  TurnExecutorKind,
  UndoPlanStatus,
  VersionBump,
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

  it('TaskMode and TaskWaiting match the head of a task in the feed', () => {
    expect(Object.values(TaskMode)).toEqual([...taskModes])
    expect(Object.values(TaskWaiting)).toEqual([...taskWaitingReasons])
  })

  it('PreviewStatus and PreviewDbMode match the preview state of the domain', () => {
    expect(Object.values(PreviewStatus)).toEqual([...previewStatuses])
    expect(Object.values(PreviewDbMode)).toEqual([...previewDbModes])
  })

  it('CandidateStatus and CandidateCheckStatus match the candidate of the domain', () => {
    expect(Object.values(CandidateStatus)).toEqual([...candidateStatuses])
    expect(Object.values(CandidateCheckStatus)).toEqual([...candidateCheckStatuses])
  })

  it('ReleaseStatus, VersionBump and DbOperationKind match the release of the domain', () => {
    expect(Object.values(ReleaseStatus)).toEqual([...releaseStatuses])
    expect(Object.values(VersionBump)).toEqual([...versionBumps])
    expect(Object.values(DbOperationKind)).toEqual([...dbJournalKinds])
    expect(Object.values(ReleaseKind)).toEqual([...releaseKinds])
    expect(Object.values(UndoPlanStatus)).toEqual([...undoPlanStatuses])
  })

  it('DeployMethod has the methods of a deploy, sftp and ftp last', () => {
    expect(Object.values(DeployMethod)).toEqual([...deployMethods])
  })

  it('AttachmentStatus has exactly the statuses of an attachment', () => {
    expect(Object.values(AttachmentStatus)).toEqual([...attachmentStatuses])
  })

  it('BrowserSessionStatus, BrowserController and BrowserCheckpointState match the browser of a task', () => {
    expect(Object.values(BrowserSessionStatus)).toEqual([...browserSessionStatuses])
    expect(Object.values(BrowserController)).toEqual([...browserControllers])
    expect(Object.values(BrowserCheckpointState)).toEqual([...browserCheckpointStates])
  })
})
