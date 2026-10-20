import type { SandboxProvider } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { LocalTurnExecutor } from './local-turn-executor.ts'

// The working tree of a running turn for its preview (docs/plan/53-chat-preview-release.md,
// Р23): the local executor finds the container by its exact id and labels and leaves the agent
// running; the export itself is working-tree-export.ts.
vi.mock('./working-tree-export.ts', () => ({
  exportSandboxWorkingTree: vi.fn(async () => ({ archive: new Uint8Array([1]), deletes: ['x'] })),
}))
const { exportSandboxWorkingTree } = await import('./working-tree-export.ts')

const labels = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  siteId: '00000000-0000-4000-8000-000000000002',
  taskId: '00000000-0000-4000-8000-000000000003',
  sessionId: 'session1',
  turn: 2,
}
const signal = new AbortController().signal

function executor(found: { id: string; labels: Record<string, unknown> } | null) {
  const sandboxes = { get: vi.fn(async () => found) } as unknown as SandboxProvider
  return new LocalTurnExecutor({
    sandboxes,
    parser: () => ({ parseEvent: () => [] }),
    transport: {} as never,
    transfer: {} as never,
  })
}

describe('the working tree of a turn on the local executor', () => {
  it('exports the container of the turn against the base it got', async () => {
    const sandbox = { id: 'c1', labels: { ...labels, leaseEpoch: 4 } }
    const tree = await executor(sandbox).exportWorkingTree(
      {
        assignmentId: 'a1',
        containerId: 'c1',
        labels,
        baseSha: 'b'.repeat(40),
        addOnlyPaths: ['wp-content/uploads/raditi/'],
        alsoPaths: ['theme/a.php'],
      },
      signal,
    )
    expect(tree).toEqual({ archive: new Uint8Array([1]), deletes: ['x'] })
    expect(exportSandboxWorkingTree).toHaveBeenCalledWith(sandbox, {
      baseSha: 'b'.repeat(40),
      addOnlyPaths: ['wp-content/uploads/raditi/'],
      alsoPaths: ['theme/a.php'],
    })
  })

  it('refuses a container that is gone or of another turn', async () => {
    const input = { assignmentId: 'a1', containerId: 'c1', labels, baseSha: 'b'.repeat(40) }
    await expect(executor(null).exportWorkingTree(input, signal)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await expect(
      executor({ id: 'c1', labels: { ...labels, turn: 3 } }).exportWorkingTree(input, signal),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      executor({ id: 'c2', labels }).exportWorkingTree(input, signal),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
