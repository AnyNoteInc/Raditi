// An in-memory SiteImportStore for the unit tests of the site import: one code_import row per
// site with the semantics of PostgresSiteImportStore (claim, fence, requeue, release, sweep).
// The SQL itself is pinned by stage-store.integration.test.ts. Only for *.test.ts files.
import { randomUUID } from 'node:crypto'

import {
  provisioningLimits,
  type ProvisioningErrorCode,
  type ProvisioningStageStatus,
  type ProvisioningStageSummary,
  type ProvisioningStep,
  type SiteStack,
} from '@repo/domain'

import { LeaseLost, refuse } from '../site-provisioning/import-failure.ts'
import type {
  ClaimResult,
  InitialVersionPlan,
  RecordedRepository,
  RequeueOutcome,
  SiteImportStore,
  StageLease,
  StoredAccess,
  SweptStage,
} from '../site-provisioning/stage-store.ts'

export interface FakeStage {
  siteId: string
  workspaceId: string
  siteStatus: string
  stack: SiteStack
  url: string
  status: ProvisioningStageStatus
  attempt: number
  enqueues: number
  leaseEpoch: number
  step: ProvisioningStep | null
  errorCode: ProvisioningErrorCode | null
  summary: ProvisioningStageSummary | null
  /** Milliseconds; the sweep compares them with `now`. */
  heartbeatAt: number | null
  updatedAt: number
  finished: boolean
}

export interface FakeOutboxEvent {
  siteId: string
  attempt: number
  enqueues: number
  availableAt: number
}

export class FakeSiteImportStore implements SiteImportStore {
  readonly stages = new Map<string, FakeStage>()
  readonly access = new Map<string, StoredAccess>()
  readonly plans = new Map<string, InitialVersionPlan>()
  readonly repositories = new Map<string, RecordedRepository & { id: string; siteId: string }>()
  readonly outbox: FakeOutboxEvent[] = []
  readonly heartbeats: StageLease[] = []
  now = () => Date.now()
  /** Makes the next call of a method throw, as a database that went away. */
  readonly failing = new Set<keyof SiteImportStore>()

  add(stage: Partial<FakeStage> & { siteId: string }): FakeStage {
    const row: FakeStage = {
      workspaceId: randomUUID(),
      siteStatus: 'onboarding',
      stack: 'wordpress',
      url: 'https://site.example.test',
      status: 'queued',
      attempt: 1,
      enqueues: 1,
      leaseEpoch: 0,
      step: null,
      errorCode: null,
      summary: null,
      heartbeatAt: null,
      updatedAt: this.now(),
      finished: false,
      ...stage,
    }
    this.stages.set(row.siteId, row)
    return row
  }

  stage(siteId: string): FakeStage {
    const row = this.stages.get(siteId)
    if (!row) throw new Error(`No stage of ${siteId}`)
    return row
  }

  #maybeFail(method: keyof SiteImportStore): void {
    if (this.failing.delete(method)) throw new Error('connect ECONNREFUSED')
  }

  #held(lease: StageLease): FakeStage {
    const row = this.stages.get(lease.siteId)
    if (!row || row.status !== 'running' || row.leaseEpoch !== lease.leaseEpoch || row.finished)
      throw new LeaseLost()
    return row
  }

  #finish(row: FakeStage, status: 'succeeded' | 'failed', code: ProvisioningErrorCode | null) {
    row.status = status
    row.errorCode = code
    row.finished = true
    row.step = null
    row.heartbeatAt = null
    row.updatedAt = this.now()
  }

  #requeue(row: FakeStage, code: ProvisioningErrorCode, delayMs: number): RequeueOutcome {
    if (row.enqueues >= provisioningLimits.enqueuesPerAttempt) {
      this.#finish(row, 'failed', code)
      return 'failed'
    }
    row.status = 'queued'
    row.enqueues += 1
    row.step = null
    row.heartbeatAt = null
    row.updatedAt = this.now()
    this.outbox.push({
      siteId: row.siteId,
      attempt: row.attempt,
      enqueues: row.enqueues,
      availableAt: this.now() + delayMs,
    })
    return 'requeued'
  }

  async claim(siteId: string): Promise<ClaimResult> {
    this.#maybeFail('claim')
    const row = this.stages.get(siteId)
    if (!row || row.finished || row.status !== 'queued') return { kind: 'idle' }
    if (row.siteStatus !== 'onboarding') {
      this.#finish(row, 'failed', 'access_refused')
      return { kind: 'refused', workspaceId: row.workspaceId, leaseEpoch: row.leaseEpoch }
    }
    const running = [...this.stages.values()].filter(
      (other) =>
        other.workspaceId === row.workspaceId && other.status === 'running' && !other.finished,
    ).length
    if (running >= provisioningLimits.importsPerWorkspace) return { kind: 'busy' }
    row.status = 'running'
    row.leaseEpoch += 1
    row.heartbeatAt = this.now()
    row.step = 'fetch'
    row.updatedAt = this.now()
    return {
      kind: 'claimed',
      stage: {
        siteId,
        workspaceId: row.workspaceId,
        stack: row.stack,
        url: row.url,
        attempt: row.attempt,
        enqueues: row.enqueues,
        leaseEpoch: row.leaseEpoch,
      },
    }
  }

  async heartbeat(lease: StageLease): Promise<boolean> {
    this.#maybeFail('heartbeat')
    this.heartbeats.push(lease)
    try {
      this.#held(lease).heartbeatAt = this.now()
      return true
    } catch {
      return false
    }
  }

  async setStep(lease: StageLease, step: ProvisioningStep): Promise<void> {
    this.#maybeFail('setStep')
    this.#held(lease).step = step
  }

  async readAccess(lease: StageLease): Promise<StoredAccess> {
    this.#maybeFail('readAccess')
    const row = this.#held(lease)
    const stored = this.access.get(lease.siteId)
    if (!stored) throw refuse('access_missing')
    return { ...stored, siteStatus: row.siteStatus }
  }

  async recordRepository(lease: StageLease, repository: RecordedRepository): Promise<string> {
    this.#maybeFail('recordRepository')
    this.#held(lease)
    const key = `${repository.provider}/${repository.owner}/${repository.name}`
    const existing = this.repositories.get(key)
    if (existing) {
      if (existing.siteId !== lease.siteId) throw refuse('repository_not_created')
      existing.url = repository.url
      return existing.id
    }
    const id = randomUUID()
    this.repositories.set(key, { ...repository, id, siteId: lease.siteId })
    return id
  }

  async readPlan(siteId: string): Promise<InitialVersionPlan | null> {
    this.#maybeFail('readPlan')
    const plan = this.plans.get(siteId)
    return plan ? { ...plan } : null
  }

  async recordPlan(
    lease: StageLease,
    plan: { gitRepositoryId: string; commitSha: string; files: number; bytes: number },
    summary: ProvisioningStageSummary,
  ): Promise<void> {
    this.#maybeFail('recordPlan')
    const row = this.#held(lease)
    const existing = this.plans.get(lease.siteId)
    if (existing?.importedAt) throw refuse('repository_mismatch')
    this.plans.set(lease.siteId, { ...plan, leaseEpoch: lease.leaseEpoch, importedAt: null })
    row.summary = summary
  }

  async succeed(lease: StageLease, commitSha: string): Promise<void> {
    this.#maybeFail('succeed')
    const row = this.#held(lease)
    const plan = this.plans.get(lease.siteId)
    if (!plan || plan.commitSha !== commitSha) throw refuse('repository_mismatch')
    plan.importedAt ??= new Date(this.now())
    this.#finish(row, 'succeeded', null)
  }

  async fail(lease: StageLease, code: ProvisioningErrorCode): Promise<void> {
    this.#maybeFail('fail')
    this.#finish(this.#held(lease), 'failed', code)
  }

  async retry(
    lease: StageLease,
    code: ProvisioningErrorCode,
    delayMs: number,
  ): Promise<RequeueOutcome> {
    this.#maybeFail('retry')
    return this.#requeue(this.#held(lease), code, delayMs)
  }

  async release(lease: StageLease): Promise<RequeueOutcome> {
    this.#maybeFail('release')
    return this.#requeue(this.#held(lease), 'interrupted', provisioningLimits.releaseDelayMs)
  }

  async nextQueued(
    workspaceId: string,
    exceptSiteId: string,
  ): Promise<{ siteId: string; attempt: number } | null> {
    this.#maybeFail('nextQueued')
    const next = [...this.stages.values()]
      .filter(
        (row) =>
          row.workspaceId === workspaceId &&
          row.siteId !== exceptSiteId &&
          row.status === 'queued' &&
          !row.finished,
      )
      .sort((a, b) => a.updatedAt - b.updatedAt)[0]
    return next ? { siteId: next.siteId, attempt: next.attempt } : null
  }

  async sweepSilent(): Promise<{ requeued: SweptStage[]; interrupted: SweptStage[] }> {
    this.#maybeFail('sweepSilent')
    const requeued: SweptStage[] = []
    const interrupted: SweptStage[] = []
    for (const row of this.stages.values()) {
      if (row.finished || row.status !== 'running' || row.heartbeatAt === null) continue
      if (row.heartbeatAt >= this.now() - provisioningLimits.staleMs) continue
      const outcome = this.#requeue(row, 'interrupted', 0)
      const swept = {
        siteId: row.siteId,
        workspaceId: row.workspaceId,
        attempt: row.attempt,
        enqueues: row.enqueues,
        leaseEpoch: row.leaseEpoch,
      }
      ;(outcome === 'requeued' ? requeued : interrupted).push(swept)
    }
    return { requeued, interrupted }
  }

  async waiting(): Promise<{ siteId: string; attempt: number }[]> {
    this.#maybeFail('waiting')
    return [...this.stages.values()]
      .filter(
        (row) =>
          !row.finished &&
          row.status === 'queued' &&
          row.updatedAt < this.now() - provisioningLimits.queuedStaleMs,
      )
      .map((row) => ({ siteId: row.siteId, attempt: row.attempt }))
  }
}
