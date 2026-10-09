import { sessionStateSchema, type AgentDriver, type PreparedRun } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { createCodexDriver } from './codex.ts'
import { createKimiDriver } from './kimi.ts'
import { createOpencodeDriver } from './opencode.ts'
import { createQwenDriver } from './qwen.ts'
import { KIMI_WORKDIR_KEY } from './session-paths.ts'

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
const drivers = [createCodexDriver, createKimiDriver, createQwenDriver, createOpencodeDriver].map(
  (create) => create(config),
)
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

  it('keeps Codex rollout data without copying the surrounding home', () => {
    const driver = createCodexDriver(config)
    expect(includes(driver, `sessions/2026/09/26/rollout-2026-09-26-${sid}.jsonl`)).toBe(true)
    for (const path of [
      'config.toml',
      'auth.json',
      'log/codex.log',
      'state_5.sqlite',
      'history.jsonl',
    ])
      expect(includes(driver, path)).toBe(false)
  })

  it('keeps the external Kimi index and the selected conversation, excluding session logs/tasks', () => {
    const driver = createKimiDriver(config)
    const dir = `sessions/${KIMI_WORKDIR_KEY}/${sid}`
    expect(driver.sessionState(run).include).toEqual([
      'session_index.jsonl',
      `${dir}/state.json`,
      `${dir}/agents`,
    ])
    for (const path of [
      'session_index.jsonl',
      `${dir}/agents/main/wire.jsonl`,
      `${dir}/agents/agent-0/wire.jsonl`,
    ])
      expect(includes(driver, path)).toBe(true)
    for (const path of [
      'credentials/provider.json',
      'mcp.json',
      'config.toml',
      'logs/kimi-code.log',
      `${dir}/logs/kimi-code.log`,
      `${dir}/tasks/task.json`,
      `${dir}/cron/cron.json`,
      `sessions/${KIMI_WORKDIR_KEY}/other/state.json`,
    ])
      expect(includes(driver, path)).toBe(false)
  })

  it('keeps only the selected Qwen chat at the fixed container cwd', () => {
    const driver = createQwenDriver(config)
    expect(driver.sessionState(run).include).toEqual([
      `.qwen/projects/-workspace-repo/chats/${sid}.jsonl`,
    ])
    for (const path of [
      '.qwen/settings.json',
      '.qwen/oauth_creds.json',
      '.qwen/.env',
      '.qwen/projects/-workspace-repo/settings.json',
      '.qwen/projects/-workspace-repo/chats/other.jsonl',
      `.qwen/projects/-workspace-repo/chats/${sid}.runtime.json`,
    ])
      expect(includes(driver, path)).toBe(false)
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

  it.each([createKimiDriver(config), createQwenDriver(config)])(
    '$id refuses to broaden capture when the native id is absent or unsafe',
    (driver) => {
      for (const nativeSessionId of [
        undefined,
        '../secret',
        'a/b',
        'a\\b',
        '.',
        '..',
        'x'.repeat(201),
      ]) {
        expect(() =>
          driver.sessionState({ ...run, context: { ...run.context, nativeSessionId } }),
        ).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }))
      }
    },
  )
})
