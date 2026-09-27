// A runner's sandbox side for *.test.ts files: a LocalTurnExecutor over a fake Docker whose
// agent prints three events, the last one only once the test lets it finish.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import {
  MAX_SANDBOX_TURN_MS,
  SANDBOX_SECRETS_DIR,
  type AgentEvent,
  type ExecCursor,
  type ExecHandle,
  type Sandbox,
  type SandboxInfo,
  type TurnBundleSource,
  type TurnPrepareInput,
} from '@repo/domain'
import { vi } from 'vitest'

import { emptyUntrackedArchive } from '../git-workspace/archive.ts'
import type { PresignedTransfer } from '../sessions/presigned-transfer.ts'
import { LocalTurnExecutor } from '../turns/local-turn-executor.ts'

export const siteId = '00000000-0000-4000-8000-000000000002'
export const taskId = '00000000-0000-4000-8000-000000000003'
export const fence = { siteId, taskId, operation: 'turn' as const, epoch: 1 }
export const labels = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  siteId,
  taskId,
  sessionId: 'session1',
  turn: 1,
}
export const image = `registry.invalid/raditi/codex@sha256:${'a'.repeat(64)}`
export const baseSha = 'b'.repeat(40)
export const branch = `agent/${taskId}`
export const home = { root: '/agent-home/codex', include: ['sessions'], exclude: [] }
export const credentials = ['synthetic-llm-secret', 'synthetic-mcp-secret']
export const events: AgentEvent[] = [
  { type: 'started', nativeSessionId: 'native1' },
  { type: 'message', text: 'Готово' },
  { type: 'completed' },
]
const line = (event: AgentEvent) => JSON.stringify(event) + '\n'
/** What the agent prints before a test lets it finish, and after. */
export const first = Buffer.from(line(events[0]!) + line(events[1]!))
export const rest = Buffer.from(line(events[2]!))
export const bundleBytes = Buffer.from('synthetic bundle')
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** A container whose agent prints `first`, then `rest` once it is let finish. */
export function sandboxSide() {
  const gate = Promise.withResolvers<void>()
  const handle = (from: number): ExecHandle => ({
    id: 'exec1',
    output: async function* () {
      if (from < first.byteLength) {
        yield { stream: 'stdout' as const, offset: from, data: first.subarray(from) }
        await gate.promise
      }
      const at = Math.max(from, first.byteLength)
      if (at < first.byteLength + rest.byteLength)
        yield { stream: 'stdout' as const, offset: at, data: rest.subarray(at - first.byteLength) }
    },
    wait: async () => {
      await gate.promise
      return { code: 0, reason: 'exited' as const }
    },
    kill,
  })
  const kill = vi.fn(async () => gate.resolve())
  const sandbox: Sandbox = {
    id: 'container1',
    labels: { ...labels, leaseEpoch: 1 },
    exec: vi.fn(async () => handle(0)),
    attach: vi.fn(async (_execId: string, cursor?: ExecCursor) => handle(cursor?.stdout ?? 0)),
    fs: { write: vi.fn(async () => {}), read: vi.fn(), list: vi.fn(), remove: vi.fn() },
    quiesce: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  }
  const sandboxes = {
    kind: 'docker' as const,
    create: vi.fn(async () => sandbox),
    get: vi.fn(async (id: string): Promise<Sandbox | null> => (id === sandbox.id ? sandbox : null)),
    list: vi.fn(async (): Promise<SandboxInfo[]> => [
      { id: sandbox.id, labels: sandbox.labels, createdAt: new Date() },
    ]),
  }
  const archives = {
    home: Buffer.from('home archive'),
    patch: Buffer.from('tracked-patch'),
    untracked: emptyUntrackedArchive(),
  }
  const snapshot = { capture: vi.fn(async () => archives), restore: vi.fn(async () => {}) }
  const transfer = {
    get: vi.fn<PresignedTransfer['get']>(async () => {
      throw new Error('No presigned object in this test')
    }),
    put: vi.fn<PresignedTransfer['put']>(async () => {}),
  }
  const importBundle = vi.fn(async (_sandbox: Sandbox, _bundle: TurnBundleSource) => {})
  const executor = new LocalTurnExecutor({
    sandboxes,
    parser: () => ({ parseEvent: (text) => [JSON.parse(text) as AgentEvent] }),
    transport: snapshot,
    transfer,
    importBundle,
  })
  return {
    sandbox,
    sandboxes,
    kill,
    archives,
    snapshot,
    transfer,
    importBundle,
    executor,
    /** The agent ends. */
    finish: () => gate.resolve(),
  }
}

export const sandboxSpec = (leaseEpoch = 1) => ({
  image,
  labels: { ...labels, leaseEpoch },
  runtime: 'runc' as const,
  resources: { cpu: 1, memoryMiB: 256, pids: 64 },
  user: { uid: 10001, gid: 10001 },
  env: {},
  secrets: [],
  network: { mode: 'none' as const },
  hardTimeoutMs: 60_000,
})

export const prepared = {
  files: [{ path: '/agent-home/codex/config.toml', content: 'synthetic = true' }],
  env: {},
  secrets: [{ path: `${SANDBOX_SECRETS_DIR}/llm`, content: credentials[0]! }],
}

export const prepareInput = (assignmentId: string): TurnPrepareInput => ({
  assignmentId,
  fence,
  sandbox: sandboxSpec(),
  remainingMs: MAX_SANDBOX_TURN_MS,
  bundle: {
    baseSha,
    branch,
    sha256: sha256(bundleBytes),
    sizeBytes: bundleBytes.byteLength,
    read: async function* () {
      yield Buffer.from(bundleBytes)
    },
  },
  driverId: 'codex',
  prepared,
  argv: ['synthetic-agent'],
  credentials,
  created: vi.fn(async () => {}),
})
