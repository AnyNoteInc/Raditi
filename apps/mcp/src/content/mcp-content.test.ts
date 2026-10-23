import { createHash, randomUUID } from 'node:crypto'

import {
  DomainError,
  publishedContentHashMaterial,
  type PublishedContentGateway,
} from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { newTurnKeys } from '@repo/turn-keys'
import type { ContentPrivacy } from '../privacy/content-privacy.ts'
import type { ContentSnapshotStorage } from './content-snapshots.ts'
import type { McpAccess } from '../access/mcp-access.ts'
import { McpContentService } from './mcp-content.ts'
import type { PostgresMcpJournal } from './mcp-journal.ts'

function fixture() {
  const scope: McpAccess = {
    keyId: randomUUID(),
    taskId: randomUUID(),
    siteId: randomUUID(),
    workspaceId: randomUUID(),
    sessionId: randomUUID(),
    turn: 1,
    epoch: 1,
    firstEpoch: 1,
    stack: 'wordpress',
    url: 'https://site.example.test/',
    preview: null,
  }
  const reserve = vi.fn<PostgresMcpJournal['reserve']>(async () => ({
    kind: 'replay',
    callId: randomUUID(),
    completion: { result: 'ok', response: { updated: true } },
  }))
  const rehydrate = vi.fn<ContentPrivacy['rehydrate']>(async (_scope, patch) => ({ ...patch }))
  const resolve = vi.fn(async () => {
    throw new Error('The site must not be reached')
  })
  const service = new McpContentService(
    { reserve } as unknown as PostgresMcpJournal,
    {} as ContentSnapshotStorage,
    { rehydrate } as unknown as ContentPrivacy,
    resolve,
  )
  const post = (body: Record<string, string>) =>
    service.wpRest(scope, {
      method: 'POST',
      route: '/wp/v2/pages/42',
      body,
      idempotencyKey: randomUUID(),
    })
  return { scope, reserve, rehydrate, resolve, post }
}

/** A journal and a site that admit one write: what the gateway is asked is in `site`. */
function writing() {
  const { scope } = fixture()
  const fields = { version: 1 as const, objectRef: 'page:42', kind: 'page' as const }
  const text = { title: 'До', content: '<p>Текст</p>', excerpt: '' }
  const state = {
    ...fields,
    ...text,
    stateHash: createHash('sha256')
      .update(publishedContentHashMaterial({ ...fields, ...text }))
      .digest('hex'),
  }
  const callId = randomUUID()
  const snapshot = {
    id: randomUUID(),
    workspaceId: scope.workspaceId,
    siteId: scope.siteId,
    taskId: scope.taskId,
    objectRef: 'page:42',
    expiresAt: new Date(Date.now() + 60_000),
  }
  const intent = {
    callId,
    requestHash: 'a'.repeat(64),
    objectRef: 'page:42',
    deadlineAt: 1_800_000_000_000,
    ttlMs: 12_345,
    snapshotId: snapshot.id,
    restoresSnapshotId: null,
    preview: null,
  }
  const journal = {
    reserve: vi.fn<PostgresMcpJournal['reserve']>(async () => ({
      kind: 'claimed',
      callId,
      snapshot,
    })),
    attachSnapshot: vi.fn<PostgresMcpJournal['attachSnapshot']>(async () => undefined),
    beginWrite: vi.fn<PostgresMcpJournal['beginWrite']>(async () => true),
    writeIntent: vi.fn<PostgresMcpJournal['writeIntent']>(async () => intent),
    recoveryIntent: vi.fn<PostgresMcpJournal['recoveryIntent']>(async () => ({
      ...intent,
      kind: 'write',
      ttlMs: -777,
    })),
    finish: vi.fn<PostgresMcpJournal['finish']>(async () => undefined),
    markAmbiguous: vi.fn<PostgresMcpJournal['markAmbiguous']>(async () => undefined),
  }
  const proof = {
    version: 1 as const,
    kind: 'committed' as const,
    callId,
    siteId: scope.siteId,
    epoch: scope.epoch,
    requestHash: intent.requestHash,
    objectRef: 'page:42',
    stateHash: 'b'.repeat(64),
  }
  const site = {
    read: vi.fn<PublishedContentGateway['read']>(async () => state),
    conditionalWrite: vi.fn<PublishedContentGateway['conditionalWrite']>(async () => proof),
    operation: vi.fn<PublishedContentGateway['operation']>(async () => null),
    reconcileOperation: vi.fn<PublishedContentGateway['reconcileOperation']>(async () => proof),
    forgetOperation: vi.fn<PublishedContentGateway['forgetOperation']>(async () => undefined),
  }
  const save = vi.fn<ContentSnapshotStorage['save']>(async (reference) => ({
    ...reference,
    payloadSha256: 'c'.repeat(64),
    sizeBytes: 1,
  }))
  const service = new McpContentService(
    journal as unknown as PostgresMcpJournal,
    { save } as unknown as ContentSnapshotStorage,
    { rehydrate: async (_scope, patch) => ({ ...patch }) } as ContentPrivacy,
    async () => site,
  )
  const post = (idempotencyKey: string = randomUUID()) =>
    service.wpRest(scope, {
      method: 'POST',
      route: '/wp/v2/pages/42',
      body: { title: 'После' },
      idempotencyKey,
    })
  return { scope, callId, intent, journal, site, save, service, post }
}

// The pair the core issues for every turn, from its own generator.
const issued = newTurnKeys()
const credentials = { 'LLM key': issued.llmApiKey, 'MCP token': issued.mcpToken }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the time a site gets for a write', () => {
  // The journal sets the deadline and says what is left of it, both on the PostgreSQL clock.
  it('is the time left the journal reports, whatever the clock of this process shows', async () => {
    const f = writing()
    vi.spyOn(Date, 'now').mockReturnValue(f.intent.deadlineAt + 3_600_000)
    expect(await f.post()).toMatchObject({ result: 'ok' })
    expect(f.site.conditionalWrite).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ callId: f.callId, deadlineAt: f.intent.deadlineAt, ttlMs: 12_345 }),
    )
  })

  it('is passed on to a reconciliation as the journal reports it', async () => {
    const f = writing()
    vi.spyOn(Date, 'now').mockReturnValue(f.intent.deadlineAt - 3_600_000)
    expect(await f.service.recoverWrite(f.scope, f.callId)).toBe('completed')
    expect(f.site.reconcileOperation).toHaveBeenCalledExactlyOnceWith({
      callId: f.callId,
      siteId: f.scope.siteId,
      epoch: f.scope.epoch,
      requestHash: f.intent.requestHash,
      objectRef: 'page:42',
      deadlineAt: f.intent.deadlineAt,
      ttlMs: -777,
    })
  })
})

describe('a preparation its own turn left open', () => {
  const interrupted = {
    result: 'error' as const,
    response: { code: 'CONTENT_PREPARATION_INTERRUPTED' },
  }
  const open = (f: ReturnType<typeof writing>, overrides: Record<string, unknown> = {}) => ({
    kind: 'pending' as const,
    callId: f.callId,
    stage: 'capture' as const,
    recoveryRequired: false,
    stale: false,
    ...overrides,
  })

  it('stays open after a journal outage took both its snapshot record and its closing record', async () => {
    const f = writing()
    const outage = () =>
      new DomainError('MCP_JOURNAL_UNAVAILABLE', 'MCP journal is unavailable', 503)
    f.journal.attachSnapshot.mockRejectedValueOnce(outage())
    f.journal.finish.mockRejectedValueOnce(outage())
    await expect(f.post('first')).rejects.toMatchObject({ code: 'MCP_JOURNAL_UNAVAILABLE' })
    expect(f.journal.beginWrite).not.toHaveBeenCalled()
    expect(f.site.conditionalWrite).not.toHaveBeenCalled()
  })

  it.each(['capture', 'ready'] as const)(
    'is closed by a retry of the same key once it is older than any preparation: %s',
    async (stage) => {
      const f = writing()
      f.journal.reserve
        .mockResolvedValueOnce(open(f, { stage, stale: true }))
        .mockResolvedValueOnce({ kind: 'replay', callId: f.callId, completion: interrupted })
      f.journal.recoveryIntent.mockResolvedValueOnce({ kind: 'closed', committed: false })
      // The agent is told to go on with a new key; nothing reaches the site.
      expect(await f.post('first')).toEqual(interrupted)
      expect(f.journal.recoveryIntent).toHaveBeenCalledExactlyOnceWith(f.scope, f.callId)
      expect(f.journal.reserve).toHaveBeenCalledTimes(2)
      expect(f.site.read).not.toHaveBeenCalled()
      expect(f.site.conditionalWrite).not.toHaveBeenCalled()
      expect(f.journal.finish).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['is younger than a preparation may be', {}],
    ['has started its write', { stage: 'write', stale: true, recoveryRequired: true }],
    ['belongs to an earlier epoch', { stale: true, recoveryRequired: true }],
  ])('keeps answering «in flight» while it %s', async (_label, overrides) => {
    const f = writing()
    f.journal.reserve.mockResolvedValueOnce(open(f, overrides))
    await expect(f.post('first')).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    expect(f.journal.recoveryIntent).not.toHaveBeenCalled()
    expect(f.journal.reserve).toHaveBeenCalledOnce()
    expect(f.site.conditionalWrite).not.toHaveBeenCalled()
  })

  it('is left to recovery when its write turns out to have started', async () => {
    const f = writing()
    f.journal.reserve
      .mockResolvedValueOnce(open(f, { stage: 'ready', stale: true }))
      .mockResolvedValueOnce(open(f, { stage: 'write', stale: false, recoveryRequired: true }))
    await expect(f.post('first')).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    expect(f.journal.recoveryIntent).toHaveBeenCalledOnce()
    expect(f.site.conditionalWrite).not.toHaveBeenCalled()
    expect(f.journal.finish).not.toHaveBeenCalled()
  })

  it('sends nothing when the late first request finds its call closed', async () => {
    const f = writing()
    // The journal refuses to open a closed call: beginWrite answers false.
    f.journal.beginWrite.mockResolvedValueOnce(false)
    await expect(f.post('first')).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    expect(f.site.conditionalWrite).not.toHaveBeenCalled()
    expect(f.journal.writeIntent).not.toHaveBeenCalled()
    expect(f.journal.finish).not.toHaveBeenCalled()
    expect(f.journal.markAmbiguous).not.toHaveBeenCalled()
  })
})

describe('the stack of the site', () => {
  // Rule 8: which stacks have published content is the registry's knowledge, behind the
  // resolver. The service compares the stack with nothing.
  const refused = () =>
    new DomainError('CONTENT_SITE_ACCESS_UNAVAILABLE', 'Site content access is unavailable', 503, {
      reason: 'stack',
    })

  it.each(['bitrix', 'static'] as const)(
    'is not judged by the service: a %s site with a gateway is edited like any other',
    async (stack) => {
      const f = writing()
      const scope = { ...f.scope, stack }
      expect(
        await f.service.wpRest(scope, {
          method: 'POST',
          route: '/wp/v2/pages/42',
          body: { title: 'После' },
          idempotencyKey: 'neutral',
        }),
      ).toMatchObject({ result: 'ok' })
      expect(f.site.conditionalWrite).toHaveBeenCalledOnce()
      // A restore reaches the journal instead of being refused for its stack.
      const restoreSource = vi.fn(async () => {
        throw new DomainError('NOT_FOUND', 'No such snapshot', 404)
      })
      Object.assign(f.journal, { restoreSource })
      await expect(
        f.service.restore(scope, { snapshotId: randomUUID(), idempotencyKey: 'neutral-undo' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(restoreSource).toHaveBeenCalledOnce()
    },
  )

  it('stops a read at the refusal of the resolver', async () => {
    const f = fixture()
    f.resolve.mockRejectedValueOnce(refused())
    const noteContentAccess = vi.fn(async () => undefined)
    const service = new McpContentService(
      { noteContentAccess } as unknown as PostgresMcpJournal,
      {} as ContentSnapshotStorage,
      {} as ContentPrivacy,
      f.resolve,
    )
    await expect(
      service.wpRest({ ...f.scope, stack: 'bitrix' }, { method: 'GET', route: '/wp/v2/pages/42' }),
    ).rejects.toMatchObject({ code: 'CONTENT_SITE_ACCESS_UNAVAILABLE' })
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith({ ...f.scope, stack: 'bitrix' })
  })

  it('closes a write the resolver refused with the fixed preparation code and sends nothing', async () => {
    const f = writing()
    const resolve = vi.fn(async () => {
      throw refused()
    })
    const service = new McpContentService(
      f.journal as unknown as PostgresMcpJournal,
      { save: f.save } as unknown as ContentSnapshotStorage,
      { rehydrate: async (_scope, patch) => ({ ...patch }) } as ContentPrivacy,
      resolve,
    )
    const outcome = await service.wpRest(
      { ...f.scope, stack: 'bitrix' },
      { method: 'POST', route: '/wp/v2/pages/42', body: { title: 'После' }, idempotencyKey: 'k' },
    )
    expect(outcome).toEqual({ result: 'error', response: { code: 'CONTENT_PREPARATION_FAILED' } })
    expect(f.journal.finish).toHaveBeenCalledExactlyOnceWith(
      { ...f.scope, stack: 'bitrix' },
      f.callId,
      outcome,
    )
    expect(f.save).not.toHaveBeenCalled()
    expect(f.journal.beginWrite).not.toHaveBeenCalled()
    expect(f.site.conditionalWrite).not.toHaveBeenCalled()
  })
})

describe('McpContentService', () => {
  // The agent can read its own turn credentials in the sandbox; a public page must never get one.
  it.each(
    Object.entries(credentials).flatMap(([kind, credential]) =>
      ['title', 'content', 'excerpt'].map((field) => [kind, field, credential] as const),
    ),
  )(
    'refuses to publish a turn %s in the %s before anything is journaled',
    async (_, field, credential) => {
      const f = fixture()
      await expect(f.post({ [field]: `<p>Ключ: ${credential}</p>` })).rejects.toMatchObject({
        code: 'CONTENT_CREDENTIAL_REFUSED',
      })
      expect(f.rehydrate).not.toHaveBeenCalled()
      expect(f.reserve).not.toHaveBeenCalled()
      expect(f.resolve).not.toHaveBeenCalled()
    },
  )

  it('writes nothing when a contact marker cannot go back hidden', async () => {
    const f = fixture()
    f.rehydrate.mockRejectedValueOnce(
      new DomainError('CONTENT_PRIVACY_CONTEXT', 'synthetic refusal', 400),
    )
    await expect(f.post({ content: `ИНН [[raditi:phone:${randomUUID()}]]` })).rejects.toMatchObject(
      {
        code: 'CONTENT_PRIVACY_CONTEXT',
      },
    )
    expect(f.reserve).not.toHaveBeenCalled()
    expect(f.resolve).not.toHaveBeenCalled()
  })

  it('passes text that only resembles a credential on to the journal', async () => {
    const f = fixture()
    for (const text of [
      'sk-rdt-short',
      `mcp_${'a'.repeat(63)}`,
      `mcp_${'g'.repeat(64)}`,
      'Скидка 20% до конца месяца',
    ])
      expect(await f.post({ content: text })).toMatchObject({ result: 'ok' })
    expect(f.reserve).toHaveBeenCalledTimes(4)
  })
})
