import type { Prisma, PrismaClient } from '@repo/db'
import {
  badRequest,
  conflict,
  crossBorderNotCleared,
  DomainError,
  envVarLimits,
  envVarNameProblem,
  envVarReachesAgent,
  envVarValueSchema,
  isDomainError,
  leaseLost,
  llmGatewayUnavailable,
  llmPriceMissing,
  pickAccount,
  poolPolicy,
  subscriptionBusy,
  subscriptionWait,
  turnCredentialExpiresAt,
  turnCredentialGrantSchema,
  turnKeyBudgetVerdict,
  TURN_FINALIZE_RESERVE_MS,
  TURN_PUBLICATION_GRACE_MS,
  type AttemptBudgetInput,
  type LlmBackendId,
  type LlmCapacity,
  type PoolAccountSnapshot,
  type PoolDecision,
  type SecretStore,
  type TurnCredentialGrant,
  type TurnCredentialRef,
  type TurnCredentialSource,
  type TurnCredentialValues,
} from '@repo/domain'
import { z } from 'zod'

import { decodeLimitWindows, policyFlaggedEvent } from './gateway-types.ts'
import {
  readSiteEnvValues,
  readSiteEnvValuesToRefuse,
  type SiteEnvVarVersion,
} from './site-env-values.ts'
import {
  LLM_KEY_PATTERN,
  lockSubscriptionPool,
  MCP_TOKEN_PATTERN,
  newTurnKeys,
  turnCredentialPath,
  turnCredentialRefSchema,
  turnKeyHash,
} from './turn-key.ts'

type Transaction = Prisma.TransactionClient
type Database = Pick<PrismaClient, '$transaction'>
const date = z.iso.datetime({ offset: true })
const storedGrantSchema = turnCredentialGrantSchema
  .omit({ deadlineAt: true })
  .extend({
    deadlineAt: date,
    expiresAt: date,
    validUntil: date,
  })
  .refine((grant) => {
    const expiresAt = new Date(grant.expiresAt).getTime()
    const validUntil = new Date(grant.validUntil).getTime()
    const deadline = new Date(grant.deadlineAt).getTime()
    return (
      expiresAt <= deadline - TURN_FINALIZE_RESERVE_MS &&
      validUntil >= expiresAt &&
      validUntil <= deadline + TURN_PUBLICATION_GRACE_MS
    )
  })
/**
 * The client's variables a turn's agent commands get (docs/plan/53-chat-preview-release.md, Р13),
 * by name; the driver spreads them over as many secret files as they take (`envFiles`).
 */
const envValuesSchema = z
  .record(
    z.string().refine((name) => envVarNameProblem(name) === null),
    envVarValueSchema,
  )
  .refine((values) => Object.keys(values).length > 0)
/**
 * Every value a site may have, as one JSON object in the record of the turn: 64 values of 8 KiB,
 * each escaped up to sixfold (a control character is `\u0001`), with their names.
 */
const ENV_JSON_CHARS = envVarLimits.perSite * (6 * envVarLimits.valueMaxBytes + 80)
const envJson = z
  .string()
  .max(ENV_JSON_CHARS)
  .refine((text) => {
    try {
      return envValuesSchema.safeParse(JSON.parse(text)).success
    } catch {
      return false
    }
  }, 'Invalid client variables')
const secretSchema = z.strictObject({
  v: z.literal('1'),
  llmApiKey: z.string().regex(LLM_KEY_PATTERN),
  mcpToken: z.string().regex(MCP_TOKEN_PATTERN),
  sessionId: z.string().min(1).max(64),
  accountId: z.uuid(),
  /**
   * The variables as the turn got them, read once when its key was made: recovery and every
   * retry return the same values the sandbox has, so masking never misses one the client has
   * changed since. Absent — none reached the agent.
   */
  env: envJson.optional(),
  grant: z
    .string()
    .max(2_048)
    .transform((value, context) => {
      try {
        return storedGrantSchema.parse(JSON.parse(value) as unknown)
      } catch {
        context.addIssue({ code: 'custom', message: 'Invalid turn policy' })
        return z.NEVER
      }
    }),
})
type StoredSecret = z.output<typeof secretSchema>
type KeyRow = Prisma.LlmKeyGetPayload<Record<string, never>>
interface OwnedTask {
  id: string
  attempt: number
  siteId: string
  dataClass: 'synthetic' | 'client'
  now: Date
  modelClass?: string | null
}
interface Profile {
  modelId: string
  providerId: string
  enabled: boolean
  reserveOutputTokens: number
}
type Price = NonNullable<Awaited<ReturnType<Transaction['llmModelPrice']['findFirst']>>>
interface Selection {
  task: OwnedTask
  profile: Profile
  decision: PoolDecision
  /** Admission only: the decision over the whole pool, free of the account pinned in Vault. */
  unpinned?: PoolDecision
  /**
   * The selected account, when its window snapshot is older than the pool keeps one for. Never
   * for a backend without windows: there is nothing to refresh.
   */
  staleAccountId: string | null
}
type Preparation =
  | { kind: 'existing'; key: KeyRow; now: Date }
  /** `variables`: those of the site the agent's commands get, at the versions their rows name. */
  | ({ kind: 'selection'; variables: SiteEnvVarVersion[] } & Selection)

export interface GatewayTurnCredentialsOptions {
  prisma: Database
  secrets: SecretStore
  minTurnHeadroomPct?: number
  /**
   * What each backend declares of its accounts' capacity (LlmBackend.capacity): every
   * composition names it (`backendCapacities` over the registry of adapters), so no backend is
   * read by windows it does not have, nor one with windows without them.
   */
  capacityOf: (backend: LlmBackendId) => LlmCapacity
  /**
   * Calls the content-free gateway control probe after all SQL locks were released. `stale`:
   * the snapshot has only grown old, and the gateway probes at most once in five minutes.
   */
  probeAccounts?: (accountIds: readonly string[], options?: { stale?: boolean }) => Promise<void>
  /**
   * The application sets it: a key exists only for the open assignment of its turn, which
   * fixes its deadline and, for a runner, its source address. Tests and stands without
   * turn assignments construct the source directly without it.
   */
  requireAssignment?: boolean
}

/** Vault is durable before admission; every SQL write is fenced by the current site lease. */
export class GatewayTurnCredentials implements TurnCredentialSource {
  readonly #prisma: Database
  readonly #secrets: SecretStore
  readonly #minHeadroom: number
  readonly #capacityOf: (backend: LlmBackendId) => LlmCapacity
  readonly #probeAccounts: GatewayTurnCredentialsOptions['probeAccounts']
  readonly #requireAssignment: boolean

  constructor(options: GatewayTurnCredentialsOptions) {
    this.#prisma = options.prisma
    this.#secrets = options.secrets
    this.#requireAssignment = options.requireAssignment ?? false
    this.#minHeadroom = z
      .number()
      .positive()
      .max(100)
      .parse(options.minTurnHeadroomPct ?? 5)
    this.#probeAccounts = options.probeAccounts
    // A plain-JS composition (a stand) gets no type check: a missing reader stops it here,
    // not as an unavailable gateway at the first issue.
    if (typeof options.capacityOf !== 'function')
      throw new TypeError('GatewayTurnCredentials needs the capacity of each backend')
    this.#capacityOf = options.capacityOf
  }

  async issue(
    input: TurnCredentialRef,
    policy: TurnCredentialGrant,
  ): Promise<TurnCredentialValues> {
    const ref = turnCredentialRefSchema.parse(input)
    const grant = turnCredentialGrantSchema.parse(policy)
    if (grant.reasoningEffort !== null && grant.reasoningEffort.length > 16)
      throw badRequest('Unsupported reasoning effort')
    return this.#safe(async () => {
      let prepared = await this.#prepare(ref, grant)
      if (prepared.kind === 'selection' && prepared.decision.kind === 'wait') {
        const ids = prepared.decision.probeAccountIds
        if (ids.length > 0 && this.#probeAccounts) {
          // A failed control probe does not invent capacity. Reselect from persisted state.
          await this.#probeAccounts(ids).catch(() => undefined)
          prepared = await this.#prepare(ref, grant)
        }
      }
      if (prepared.kind === 'selection' && prepared.staleAccountId && this.#probeAccounts) {
        // A provider that reports its windows only when asked: the account would be selected
        // on a snapshot grown old. One refresh, then a fresh selection from what is stored; an
        // old snapshot closes nothing by itself, so a failed refresh changes nothing.
        await this.#probeAccounts([prepared.staleAccountId], { stale: true }).catch(() => undefined)
        prepared = await this.#prepare(ref, grant)
      }
      const path = turnCredentialPath(ref)
      const written = { vault: false }
      try {
        return await this.#issueAt(ref, grant, prepared, path, written)
      } catch (error) {
        // A write or repair may land after revoke's final destroy, and only this issuer knows.
        // The durable marker wins: nothing would remove the value before validUntil otherwise.
        if (written.vault)
          await this.#transaction((tx) => revocationRequested(tx, ref))
            .then((revoked) => (revoked ? this.#secrets.kvDestroyAll(path) : undefined))
            .catch(() => undefined)
        throw error
      }
    })
  }

  async #issueAt(
    ref: TurnCredentialRef,
    grant: TurnCredentialGrant,
    prepared: Preparation,
    path: string,
    written: { vault: boolean },
  ): Promise<TurnCredentialValues> {
    let stored = await this.#read(path, ref)
    if (prepared.kind === 'existing') {
      if (!stored || !matches(prepared.key, stored, prepared.now))
        throw conflict('Turn credentials cannot be reissued')
      written.vault = true
      await this.#repairMetadata(path, stored)
      const verified = await this.#admit(ref, stored)
      if (!matches(verified.key, stored, verified.now))
        throw conflict('Turn credentials are no longer valid')
      return values(stored)
    }
    requireSelection(prepared.decision)
    if (!stored) {
      if (await this.#secrets.kvMetadata(path))
        throw conflict('Turn credentials were already removed')
      const expiresAt = turnCredentialExpiresAt(grant, prepared.task.now)
      const validUntil = new Date(
        Math.min(
          grant.deadlineAt.getTime() + TURN_PUBLICATION_GRACE_MS,
          prepared.task.now.getTime() + 25 * 60_000,
        ),
      )
      const env = await this.#agentValues(prepared.task.siteId, prepared.variables)
      const data = {
        v: '1',
        ...newTurnKeys(),
        sessionId: ref.sessionId,
        accountId: prepared.decision.accountId,
        ...(env === null ? {} : { env }),
        grant: JSON.stringify({
          ...grant,
          deadlineAt: grant.deadlineAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          validUntil: validUntil.toISOString(),
        }),
      }
      written.vault = true
      await this.#secrets.kvCreateOnce(path, data, {
        sessionId: ref.sessionId,
        deadlineAt: grant.deadlineAt.toISOString(),
        validUntil: validUntil.toISOString(),
      })
      // Read back even after a successful create: a concurrent issuer may have won CAS=0.
      stored = await this.#read(path, ref)
      if (!stored) throw conflict('Turn credentials cannot be read after creation')
    } else {
      written.vault = true
      await this.#repairMetadata(path, stored)
    }
    const issued = await this.#admit(ref, stored)
    if (!matches(issued.key, stored, issued.now))
      throw conflict('Turn credential admission does not match Vault')
    return values(stored)
  }

  async recover(input: TurnCredentialRef): Promise<TurnCredentialValues | null> {
    const ref = turnCredentialRefSchema.parse(input)
    return this.#safe(async () => {
      const stored = await this.#read(turnCredentialPath(ref), ref, false)
      if (!stored) return null
      const result = await this.#transaction(async (tx) => ({
        key: await tx.llmKey.findUnique({ where: compound(ref) }),
        now: await clock(tx),
      }))
      // The running key remains tied to its account even if that account was retired/disabled.
      return result.key && matches(result.key, stored, result.now, false) ? values(stored) : null
    })
  }

  async revoke(input: TurnCredentialRef): Promise<void> {
    const ref = turnCredentialRefSchema.parse(input)
    await this.#safe(async () => {
      // This is the admission fence. Vault failure cannot leave the key accepting new calls.
      await this.#transaction(async (tx) => {
        await tx.$queryRaw`SELECT l.site_id FROM site_leases l JOIN tasks t ON t.site_id = l.site_id
          WHERE t.id = ${ref.taskId}::uuid FOR UPDATE OF l`
        await tx.$executeRaw`
        WITH marker AS (
          INSERT INTO task_events (task_id, type, payload, client_visible)
          SELECT t.id, 'llm.revoke_requested', ${JSON.stringify({
            sessionId: ref.sessionId,
            turn: ref.turn,
            firstEpoch: ref.epoch,
          })}::jsonb, false
          FROM tasks t
          WHERE t.id = ${ref.taskId}::uuid AND NOT EXISTS (
            SELECT 1 FROM task_events e WHERE e.task_id = t.id
              AND e.type = 'llm.revoke_requested' AND e.payload->>'sessionId' = ${ref.sessionId}
              AND e.payload->>'turn' = ${String(ref.turn)}
              AND e.payload->>'firstEpoch' = ${String(ref.epoch)})
          RETURNING id
        )
        UPDATE llm_keys SET revoke_requested_at = coalesce(revoke_requested_at, clock_timestamp())
        WHERE task_id = ${ref.taskId}::uuid AND session_id = ${ref.sessionId}
          AND turn_no = ${ref.turn} AND first_epoch = ${ref.epoch}`
      })
      const path = turnCredentialPath(ref)
      await this.#secrets.kvDelete(path)
      await this.#transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM llm_keys
          WHERE task_id = ${ref.taskId}::uuid AND turn_no = ${ref.turn}
            AND first_epoch = ${ref.epoch} AND session_id = ${ref.sessionId} FOR UPDATE`
        await tx.$executeRaw`
          UPDATE llm_keys k SET revoked_at = coalesce(k.revoked_at, clock_timestamp()),
            usage_closed_at = CASE WHEN NOT EXISTS
              (SELECT 1 FROM llm_calls c WHERE c.key_id = k.id AND c.state = 'open')
              THEN coalesce(k.usage_closed_at, clock_timestamp()) ELSE k.usage_closed_at END
          WHERE k.task_id = ${ref.taskId}::uuid AND k.turn_no = ${ref.turn}
            AND k.first_epoch = ${ref.epoch} AND k.session_id = ${ref.sessionId}`
      })
      await this.#secrets.kvDestroyAll(path)
    })
  }

  async #prepare(ref: TurnCredentialRef, grant: TurnCredentialGrant): Promise<Preparation> {
    return this.#transaction(async (tx) => {
      const task = await ownedTask(tx, ref)
      await validateAssignment(tx, ref, grant, this.#requireAssignment)
      const key = await tx.llmKey.findUnique({ where: compound(ref) })
      if (key) {
        if (key.revokeRequestedAt || key.revokedAt || key.sessionId !== ref.sessionId)
          throw conflict('Turn credentials are closed')
        return { kind: 'existing', key, now: task.now }
      }
      turnCredentialExpiresAt(grant, task.now)
      return {
        kind: 'selection',
        variables: await agentVariables(tx, task),
        ...(await this.#select(tx, ref, grant, task)),
      }
    })
  }

  /**
   * The values of the variables the agent's commands get (Р13), read from Vault at the version
   * each row names: one written after the row was read waits for the next turn, and one removed
   * meanwhile is left out. A JSON object for the turn's record, or null when nothing is left.
   */
  async #agentValues(
    siteId: string,
    variables: readonly SiteEnvVarVersion[],
  ): Promise<string | null> {
    const values = await readSiteEnvValues(this.#secrets, siteId, variables)
    if (Object.keys(values).length === 0) return null
    const json = JSON.stringify(values)
    // More than a site may have: only rows two writers added at once give that.
    if (json.length > ENV_JSON_CHARS)
      throw badRequest('The client variables for the agent do not fit one turn', {
        reason: 'client_variables_too_large',
      })
    return json
  }

  /**
   * The current values of every variable of the turn's site, whatever their recipients and the
   * version the turn got (Р13): what the turn's candidate is refused for besides its own.
   */
  async siteValues(input: TurnCredentialRef): Promise<string[]> {
    const ref = turnCredentialRefSchema.parse(input)
    return this.#safe(async () => {
      const rows = await this.#transaction(
        (tx) =>
          tx.$queryRaw<{ siteId: string; name: string }[]>`
          SELECT v.site_id AS "siteId", v.name FROM tasks t
          JOIN site_env_vars v ON v.site_id = t.site_id
          WHERE t.id = ${ref.taskId}::uuid ORDER BY v.name`,
      )
      const siteId = rows[0]?.siteId
      if (siteId === undefined) return []
      return readSiteEnvValuesToRefuse(
        this.#secrets,
        siteId,
        rows.map((row) => row.name),
      )
    })
  }

  async #admit(ref: TurnCredentialRef, stored: StoredSecret) {
    const grant = {
      ...stored.grant,
      deadlineAt: new Date(stored.grant.deadlineAt),
    }
    return this.#transaction(async (tx) => {
      const task = await ownedTask(tx, ref)
      await validateAssignment(tx, ref, grant, this.#requireAssignment)
      const existing = await tx.llmKey.findUnique({ where: compound(ref) })
      if (existing) {
        await assertCurrentFence(tx, ref)
        return { key: existing, now: await clock(tx) }
      }
      if (new Date(stored.grant.expiresAt) <= task.now)
        throw conflict('Turn credentials have expired')
      const selected = await this.#select(tx, ref, grant, task, stored.accountId)
      if (
        selected.decision.kind !== 'selected' ||
        selected.decision.accountId !== stored.accountId
      ) {
        // Vault pins this turn to its account, but the caller's next attempt (a new lease epoch)
        // selects again: answer what the whole pool offers it, at once if an account is free.
        requireSelection(selected.unpinned ?? selected.decision)
        throw subscriptionBusy(selected.task.now)
      }
      const binding = await tx.taskAccountBinding.findUnique({ where: { taskId: ref.taskId } })
      if (binding) {
        if (selected.decision.binding === 'rebind')
          await tx.taskAccountBinding.update({
            where: { taskId: ref.taskId },
            data: { subscriptionAccountId: stored.accountId, rebinds: selected.decision.rebinds },
          })
      } else {
        await tx.taskAccountBinding.create({
          data: {
            taskId: ref.taskId,
            driverId: grant.driverId,
            subscriptionAccountId: stored.accountId,
            rebinds: selected.decision.rebinds,
          },
        })
      }
      const expiresAt = new Date(stored.grant.expiresAt)
      // A lease can expire while waiting for the pool lock or querying the snapshot.
      const now = await clock(tx)
      await assertCurrentFence(tx, ref)
      if (expiresAt <= now) throw conflict('Turn credentials have expired')
      const key = await tx.llmKey.create({
        data: {
          keyHash: turnKeyHash(stored.llmApiKey),
          mcpTokenHash: turnKeyHash(stored.mcpToken),
          taskId: ref.taskId,
          taskAttempt: task.attempt,
          sessionId: ref.sessionId,
          turnNo: ref.turn,
          firstEpoch: ref.epoch,
          driverId: grant.driverId,
          modelId: selected.profile.modelId,
          subscriptionAccountId: stored.accountId,
          reasoningEffort: grant.reasoningEffort,
          budgetRub: grant.budgetRub,
          boundSource: grant.boundSource,
          expiresAt,
          validUntil: new Date(stored.grant.validUntil),
        },
      })
      await tx.subscriptionAccount.update({
        where: { id: stored.accountId },
        data: { lastUsedAt: now },
      })
      return { key, now }
    })
  }

  async #select(
    tx: Transaction,
    ref: TurnCredentialRef,
    grant: TurnCredentialGrant,
    task: OwnedTask,
    requiredAccount?: string,
  ): Promise<Selection> {
    const models = await tx.$queryRaw<Profile[]>`
      SELECT m.id AS "modelId", p.id AS "providerId", p.enabled AS enabled,
        m.reserve_output_tokens AS "reserveOutputTokens"
      FROM llm_models m JOIN llm_providers p ON p.id = m.provider_id
      JOIN agent_drivers d ON d.id = ${grant.driverId} AND d.enabled
      WHERE p.slug = ${grant.backend} AND p.kind = 'subscription'
        AND m.slug = ${grant.modelSlug} AND m.enabled AND m.provider_model_id IS NOT NULL
        AND m.model_class::text = ${grant.modelClass}
        AND m.reserve_output_tokens > 0 FOR SHARE OF m, p, d`
    const profile = models[0]
    if (!profile) throw badRequest('The requested model profile is unavailable')
    if (task.modelClass != null && task.modelClass !== grant.modelClass)
      throw badRequest('The requested model class does not match the task')
    if (task.dataClass === 'client') {
      const clearance = await tx.$queryRaw<{ id: string }[]>`
        SELECT c.id FROM cross_border_clearances c
        WHERE c.provider_id = ${profile.providerId}::uuid AND c.revoked_at IS NULL
          AND c.transfer_allowed_from <= (clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date
        FOR SHARE OF c`
      if (!clearance[0]) throw crossBorderNotCleared()
    }
    const price = await tx.llmModelPrice.findFirst({
      where: { modelId: profile.modelId, effectiveFrom: { lte: task.now } },
      orderBy: { effectiveFrom: 'desc' },
    })
    if (!price) throw llmPriceMissing()
    await requireKeyBudget(tx, task, grant, profile, price)
    // Never acquire account rows in an arbitrary order: lease fence → one provider pool lock.
    await lockSubscriptionPool(tx, grant.backend)
    task = { ...task, now: await clock(tx) }
    const binding = await tx.taskAccountBinding.findUnique({ where: { taskId: ref.taskId } })
    if (binding && binding.driverId !== grant.driverId)
      throw conflict('The task binding uses another driver')
    const accounts = await tx.$queryRaw<
      Array<{
        id: string
        enabled: boolean
        status: PoolAccountSnapshot['status']
        health: PoolAccountSnapshot['health']
        healthReason: string | null
        healthChangedAt: Date | null
        retireRequestedAt: Date | null
        coolingUntil: Date | null
        breakerOpenUntil: Date | null
        limitWindows: unknown
        limitsSeenAt: Date | null
        activeTurns: bigint
        maxConcurrentTurns: number
        lastUsedAt: Date | null
      }>
    >`
      SELECT a.id, (a.enabled AND a.credential_version > 0 AND a.credentials_revoked_at IS NULL) AS enabled,
        a.status::text AS status, a.health::text AS health, a.health_reason AS "healthReason",
        a.health_changed_at AS "healthChangedAt", a.retire_requested_at AS "retireRequestedAt",
        a.cooling_until AS "coolingUntil", a.breaker_open_until AS "breakerOpenUntil",
        a.limit_windows AS "limitWindows", a.limits_seen_at AS "limitsSeenAt",
        a.max_concurrent_turns AS "maxConcurrentTurns",
        a.last_used_at AS "lastUsedAt", (SELECT count(*) FROM llm_keys k
          WHERE k.subscription_account_id = a.id AND k.revoke_requested_at IS NULL
            AND k.revoked_at IS NULL AND k.expires_at > clock_timestamp()) AS "activeTurns"
      FROM subscription_accounts a WHERE a.provider_id = ${profile.providerId}::uuid
        AND a.driver_id = ${grant.driverId}`
    const snapshots = accounts.map(({ limitsSeenAt: _seen, ...a }) => ({
      ...a,
      backend: grant.backend,
      activeTurns: Number(a.activeTurns),
      limitWindows: decodeLimitWindows(a.limitWindows),
    }))
    // Not llm_keys.last_refusal: any later refusal of the same key overwrites that one.
    const policyFlagged = await tx.taskEvent.findFirst({
      where: { taskId: ref.taskId, type: policyFlaggedEvent },
      select: { id: true },
    })
    const capacity = this.#capacityOf(grant.backend)
    // A durable Vault record fixes the selected account. A racing issue cannot select another
    // secret or bind a task without the matching key. Keep the pure selector's new-task gates.
    const pick = (accounts: typeof snapshots) =>
      pickAccount({
        backend: grant.backend,
        capacity,
        providerEnabled: profile.enabled,
        now: task.now,
        boundAccountId: binding?.subscriptionAccountId ?? null,
        rebinds: binding?.rebinds ?? 0,
        policyFlagged: policyFlagged !== null,
        minTurnHeadroomPct: this.#minHeadroom,
        accounts,
      })
    const decision = pick(
      requiredAccount
        ? snapshots.filter(
            (a) => a.id === requiredAccount || a.id === binding?.subscriptionAccountId,
          )
        : snapshots,
    )
    await assertCurrentFence(tx, ref)
    // Windows nobody has dated are unknown ones, which the selection sends to a probe itself.
    const seenAt =
      decision.kind === 'selected'
        ? accounts.find((account) => account.id === decision.accountId)?.limitsSeenAt
        : null
    return {
      task,
      profile,
      decision,
      staleAccountId:
        decision.kind === 'selected' &&
        capacity === 'windows' &&
        seenAt != null &&
        task.now.getTime() - seenAt.getTime() > poolPolicy.windowsFreshMs
          ? decision.accountId
          : null,
      ...(requiredAccount ? { unpinned: pick(snapshots) } : {}),
    }
  }

  async #read(path: string, ref: TurnCredentialRef, strict = true): Promise<StoredSecret | null> {
    const secret = await this.#secrets.kvRead(path)
    if (!secret) return null
    const parsed = secretSchema.safeParse(secret.data)
    if (!parsed.success || parsed.data.sessionId !== ref.sessionId) {
      if (strict) throw conflict('Turn credentials do not match the session')
      return null
    }
    return parsed.data
  }

  async #repairMetadata(path: string, stored: StoredSecret): Promise<void> {
    await this.#secrets.kvCreateOnce(
      path,
      {
        ...stored,
        grant: JSON.stringify(stored.grant),
      },
      {
        sessionId: stored.sessionId,
        deadlineAt: stored.grant.deadlineAt,
        validUntil: stored.grant.validUntil,
      },
    )
  }

  #transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.#prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('lock_timeout', '1000ms', true),
        set_config('statement_timeout', '5000ms', true)`
        return work(tx)
      },
      { maxWait: 5_000, timeout: 10_000 },
    )
  }

  async #safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (isDomainError(error)) throw error
      throw llmGatewayUnavailable()
    }
  }
}

const compound = (ref: TurnCredentialRef) => ({
  taskId_turnNo_firstEpoch: { taskId: ref.taskId, turnNo: ref.turn, firstEpoch: ref.epoch },
})
const values = (stored: StoredSecret): TurnCredentialValues => ({
  llmApiKey: stored.llmApiKey,
  mcpToken: stored.mcpToken,
  ...(stored.env === undefined
    ? {}
    : { envValues: envValuesSchema.parse(JSON.parse(stored.env) as unknown) }),
})
function matches(key: KeyRow, stored: StoredSecret, now: Date, active = true): boolean {
  return (
    key.sessionId === stored.sessionId &&
    key.keyHash === turnKeyHash(stored.llmApiKey) &&
    (key.mcpTokenHash == null || key.mcpTokenHash === turnKeyHash(stored.mcpToken)) &&
    key.subscriptionAccountId === stored.accountId &&
    !key.revokeRequestedAt &&
    !key.revokedAt &&
    (!active || (now < key.expiresAt && now < new Date(stored.grant.expiresAt))) &&
    now < key.validUntil &&
    now < new Date(stored.grant.validUntil)
  )
}
function requireSelection(
  decision: PoolDecision,
): asserts decision is Extract<PoolDecision, { kind: 'selected' }> {
  if (decision.kind === 'busy') throw subscriptionBusy(decision.retryAt)
  if (decision.kind === 'wait') throw subscriptionWait(decision.retryAt)
  if (decision.kind === 'operator')
    throw new DomainError('SUBSCRIPTION_OPERATOR_REQUIRED', 'The task requires an operator', 409, {
      reason: decision.reason,
    })
}
async function clock(tx: Transaction): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
  return rows[0]!.now
}
async function ownedTask(tx: Transaction, ref: TurnCredentialRef): Promise<OwnedTask> {
  // The turn sends the code and content of the site, so the 152-FZ gate reads the data class of
  // the site's workspace. A task row that names another workspace owns nothing, as in MCP access.
  const rows = await tx.$queryRaw<OwnedTask[]>`
    SELECT t.id, t.attempt, t.site_id AS "siteId", t.model_class::text AS "modelClass",
      w.data_class::text AS "dataClass", clock_timestamp() AS now
    FROM tasks t
    JOIN sites s ON s.id = t.site_id AND s.workspace_id = t.workspace_id
    JOIN workspaces w ON w.id = s.workspace_id
    JOIN site_leases l ON l.site_id = t.site_id
    WHERE t.id = ${ref.taskId}::uuid AND l.holder_task_id = t.id AND l.epoch = ${ref.epoch}
      AND l.operation = 'turn' AND NOT l.held_for_operator AND l.expires_at > clock_timestamp()
    FOR UPDATE OF l`
  if (!rows[0]) throw leaseLost()
  // WHERE and SELECT expressions may run before an unchanged row's lock becomes available.
  // Recheck after taking that lock, including retries that bypass account selection entirely.
  await assertCurrentFence(tx, ref)
  return { ...rows[0], now: await clock(tx) }
}
/**
 * The variables of the task's site whose values the agent's commands get (Р13): the client
 * turned `to_agent` on with consent, and the workspace holds no real client data
 * (`envVarReachesAgent`; until the gate of 152-FZ, rule 1).
 */
async function agentVariables(tx: Transaction, task: OwnedTask): Promise<SiteEnvVarVersion[]> {
  const rows = await tx.siteEnvVar.findMany({
    where: { siteId: task.siteId, toAgent: true, agentConsentAt: { not: null } },
    orderBy: { name: 'asc' },
    select: { name: true, keyVersion: true, toAgent: true, toPreview: true, agentConsentAt: true },
  })
  return rows
    .filter(
      (row) => envVarReachesAgent(row, task.dataClass) && envVarNameProblem(row.name) === null,
    )
    .map((row) => ({ name: row.name, keyVersion: row.keyVersion }))
}
async function assertCurrentFence(tx: Transaction, ref: TurnCredentialRef): Promise<void> {
  const rows = await tx.$queryRaw<{ owned: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM tasks t
      JOIN sites s ON s.id = t.site_id AND s.workspace_id = t.workspace_id
      JOIN site_leases l ON l.site_id = t.site_id
      WHERE t.id = ${ref.taskId}::uuid AND l.holder_task_id = t.id AND l.epoch = ${ref.epoch}
        AND l.operation = 'turn' AND NOT l.held_for_operator
        AND l.expires_at > clock_timestamp()) AS owned`
  if (!rows[0]?.owned) throw leaseLost()
  await assertNotRevoked(tx, ref)
}
async function assertNotRevoked(tx: Transaction, ref: TurnCredentialRef): Promise<void> {
  if (await revocationRequested(tx, ref)) throw conflict('Turn credentials are closed')
}
async function revocationRequested(tx: Transaction, ref: TurnCredentialRef): Promise<boolean> {
  const marker = await tx.taskEvent.findFirst({
    where: {
      taskId: ref.taskId,
      type: 'llm.revoke_requested',
      AND: [
        { payload: { path: ['sessionId'], equals: ref.sessionId } },
        { payload: { path: ['turn'], equals: ref.turn } },
        { payload: { path: ['firstEpoch'], equals: ref.epoch } },
      ],
    },
    select: { id: true },
  })
  return marker !== null
}
/**
 * Spec §17: a key never admits more than its attempt may spend (the class ceiling on a quota
 * plan, what the active reserve pays for on pay-as-you-go), nor less than its first call needs.
 * Tasks without a pricing rule follow the quota ceiling, and so do non-billable ones («Отменить»,
 * operator retries): they keep the pinned rule but have no reserve. Attempt spend before this key
 * is the caller's to subtract until P12 computes the budget; it is taken as zero here.
 */
async function requireKeyBudget(
  tx: Transaction,
  task: OwnedTask,
  grant: TurnCredentialGrant,
  profile: Profile,
  price: Price,
): Promise<void> {
  const rows = await tx.$queryRaw<
    { payg: boolean; holdRub: string | null; feeRub: string | null; markup: string | null }[]
  >`
    SELECT (t.pricing_rule_id IS NOT NULL AND t.billable) AS payg, h.amount::text AS "holdRub",
      r.fee_per_action::text AS "feeRub", r.markup::text AS markup
    FROM tasks t LEFT JOIN pricing_rules r ON r.id = t.pricing_rule_id
    LEFT JOIN credit_holds h ON h.task_id = t.id AND h.attempt = t.attempt
      AND h.unit = 'rub' AND h.status = 'active'
    WHERE t.id = ${task.id}::uuid`
  const row = rows[0]
  if (!row) throw leaseLost()
  const spend = { spentRub: '0', openReservedRub: '0' }
  let attempt: AttemptBudgetInput
  if (row.payg) {
    if (row.holdRub === null || row.feeRub === null || row.markup === null)
      throw badRequest('The pay-as-you-go task has no active reserve', { budget: 'no_reserve' })
    attempt = {
      kind: 'payg',
      holdRub: row.holdRub,
      feeRub: row.feeRub,
      markup: row.markup,
      ...spend,
    }
  } else attempt = { kind: 'quota', modelClass: grant.modelClass, ...spend }
  const verdict = turnKeyBudgetVerdict(
    { budgetRub: grant.budgetRub, attempt, reserveOutputTokens: profile.reserveOutputTokens },
    {
      inputPer1m: price.inputPer1m.toFixed(6),
      cacheReadPer1m: price.cacheReadPer1m?.toFixed(6) ?? null,
      cacheWritePer1m: price.cacheWritePer1m?.toFixed(6) ?? null,
      outputPer1m: price.outputPer1m.toFixed(6),
    },
  )
  if (verdict === 'above_ceiling')
    throw badRequest('The turn key budget exceeds its attempt ceiling', { budget: verdict })
  if (verdict === 'below_first_call')
    throw badRequest('The turn key budget is below the first call reserve', { budget: verdict })
}
async function validateAssignment(
  tx: Transaction,
  ref: TurnCredentialRef,
  grant: TurnCredentialGrant,
  required: boolean,
): Promise<void> {
  const assignment = await tx.turnAssignment.findFirst({
    where: { taskId: ref.taskId, turnNo: ref.turn, finishedAt: null },
    select: {
      sessionId: true,
      firstEpoch: true,
      leaseEpoch: true,
      deadlineAt: true,
      executor: true,
    },
  })
  if (!assignment && required) throw conflict('Turn credentials require an open assignment')
  if (
    assignment &&
    (assignment.sessionId !== ref.sessionId ||
      assignment.firstEpoch !== ref.epoch ||
      assignment.leaseEpoch !== ref.epoch ||
      assignment.deadlineAt.getTime() !== grant.deadlineAt.getTime())
  )
    throw conflict('Turn credential policy does not match its assignment')
  if (assignment?.executor === 'runner' && grant.boundSource === null)
    throw badRequest('A runner turn requires its trusted source address')
}
