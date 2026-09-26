import type { SandboxSpec } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { createDockerSandboxProvider } from './docker.ts'
import { defaultSandboxLimits } from './limits.ts'

const spec = (patch: Partial<SandboxSpec> = {}): SandboxSpec => ({
  image: `registry.local:3300/raditi/sbx-wordpress@sha256:${'0'.repeat(64)}`,
  labels: { workspaceId: 'w', siteId: 's', taskId: 't', sessionId: 'x', turn: 1 },
  runtime: 'runc',
  resources: { ...defaultSandboxLimits.resources },
  user: { ...defaultSandboxLimits.user },
  env: { LANG: 'C.UTF-8' },
  secrets: [{ path: '/run/raditi/llm-key', value: 'sk-per-turn-key-0123456789' }],
  network: { mode: 'gateway', routes: ['llm', 'mcp'] },
  hardTimeoutMs: defaultSandboxLimits.hardTimeoutMs,
  ...patch,
})

describe('createDockerSandboxProvider', () => {
  const provider = createDockerSandboxProvider({ runtime: 'runc', imagePrefix: 'raditi/agent' })

  it('is the docker provider', () => {
    expect(provider.kind).toBe('docker')
  })

  it('leaves create, get and list to P2', async () => {
    await expect(provider.get('id')).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
      message: expect.stringContaining('DockerSandboxProvider.get (P2)'),
    })
    await expect(provider.list()).rejects.toMatchObject({
      message: expect.stringContaining('DockerSandboxProvider.list (P2)'),
    })
    await expect(provider.create(spec())).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
      message: expect.stringContaining('DockerSandboxProvider.create (P2)'),
    })
  })

  it('enforces the sandbox policy before anything else, even now', async () => {
    for (const bad of [
      spec({ image: 'raditi/agent-codex' }),
      spec({ user: { uid: 0, gid: 0 } }),
      spec({ resources: { cpu: 4, memoryMiB: 4096, pids: 512 } }),
      spec({ hardTimeoutMs: 60 * 60 * 1000 }),
      spec({ env: { KIMI_MODEL_API_KEY: 'sk-per-turn-key-0123456789' } }),
      spec({ secrets: [{ path: '/workspace/repo/.env', value: 'x' }] }),
      {} as SandboxSpec,
    ]) {
      await expect(provider.create(bad)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    }
  })

  it('refuses a spec whose runtime differs from SANDBOX_RUNTIME', async () => {
    const gvisor = createDockerSandboxProvider({ runtime: 'runsc', imagePrefix: 'raditi/agent' })
    await expect(gvisor.create(spec({ runtime: 'runc' }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('SANDBOX_RUNTIME=runsc'),
    })
    await expect(gvisor.create(spec({ runtime: 'runsc' }))).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    })
  })
})
