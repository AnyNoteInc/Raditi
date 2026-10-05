import type { AgentCapabilities, AgentDriver, AgentDriverId } from '@repo/domain'
import { agentDriverIds, SANDBOX_AGENT_HOME } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { createCodexDriver } from './codex.ts'
import { createKimiDriver } from './kimi.ts'
import { createOpencodeDriver } from './opencode.ts'
import { createQwenDriver } from './qwen.ts'

const config = { image: `registry.local:3300/raditi/sbx-wordpress@sha256:${'a'.repeat(64)}` }

const expected: Array<{
  create: (c: typeof config) => AgentDriver
  id: AgentDriverId
  task: string
  capabilities: AgentCapabilities
  /** Credential and config files under the driver home that must never be snapshotted. */
  private: string[]
}> = [
  {
    create: createCodexDriver,
    id: 'codex',
    task: 'P4',
    capabilities: { resume: true, jsonEvents: true, outputSchema: true, mcp: true, images: true },
    private: ['auth.json', 'config.toml', 'log/codex-tui.log'],
  },
  {
    create: createKimiDriver,
    id: 'kimi',
    task: 'P5',
    capabilities: { resume: true, jsonEvents: true, outputSchema: false, mcp: true, images: false },
    private: ['credentials/kimi.json', 'config.toml', 'logs/kimi.log', 'bin/rg'],
  },
  {
    create: createQwenDriver,
    id: 'qwen',
    task: 'P5',
    capabilities: { resume: true, jsonEvents: true, outputSchema: false, mcp: true, images: false },
    private: ['.qwen/settings.json', '.qwen/oauth_creds.json', '.qwen/.env'],
  },
  {
    create: createOpencodeDriver,
    id: 'opencode',
    task: 'P5',
    capabilities: { resume: true, jsonEvents: true, outputSchema: false, mcp: true, images: false },
    private: [
      '.local/share/opencode/auth.json',
      '.local/share/opencode/log/opencode.log',
      '.local/share/opencode/snapshot/x',
      '.config/opencode/opencode.json',
      '.cache/opencode/bin/rg',
    ],
  },
]

const run = {
  context: {
    taskId: 't',
    sessionId: 's',
    nativeSessionId: '01960000-0000-7000-8000-000000000001',
    turn: 1,
    llm: {
      baseUrl: 'http://sandbox-gw:8080/codex',
      apiKey: 'k',
      model: 'm',
      reasoningEffort: 'medium' as const,
    },
    mcp: { url: 'http://sandbox-gw:8080/mcp', token: 'x' },
    instructions: '',
  },
  files: [],
  env: {},
  secrets: [],
}

describe.each(expected)('$id driver', ({ create, id, task, capabilities, private: secrets }) => {
  const driver = create(config)

  it('matches the port: id, image and capabilities', () => {
    expect(agentDriverIds).toContain(driver.id)
    expect(driver.id).toBe(id)
    expect(driver.image).toBe(config.image)
    expect(driver.capabilities).toStrictEqual(capabilities)
  })

  it('keeps the native session under its own /agent-home directory', () => {
    const state = driver.sessionState(run)
    expect(state.root).toBe(`${SANDBOX_AGENT_HOME}/${id}`)
    expect(state.include.length).toBeGreaterThan(0)
    for (const path of [...state.include, ...state.exclude]) {
      expect(path).not.toMatch(/^\/|(^|\/)\.\.(\/|$)/)
    }
  })

  it('snapshots an allowlist that never covers credentials, config, logs or binaries', () => {
    const { include } = driver.sessionState(run)
    for (const path of include) {
      expect(path).not.toBe('')
      for (const secret of secrets) {
        expect(secret === path || secret.startsWith(`${path}/`)).toBe(false)
      }
    }
  })

  if (id !== 'codex' && id !== 'kimi')
    it(`leaves the CLI-specific parts to ${task}`, async () => {
      await expect(driver.prepare(run.context)).rejects.toMatchObject({
        code: 'NOT_IMPLEMENTED',
        message: expect.stringContaining(`${id}.prepare (${task})`),
      })
      expect(() => driver.command(run, { prompt: 'p', attachments: [] })).toThrow(
        `${id}.command (${task})`,
      )
      expect(driver.parseEvent('{}')).toEqual([])
      expect(driver.extractResult([], null)).toBeNull()
    })

  it('rejects an empty image', () => {
    expect(() => create({ image: '' })).toThrow(/Invalid agent driver configuration/)
  })
})
