/* global AbortController, process, setImmediate */
// The core process of verify-runner.mjs: the turn supervisor, the runner API and exec recovery
// over the local PostgreSQL, S3 and Vault, as P12 will wire them. The harness sends it turns over
// IPC and kills it with SIGKILL: only the database, S3, the Git remote and the runner VM outlive
// it. Started by verify-runner.mjs only, which sends its configuration as the first message.
import { randomUUID } from 'node:crypto'

import { createCodexDriver } from '@repo/agent-drivers'
import { createPrismaClient, PostgresSiteLeaseStore, PostgresTurnAssignmentStore } from '@repo/db'
import { SANDBOX_SECRETS_DIR } from '@repo/domain'
import { createS3ObjectStorage, storageConfigFromEnv } from '@repo/storage'
import { createVaultSecretStore, vaultConfigFromEnv } from '@repo/vault'

import { parseRunnerTokens } from '../dist/config/runner-tokens.js'
import { GitWorkspaceService } from '../dist/git-workspace/git-workspace.service.js'
import { RemoteTurnExecutor } from '../dist/runner-api/remote-turn-executor.js'
import { RunnerApiServer } from '../dist/runner-api/runner-api.server.js'
import { RunnerAuthenticator } from '../dist/runner-api/runner-auth.js'
import { RunnerHub } from '../dist/runner-api/runner-hub.js'
import { SnapshotService } from '../dist/sessions/snapshot.service.js'
import { LiveTurns } from '../dist/turns/live-turns.js'
import { TurnExecRecovery } from '../dist/turns/turn-exec-recovery.js'
import { TaskEventTurnJournal } from '../dist/turns/turn-journal.js'
import { TurnSupervisor } from '../dist/turns/turn-supervisor.js'

if (!process.send) throw new Error('Started by verify-runner.mjs only')
const { config } = await new Promise((resolve) => process.once('message', resolve))

/**
 * The synthetic agent, run by the runner as uid 10001 in /workspace/repo: codex JSONL, a session
 * file in the home the snapshot keeps, a tracked and a new file. A later turn first checks what
 * restore brought back. A gated agent then waits until the harness opens its gate: core or the
 * runner may be killed meanwhile.
 */
const AGENT = `set -eu
turn=$1 thread=$2 message=$3 gated=$4
sessions=/agent-home/codex/sessions/verify
if [ "$turn" -gt 1 ]; then
  test -f "$sessions/turn-$((turn - 1)).jsonl"
  grep -qx "turn $((turn - 1))" index.php
fi
printf '{"type":"thread.started","thread_id":"%s"}\\n' "$thread"
mkdir -p "$sessions"
printf '{"turn":%s}\\n' "$turn" > "$sessions/turn-$turn.jsonl"
printf 'turn %s\\n' "$turn" >> index.php
printf 'turn %s\\n' "$turn" > "turn-$turn.txt"
printf '%s\\n' "$message"
if [ "$gated" = 1 ]; then
  while [ ! -e /tmp/raditi-verify-go ]; do sleep 0.2; done
fi
printf '{"type":"turn.completed"}\\n'
`

const result = (turn) => ({
  summary: `Синтетический ход ${turn}`,
  change_type: 'code',
  client_message: 'Изменение готово к проверке.',
  files_changed: ['index.php', `turn-${turn}.txt`],
  questions: [],
  needs_approval: false,
  risk: 'low',
})

/** codex's parser, session state and result; prepare and command are synthetic (no model). */
const codex = createCodexDriver({ imagePrefix: 'raditi/agent' })
const driver = {
  ...codex,
  async prepare(context) {
    return {
      context: { ...context },
      files: [{ path: '/agent-home/codex/config.toml', content: 'synthetic = true\n' }],
      env: {},
      secrets: [
        { path: `${SANDBOX_SECRETS_DIR}/llm`, content: context.llm.apiKey },
        { path: `${SANDBOX_SECRETS_DIR}/mcp`, content: context.mcp.token },
      ],
    }
  },
  command(prepared, input) {
    const { turn, nativeSessionId } = prepared.context
    const message = JSON.stringify({
      type: 'item.completed',
      item: { id: 'verify', type: 'agent_message', text: JSON.stringify(result(turn)) },
    })
    const gated = JSON.parse(input.prompt).gated === true
    return [
      'sh',
      '-c',
      AGENT,
      'synthetic-agent',
      String(turn),
      nativeSessionId ?? randomUUID(),
      message,
      gated ? '1' : '0',
    ]
  },
}

const env = process.env
const db = createPrismaClient({ databaseUrl: env.DATABASE_URL, log: [] })
const leases = new PostgresSiteLeaseStore(db)
const assignments = new PostgresTurnAssignmentStore(db)
const journal = new TaskEventTurnJournal(db)
// Presigned URLs are signed for S3 as the VM sees it (S3_RUNNER_ENDPOINT).
const snapshots = new SnapshotService(
  createS3ObjectStorage(storageConfigFromEnv(env)),
  createVaultSecretStore(vaultConfigFromEnv(env)),
)
const workspace = new GitWorkspaceService(
  {
    kind: 'gitea',
    getRepository: async (ref) => ({
      ref,
      cloneUrl: config.remote,
      defaultBranch: 'main',
      private: true,
    }),
    issueCredentials: async () => {
      throw new Error('The local remote needs no credentials')
    },
  },
  { transport: { kind: 'local-test', root: config.root }, gitleaksBinary: config.gitleaks },
)
const hub = new RunnerHub({ assignments, leases })
const server = new RunnerApiServer(
  hub,
  new RunnerAuthenticator(parseRunnerTokens(config.runnerTokens).hashes),
)
const executor = new RemoteTurnExecutor(hub, leases, assignments)
const live = new LiveTurns()
const supervisor = new TurnSupervisor({
  leases,
  assignments,
  workspace,
  snapshots,
  journal,
  executor,
  driver,
  live,
})

// A stand-in for P3's store: the values each turn started with, kept by the harness.
const credentialKey = (ref) => `${ref.taskId}:${ref.sessionId}:${ref.turn}`
const kept = new Map(config.credentials)
const credentials = {
  async issue() {
    throw new Error('Turn credentials are issued in P3')
  },
  async recover(ref) {
    process.send({ type: 'recovered' })
    return kept.get(credentialKey(ref)) ?? null
  },
  async revoke(ref) {
    kept.delete(credentialKey(ref))
  },
}
// Only the turns of this verification's site: never other unfinished rows of the dev database.
const unfinished = async (filter) =>
  (await assignments.unfinished(filter)).filter((row) => row.fence.siteId === config.siteId)
const recovery = new TurnExecRecovery({
  leases,
  assignments: Object.create(assignments, { unfinished: { value: unfinished } }),
  executor,
  journal,
  driver: (id) => {
    if (id !== driver.id) throw new Error('Unknown driver')
    return driver
  },
  workspace,
  snapshots,
  credentials,
  live,
})

// The client's «Отменить» of a running turn, by task.
const cancels = new Map()
const failure = (error) => ({
  code: typeof error?.code === 'string' ? error.code : (error?.name ?? 'Error'),
  message: error instanceof Error ? error.message : String(error),
})
const handlers = {
  async run({ request }) {
    kept.set(credentialKey(request.context), {
      llmApiKey: request.context.llm.apiKey,
      mcpToken: request.context.mcp.token,
    })
    const cancel = new AbortController()
    cancels.set(request.context.taskId, cancel)
    try {
      return await supervisor.run(request, cancel.signal)
    } finally {
      cancels.delete(request.context.taskId)
    }
  },
  async cancel({ taskId }) {
    cancels.get(taskId)?.abort()
    return null
  },
  async session() {
    return hub.session(config.runnerId) ?? null
  },
  async close() {
    await recovery.stop()
    await server.close()
    await db.$disconnect()
    setImmediate(() => process.exit(0))
    return null
  },
}
process.on('message', (message) => {
  handlers[message.type](message).then(
    (value) => process.send({ type: 'reply', id: message.id, ok: true, value }),
    (error) => process.send({ type: 'reply', id: message.id, ok: false, error: failure(error) }),
  )
})

// Loopback only: the VM reaches this host's loopback through its own gateway address.
await server.listen(config.port, '127.0.0.1')
recovery.start(config.recoverEveryMs)
process.send({ type: 'ready' })
