import { describe, expect, it } from 'vitest'
import { badRequest, DomainError, sandboxCommandFailed } from '../errors.ts'
import type { SandboxSpec } from './sandbox-provider.ts'
import {
  assertSandboxSpec,
  createLeftNothing,
  leftNothing,
  MAX_SANDBOX_RESOURCES,
  MAX_SANDBOX_TURN_MS,
  sandboxSpecSchema,
} from './sandbox-provider.ts'

const digest = 'a'.repeat(64)

const valid = (): SandboxSpec => ({
  image: `registry.raditi.local:3300/raditi/sbx-wordpress@sha256:${digest}`,
  labels: {
    workspaceId: '0199a0c4-7d2e-7c3a-9f1e-3b2a1c0d9e8f',
    siteId: 'site-1',
    taskId: 'task_1',
    sessionId: 's1',
    turn: 1,
  },
  runtime: 'runsc',
  resources: { cpu: 2, memoryMiB: 4096, pids: 512 },
  user: { uid: 10001, gid: 10001 },
  env: { HOME: '/agent-home/opencode', OPENCODE_DISABLE_AUTOUPDATE: '1', LANG: 'C.UTF-8' },
  secrets: [{ path: '/run/raditi/secrets/llm-key', value: 'sk-turn-key-0123456789abcdef' }],
  network: { mode: 'gateway', routes: ['llm', 'mcp'] },
  hardTimeoutMs: MAX_SANDBOX_TURN_MS,
})

const rejects = (patch: Partial<SandboxSpec>) =>
  expect(sandboxSpecSchema.safeParse({ ...valid(), ...patch }).success).toBe(false)

describe('sandboxSpecSchema', () => {
  it('accepts a spec at the limits of CLAUDE.md rule 5', () => {
    expect(sandboxSpecSchema.parse(valid())).toEqual(valid())
    expect(MAX_SANDBOX_RESOURCES).toEqual({ cpu: 2, memoryMiB: 4096, pids: 512 })
    expect(MAX_SANDBOX_TURN_MS).toBe(1_200_000)
  })

  it('accepts less than the limits and no network at all', () => {
    const spec = {
      ...valid(),
      image: `raditi/agent-opencode@sha256:${digest}`,
      runtime: 'runc' as const,
      resources: { cpu: 0.5, memoryMiB: 512, pids: 64 },
      network: { mode: 'none' as const },
      hardTimeoutMs: 60_000,
      env: {},
      secrets: [],
    }
    expect(sandboxSpecSchema.safeParse(spec).success).toBe(true)
  })

  it.each([
    'raditi/sbx-wordpress',
    'raditi/sbx-wordpress:latest',
    `raditi/sbx-wordpress:1.0@sha256:${digest}`,
    `raditi/sbx-wordpress@sha256:${'a'.repeat(63)}`,
    `raditi/sbx-wordpress@sha256:${'A'.repeat(64)}`,
    `raditi/sbx-wordpress@sha512:${digest}`,
    `Raditi/Sbx@sha256:${digest}`,
  ])('rejects the image %s: it must be pinned by digest', (image) => {
    rejects({ image })
  })

  it('runs only as uid:gid 10001', () => {
    rejects({ user: { uid: 0, gid: 0 } })
    rejects({ user: { uid: 10001, gid: 0 } })
    rejects({ user: { uid: 1000, gid: 10001 } })
  })

  it('caps cpu, memory, processes and the turn time', () => {
    rejects({ resources: { cpu: 2.5, memoryMiB: 4096, pids: 512 } })
    rejects({ resources: { cpu: 2, memoryMiB: 4097, pids: 512 } })
    rejects({ resources: { cpu: 2, memoryMiB: 4096, pids: 513 } })
    rejects({ resources: { cpu: 0, memoryMiB: 4096, pids: 512 } })
    rejects({ hardTimeoutMs: MAX_SANDBOX_TURN_MS + 1 })
    rejects({ hardTimeoutMs: 0 })
  })

  it('allows only sandbox-gw with the llm and mcp routes', () => {
    rejects({ network: { mode: 'gateway', routes: [] } })
    rejects({ network: { mode: 'gateway', routes: ['llm', 'llm'] } })
    rejects({ network: { mode: 'gateway', routes: ['s3'] } as never })
    rejects({ network: { mode: 'bridge' } as never })
    rejects({ network: { mode: 'none', routes: ['llm'] } as never })
  })

  it.each([
    'ZAI_API_KEY',
    'LLM_GATEWAY_KEY',
    'MCP_TOKEN',
    'GITHUB_TOKEN',
    'CLIENT_SECRET',
    'DB_PASSWORD',
    'DB_PASS',
    'AWS_CREDENTIALS',
    'api_key',
  ])('refuses the credential-like env name %s', (name) => {
    rejects({ env: { [name]: 'x' } })
  })

  it.each([
    ['LLM', 'sk-0123456789abcdefXYZ'],
    ['DATABASE_URL', 'postgres://raditi:hunter2@db:5432/raditi'],
    ['REMOTE', 'https://oauth2:abc@git.example.ru/site.git'],
    ['BEARER', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig'],
    ['GH', `ghp_${'a'.repeat(36)}`],
    ['VAULT', `hvs.${'a'.repeat(24)}`],
    ['YC', `AQVN${'a'.repeat(36)}`],
    ['CERT', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc'],
  ])('refuses %s whose value looks like a credential', (name, value) => {
    rejects({ env: { [name]: value } })
  })

  it('refuses invalid env names', () => {
    rejects({ env: { '1BAD': 'x' } })
    rejects({ env: { 'A-B': 'x' } })
    rejects({ env: { 'A=B': 'x' } })
  })

  it('keeps secret files outside the snapshotted /workspace, absolute and unique', () => {
    for (const path of [
      '/workspace/repo/.env',
      '/agent-home/opencode/.local/share/opencode/auth.json',
      '/agent-home',
      '/workspace',
      'run/secrets/key',
      '/run/secrets/../key',
      '/run//secrets',
      '/run/secrets/',
    ]) {
      rejects({ secrets: [{ path, value: 'v' }] })
    }
    rejects({
      secrets: [
        { path: '/run/s/a', value: 'v' },
        { path: '/run/s/a', value: 'w' },
      ],
    })
    rejects({ secrets: [{ path: '/run/s/a', value: '' }] })
  })

  it('refuses unknown fields and labels unsafe for container names', () => {
    expect(sandboxSpecSchema.safeParse({ ...valid(), privileged: true }).success).toBe(false)
    rejects({ labels: { ...valid().labels, taskId: 'a/b' } })
    rejects({ labels: { ...valid().labels, taskId: '' } })
    rejects({ labels: { ...valid().labels, turn: 0 } })
  })
})

describe('assertSandboxSpec', () => {
  it('returns a valid spec', () => {
    expect(assertSandboxSpec(valid())).toEqual(valid())
  })

  it('throws BAD_REQUEST naming the violations but never the values', () => {
    const spec = {
      ...valid(),
      user: { uid: 0, gid: 0 },
      env: { LLM_API_KEY: 'sk-top-secret-value-123456', URL: 'https://u:top-secret@h' },
    }
    let error: unknown
    try {
      assertSandboxSpec(spec)
    } catch (e) {
      error = e
    }
    expect(error).toMatchObject({ code: 'BAD_REQUEST', httpStatus: 400 })
    const text = `${String(error)} ${JSON.stringify((error as { details: unknown }).details)}`
    expect(text).toMatch(/user\.uid/)
    expect(text).toMatch(/LLM_API_KEY/)
    expect(text).toMatch(/env URL/)
    expect(text).not.toContain('top-secret')
  })
})

describe('leftNothing', () => {
  it('marks a failed create that provably left no container, keeping the error', () => {
    const marked = leftNothing(sandboxCommandFailed())
    expect(marked).toMatchObject({
      code: 'SANDBOX_COMMAND_FAILED',
      httpStatus: 502,
      message: sandboxCommandFailed().message,
      details: { leftNothing: true },
    })
    expect(createLeftNothing(marked)).toBe(true)
    const issues = [{ path: 'image', message: 'bad' }]
    expect(leftNothing(badRequest('Invalid', issues)).details).toEqual({
      issues,
      leftNothing: true,
    })
    const detailed = new DomainError('CONFLICT', 'x', 409, { reason: 'r' })
    expect(leftNothing(detailed).details).toEqual({ reason: 'r', leftNothing: true })
  })

  it('proves nothing without the mark', () => {
    expect(createLeftNothing(sandboxCommandFailed())).toBe(false)
    expect(createLeftNothing(new DomainError('X', 'x', 500, { leftNothing: 'true' }))).toBe(false)
    expect(
      createLeftNothing(Object.assign(new Error('x'), { details: { leftNothing: true } })),
    ).toBe(false)
    expect(createLeftNothing(undefined)).toBe(false)
  })
})
