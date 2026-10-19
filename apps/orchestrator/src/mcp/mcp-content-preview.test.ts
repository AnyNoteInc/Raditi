import { createHash, randomUUID } from 'node:crypto'

import {
  publishedContentHashMaterial,
  type PublishedContentGateway,
  type PublishedContentState,
} from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { newTurnKeys } from '../llm/turn-key.ts'
import type { ContentPrivacy } from './content-privacy.ts'
import type { ContentSnapshotStorage } from './content-snapshots.ts'
import type { McpAccess } from './mcp-access.ts'
import { McpContentService, type McpPreviewContent } from './mcp-content.ts'
import type { PostgresMcpJournal } from './mcp-journal.ts'
import type { McpPreviewTarget } from './preview-content.ts'
import { previewDbValueKey } from './preview-db-values.ts'

// Content of a dialog with a preview goes into the preview alone (docs/plan/53-chat-preview-
// release.md, Р3, Р24): its gateway, its write epoch, and each write an operation of the plan.

const HOST = 'site-0a1b2c3d-chat-0a1b2c.localhost'
const stateOf = (text: { title: string; content: string; excerpt: string }) => {
  const fields = { version: 1 as const, objectRef: 'page:42', kind: 'page' as const, ...text }
  return {
    ...fields,
    stateHash: createHash('sha256').update(publishedContentHashMaterial(fields)).digest('hex'),
  }
}

function previewWriting(options: { siteContent?: boolean } = {}) {
  const scope: McpAccess = {
    keyId: randomUUID(),
    taskId: randomUUID(),
    siteId: randomUUID(),
    workspaceId: randomUUID(),
    sessionId: randomUUID(),
    turn: 3,
    epoch: 7,
    firstEpoch: 1,
    stack: 'wordpress',
    url: 'https://site.example.test/',
    preview: { id: randomUUID(), status: 'ready', database: true, hostname: HOST },
  }
  const target: McpPreviewTarget = {
    previewId: scope.preview!.id,
    siteId: scope.siteId,
    workspaceId: scope.workspaceId,
    stack: 'wordpress',
    hostname: HOST,
    upstream: { host: '127.0.0.1', port: 41_234 },
    writeEpoch: 4,
  }
  const before = stateOf({ title: 'До', content: '<p>Текст</p>', excerpt: '' })
  const after = stateOf({ title: 'После', content: '<p>Текст</p>', excerpt: '' })
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
    preview: { previewId: target.previewId, writeEpoch: target.writeEpoch },
  }
  const journal = {
    reserve: vi.fn<PostgresMcpJournal['reserve']>(async () => ({
      kind: 'claimed',
      callId,
      snapshot,
      preview: target,
    })),
    previewTarget: vi.fn<PostgresMcpJournal['previewTarget']>(async () => target),
    noteContentAccess: vi.fn<PostgresMcpJournal['noteContentAccess']>(async () => undefined),
    attachSnapshot: vi.fn<PostgresMcpJournal['attachSnapshot']>(async () => undefined),
    beginWrite: vi.fn<PostgresMcpJournal['beginWrite']>(async () => true),
    writeIntent: vi.fn<PostgresMcpJournal['writeIntent']>(async () => intent),
    finish: vi.fn<PostgresMcpJournal['finish']>(async () => undefined),
    markAmbiguous: vi.fn<PostgresMcpJournal['markAmbiguous']>(async () => undefined),
  }
  const states: PublishedContentState[] = [before, after]
  const preview = {
    read: vi.fn<PublishedContentGateway['read']>(async () => states.shift() ?? after),
    conditionalWrite: vi.fn<PublishedContentGateway['conditionalWrite']>(async (input) => ({
      version: 1 as const,
      kind: 'committed' as const,
      callId: input.callId,
      siteId: input.siteId,
      epoch: input.epoch,
      requestHash: input.requestHash,
      objectRef: input.objectRef,
      stateHash: after.stateHash,
    })),
    operation: vi.fn(),
    reconcileOperation: vi.fn(),
    forgetOperation: vi.fn(),
  }
  const values = {
    save: vi.fn<McpPreviewContent['values']['save']>(async (ref) => ({
      key: previewDbValueKey(ref),
      sha256: ref.side === 'before' ? 'd'.repeat(64) : 'e'.repeat(64),
      sizeBytes: 300,
    })),
  }
  const resolvePreview = vi.fn(async () => preview as unknown as PublishedContentGateway)
  const resolveSite = vi.fn(async () => {
    throw new Error('The site must not be reached')
  })
  const mask = vi.fn<ContentPrivacy['mask']>(async (_scope, fields) => ({ ...fields }))
  const service = new McpContentService(
    journal as unknown as PostgresMcpJournal,
    {
      save: vi.fn(async (reference) => ({
        ...reference,
        payloadSha256: 'c'.repeat(64),
        sizeBytes: 1,
      })),
    } as unknown as ContentSnapshotStorage,
    {
      mask,
      rehydrate: async (_scope: unknown, patch: Record<string, string>) => ({ ...patch }),
    } as unknown as ContentPrivacy,
    resolveSite,
    {
      ...(options.siteContent === undefined ? {} : { siteContent: options.siteContent }),
      previews: { resolve: resolvePreview, values },
    },
  )
  const post = (body: Record<string, string> = { title: 'После' }) =>
    service.wpRest(scope, {
      method: 'POST',
      route: '/wp/v2/pages/42',
      body,
      idempotencyKey: randomUUID(),
    })
  return {
    scope,
    target,
    before,
    after,
    callId,
    journal,
    preview,
    values,
    resolvePreview,
    resolveSite,
    service,
    post,
    states,
  }
}

describe('content into the preview of the dialog', () => {
  it('reads through the preview, never the site', async () => {
    const f = previewWriting()
    expect(await f.service.wpRest(f.scope, { method: 'GET', route: '/wp/v2/pages/42' })).toEqual({
      result: 'ok',
      response: { objectRef: 'page:42', title: 'До', content: '<p>Текст</p>', excerpt: '' },
    })
    expect(f.journal.previewTarget).toHaveBeenCalledExactlyOnceWith(f.scope)
    expect(f.resolvePreview).toHaveBeenCalledExactlyOnceWith(f.target)
    expect(f.resolveSite).not.toHaveBeenCalled()
  })

  it('writes under the write epoch of the preview to the copy of the plugin bound to it', async () => {
    const f = previewWriting()
    expect(await f.post()).toEqual({
      result: 'ok',
      appliedStateHash: f.after.stateHash,
      response: { objectRef: 'page:42', updated: true, snapshotId: expect.any(String) },
    })
    expect(f.preview.conditionalWrite).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        siteId: f.target.previewId,
        epoch: f.target.writeEpoch,
        expectedStateHash: f.before.stateHash,
        fields: { title: 'После' },
        mode: 'edit',
      }),
    )
    expect(f.resolveSite).not.toHaveBeenCalled()
  })

  it('records the write as an operation of the plan: the fields it changed and both states', async () => {
    const f = previewWriting()
    await f.post()
    const value = {
      workspaceId: f.scope.workspaceId,
      taskId: f.scope.taskId,
      previewId: f.target.previewId,
      callId: f.callId,
      objectRef: 'page:42',
    }
    expect(f.values.save.mock.calls).toEqual([
      [{ ...value, side: 'before' }, f.before],
      [{ ...value, side: 'after' }, f.after],
    ])
    expect(f.journal.finish).toHaveBeenCalledExactlyOnceWith(
      f.scope,
      f.callId,
      expect.objectContaining({ result: 'ok', appliedStateHash: f.after.stateHash }),
      {
        kind: 'content_update',
        fields: ['title'],
        beforeHash: f.before.stateHash,
        afterHash: f.after.stateHash,
        before: {
          key: previewDbValueKey({ ...value, side: 'before' }),
          sha256: 'd'.repeat(64),
          sizeBytes: 300,
        },
        after: {
          key: previewDbValueKey({ ...value, side: 'after' }),
          sha256: 'e'.repeat(64),
          sizeBytes: 300,
        },
      },
    )
    // The state after is the written fields over the state before: no second read.
    expect(f.preview.read).toHaveBeenCalledOnce()
  })

  it('reads the object back when the plugin stored another value, and keeps that state', async () => {
    const f = previewWriting()
    const filtered = stateOf({ title: 'После (filtered)', content: '<p>Текст</p>', excerpt: '' })
    f.preview.conditionalWrite.mockImplementationOnce(async (input) => ({
      version: 1,
      kind: 'committed',
      callId: input.callId,
      siteId: input.siteId,
      epoch: input.epoch,
      requestHash: input.requestHash,
      objectRef: input.objectRef,
      stateHash: filtered.stateHash,
    }))
    f.states.splice(0, f.states.length, f.before, filtered)
    await f.post()
    expect(f.values.save.mock.calls[1]![1]).toEqual(filtered)
    // A read that shows yet another state is an unknown outcome: the preview's reset closes it.
    const g = previewWriting()
    g.preview.conditionalWrite.mockImplementationOnce(async (input) => ({
      version: 1,
      kind: 'committed',
      callId: input.callId,
      siteId: input.siteId,
      epoch: input.epoch,
      requestHash: input.requestHash,
      objectRef: input.objectRef,
      stateHash: filtered.stateHash,
    }))
    await expect(g.post()).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    expect(g.journal.markAmbiguous).toHaveBeenCalledExactlyOnceWith(g.scope, g.callId)
    expect(g.journal.finish).not.toHaveBeenCalled()
  })

  it('never keeps a state read back that breaks the rules of the agent’s own input', async () => {
    // The preview runs the agent's code: a plugin of its own may answer any receipt and any
    // state that matches it. What it says it stored is held to the rules of `wp_rest`.
    for (const content of [
      '<a href="http://site-ffff1111-chat-ffff11.localhost:8090/">Другой</a>',
      `<p>${newTurnKeys().llmApiKey}</p>`,
    ]) {
      const f = previewWriting()
      const forged = stateOf({ title: 'После', content, excerpt: '' })
      f.preview.conditionalWrite.mockImplementationOnce(async (input) => ({
        version: 1,
        kind: 'committed',
        callId: input.callId,
        siteId: input.siteId,
        epoch: input.epoch,
        requestHash: input.requestHash,
        objectRef: input.objectRef,
        stateHash: forged.stateHash,
      }))
      f.states.splice(0, f.states.length, f.before, forged)
      await expect(f.post(), content).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
      // Unknown, closed by the reset of the preview; nothing of it in the plan.
      expect(f.journal.markAmbiguous).toHaveBeenCalledExactlyOnceWith(f.scope, f.callId)
      expect(f.journal.finish).not.toHaveBeenCalled()
      expect(f.values.save).not.toHaveBeenCalled()
    }
  })

  it('records a write that changed nothing without an operation', async () => {
    const f = previewWriting()
    f.preview.conditionalWrite.mockImplementationOnce(async (input) => ({
      version: 1,
      kind: 'committed',
      callId: input.callId,
      siteId: input.siteId,
      epoch: input.epoch,
      requestHash: input.requestHash,
      objectRef: input.objectRef,
      stateHash: f.before.stateHash,
    }))
    await f.post({ title: 'До' })
    expect(f.values.save).not.toHaveBeenCalled()
    expect(f.journal.finish.mock.calls[0]![3]).toBeNull()
  })

  it('refuses a value that names the preview, before anything is reserved', async () => {
    const f = previewWriting()
    const [label, base] = [HOST.slice(0, HOST.indexOf('.')), HOST.slice(HOST.indexOf('.') + 1)]
    for (const content of [
      `<a href="http://${HOST}:8090/about/">О нас</a>`,
      `<img src="//${HOST.toUpperCase()}/x.png">`,
      // Spellings a browser reads as the same host.
      `<a href="http://${label}%2E${base}/">О нас</a>`,
      `<a href="http://${label}%252e${base}/">О нас</a>`,
      `<a href="http://${label}&#46;${base}/">О нас</a>`,
      `<a href="http://${label}&#x2E;${base}/">О нас</a>`,
      `<a href="http://${label}&period;${base}/">О нас</a>`,
      `<a href="http://${label}&amp;#46;${base}/">О нас</a>`,
      `<a href="http://${label.replaceAll('-', '%2d')}.${base}/">О нас</a>`,
      `<a href="http://${label}\u3002${base}/">О нас</a>`,
      `<a href="http://${label}\uff0e${base}/">О нас</a>`,
      `<a href="http://${label}.\n${base}/">О нас</a>`,
      `<a href="http://${label.slice(0, 4)}\u00ad${label.slice(4)}.${base}/">О нас</a>`,
      `<a href="http://${[...HOST.toUpperCase()].map((c) => (/[A-Z]/.test(c) ? String.fromCodePoint(c.codePointAt(0)! + 0xfee0) : c)).join('')}/">О нас</a>`,
      // Another preview of the same base: no less temporary.
      '<a href="http://site-ffff1111-chat-ffff11.localhost:8090/">Другой</a>',
    ])
      await expect(f.post({ content }), content).rejects.toMatchObject({
        code: 'CONTENT_PREVIEW_ORIGIN',
      })
    await expect(f.post({ content: newTurnKeys().mcpToken })).rejects.toMatchObject({
      code: 'CONTENT_CREDENTIAL_REFUSED',
    })
    expect(f.journal.reserve).not.toHaveBeenCalled()
    // The site's own address is what links inside content keep.
    await f.post({ content: '<a href="https://site.example.test/about/">О нас</a>' })
    expect(f.journal.reserve).toHaveBeenCalledOnce()
  })

  it('refuses a change it could not keep as an operation, before it is written', async () => {
    const f = previewWriting()
    // The object holds a long excerpt: a text that fits a patch makes a state that does not.
    f.states.splice(
      0,
      f.states.length,
      stateOf({ title: 'До', content: '', excerpt: 'э'.repeat(1_000) }),
    )
    expect(await f.post({ content: 'ж'.repeat(16_000) })).toEqual({
      result: 'error',
      response: { code: 'CONTENT_TOO_LARGE' },
    })
    expect(f.journal.beginWrite).not.toHaveBeenCalled()
    expect(f.preview.conditionalWrite).not.toHaveBeenCalled()
  })

  it('never writes the site of a dialog without a preview where previews are configured', async () => {
    const f = previewWriting({ siteContent: false })
    const scope = { ...f.scope, preview: null }
    await expect(
      f.service.wpRest(scope, { method: 'GET', route: '/wp/v2/pages/42' }),
    ).rejects.toMatchObject({ code: 'CONTENT_PREVIEW_UNAVAILABLE' })
    await expect(
      f.service.restore(scope, { snapshotId: randomUUID(), idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ code: 'CONTENT_PREVIEW_UNAVAILABLE' })
    expect(f.resolveSite).not.toHaveBeenCalled()
    expect(f.journal.reserve).not.toHaveBeenCalled()
  })
})
