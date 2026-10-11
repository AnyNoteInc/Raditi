import { sessionStateSchema, type AgentDriver, type PreparedRun } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { createAgentDrivers } from './registry.ts'
import { createOpencodeDriver } from './opencode.ts'

const sid = '01960000-0000-7000-8000-000000000001'
const run: PreparedRun = {
  context: {
    taskId: 't',
    sessionId: 's',
    turn: 1,
    nativeSessionId: sid,
    instructions: '',
    llm: { baseUrl: 'http://sandbox-gw/llm', apiKey: 'test-only-key', model: 'model' },
    mcp: { url: 'http://sandbox-gw/mcp', token: 'test-only-token' },
  },
  files: [],
  env: {},
  secrets: [],
}
const config = { image: `raditi/sbx-wordpress@sha256:${'a'.repeat(64)}` }
const drivers = createAgentDrivers(config)
const includes = (driver: AgentDriver, path: string) => {
  const state = driver.sessionState(run)
  return (
    state.include.some((allowed) => path === allowed || path.startsWith(`${allowed}/`)) &&
    !state.exclude.some((excluded) => path === excluded || path.startsWith(`${excluded}/`))
  )
}

describe('native session snapshot allowlists', () => {
  it.each(drivers)('$id uses literal paths compatible with the snapshot validator', (driver) => {
    expect(sessionStateSchema.safeParse(driver.sessionState(run)).success).toBe(true)
  })

  it('keeps OpenCode stable database + WAL but not auth, config, logs or source snapshots', () => {
    const driver = createOpencodeDriver(config)
    for (const path of [
      '.local/share/opencode/opencode.db',
      '.local/share/opencode/opencode.db-wal',
    ])
      expect(includes(driver, path)).toBe(true)
    for (const path of [
      '.local/share/opencode/auth.json',
      '.local/share/opencode/opencode.db-shm',
      '.config/opencode/opencode.json',
      '.config/opencode/AGENTS.md',
      'io-config/opencode/opencode.json',
      'session-export.json',
      'run.mjs',
      'prompt.txt',
      '.local/share/opencode/log/trace.log',
      '.local/share/opencode/repos/private',
      '.local/share/opencode/snapshot/private',
      '.cache/opencode/bin/rg',
      // Where the pinned CLI imports code from at start: a turn must not leave any of it for
      // the next one, which gets a new home with these two database files only.
      '.opencode/tool/planted.js',
      '.opencode/tools/planted.ts',
      '.config/opencode/plugin/planted.js',
      '.config/opencode/plugins/planted.ts',
      '.config/opencode/tool/planted.js',
      '.config/opencode/opencode.jsonc',
      '.local/share/opencode/bin/rg',
    ])
      expect(includes(driver, path)).toBe(false)
  })
})
