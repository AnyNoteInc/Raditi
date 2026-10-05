import type { AgentDriver } from '@repo/domain'
import { notImplemented, SANDBOX_AGENT_HOME } from '@repo/domain'
import { parseAgentDriverConfig, type AgentDriverConfig } from './config.ts'
import { extractJsonResult } from './jsonl.ts'
import { parseOpencodeEvent } from './opencode-events.ts'

// OpenCode (opencode-ai 1.18), a fallback — spec §8, §9; verified in P5.
//   opencode run --format json [--session <id>]
//   moving a session: opencode export <id> / opencode import <file> is sturdier than its data dir
//   permissions via OPENCODE_PERMISSION (JSON); any provider from the config
//   HOME=/agent-home/opencode; the data dir ~/.local/share/opencode holds opencode.db (SQLite:
//     sessions, messages, parts) next to auth.json (provider keys), log/, repos/ and snapshot/;
//     binaries live in ~/.cache/opencode/bin, the config with the provider in ~/.config/opencode

const home = `${SANDBOX_AGENT_HOME}/opencode`
const dataDir = '.local/share/opencode'

/**
 * An allowlist of the session database only (and its WAL, in case the CLI was killed before a
 * checkpoint): auth.json, config, logs, git snapshots and binaries never reach home.tar.zst.
 */
const sessionFiles = [`${dataDir}/opencode.db`, `${dataDir}/opencode.db-wal`]
const todo = (method: string) => notImplemented(`opencode.${method} (P5)`)

export function createOpencodeDriver(config: AgentDriverConfig): AgentDriver {
  const { image } = parseAgentDriverConfig(config)
  return {
    id: 'opencode',
    image,
    capabilities: { resume: true, jsonEvents: true, outputSchema: false, mcp: true, images: false },
    async prepare() {
      throw todo('prepare')
    },
    command() {
      throw todo('command')
    },
    parseEvent: parseOpencodeEvent,
    sessionState() {
      // Stable-channel filenames confirmed in 1.18.32. P5 can use export/import instead.
      // The CLI must be stopped before taking the db + WAL snapshot.
      return { root: home, include: [...sessionFiles], exclude: [] }
    },
    extractResult: extractJsonResult,
  }
}
