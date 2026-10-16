import type { AgentCapabilities } from '@repo/domain'
import { agentDriverIds, SANDBOX_AGENT_HOME } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { createOpencodeDriver } from './opencode.ts'

const config = { image: `registry.local:3300/raditi/sbx-wordpress@sha256:${'a'.repeat(64)}` }
const id = 'opencode'
const capabilities: AgentCapabilities = {
  resume: true,
  jsonEvents: true,
  outputSchema: false,
  mcp: true,
  images: false,
}
/** Credential and config files under the driver home that must never be snapshotted. */
const secrets = [
  '.local/share/opencode/auth.json',
  '.local/share/opencode/log/opencode.log',
  '.local/share/opencode/snapshot/x',
  '.config/opencode/opencode.json',
  '.config/opencode/AGENTS.md',
  'io-config/opencode/opencode.json',
  'session-export.json',
  'run.mjs',
  '.cache/opencode/bin/rg',
]

const run = {
  context: {
    taskId: 't',
    sessionId: 's',
    nativeSessionId: '01960000-0000-7000-8000-000000000001',
    turn: 1,
    llm: {
      baseUrl: 'http://sandbox-gw:8080/zai/v4',
      apiKey: 'k',
      model: 'm',
      reasoningEffort: 'high' as const,
    },
    mcp: { url: 'http://sandbox-gw:8080/mcp', token: 'x' },
    instructions: '',
  },
  files: [],
  env: {},
  secrets: [],
}

describe('opencode driver', () => {
  const driver = createOpencodeDriver(config)

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

  it('rejects an empty image', () => {
    expect(() => createOpencodeDriver({ image: '' })).toThrow(/Invalid agent driver configuration/)
  })
})
