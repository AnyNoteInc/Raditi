/* global AbortController, Buffer, process, setImmediate */
// The core process of verify-runner.mjs: the turn supervisor, the runner API and exec recovery
// over the local PostgreSQL, S3 and Vault, as TurnsModule wires them (turns.providers.ts). The
// harness sends it turns over IPC and kills it with SIGKILL: only the database, S3, the runner VM
// and the git worker outlive it. With `config.git` it has the trusted git of the repositories of
// projects (docs/plan/84-projects.md, ПР12, ПР33): GitWorkspaceService over the socket of the git
// worker the harness started, the mirrors on its volume, and the files of projects from
// raditi-inbox. Started by verify-runner.mjs only, which sends its configuration as the first
// message.
import { randomBytes } from 'node:crypto'

import { createOpencodeDriver } from '@repo/agent-drivers'
import {
  createPrismaClient,
  PostgresSiteLeaseStore,
  PostgresTaskTurnAssignmentStore,
} from '@repo/db'
import { SANDBOX_SECRETS_DIR, withoutTurnCredentials } from '@repo/domain'
import { createS3ObjectStorage, storageConfigFromEnv } from '@repo/storage'
import { createVaultSecretStore, vaultConfigFromEnv } from '@repo/vault'

import { parseRunnerTokens, runnerCredentialAddress } from '../dist/config/runner-tokens.js'
import { gitWorkerSocketPath } from '../dist/git-worker/protocol.js'
import { GitWorkspaceService } from '../dist/git-workspace/git-workspace.service.js'
import { GitWorkerClient } from '../dist/git-workspace/worker-client.js'
import { RemoteTurnExecutor } from '../dist/runner-api/remote-turn-executor.js'
import { RunnerApiServer } from '../dist/runner-api/runner-api.server.js'
import { RunnerAuthenticator } from '../dist/runner-api/runner-auth.js'
import { RunnerHub } from '../dist/runner-api/runner-hub.js'
import { SnapshotService } from '../dist/sessions/snapshot.service.js'
import { RepoTurnPreparer } from '../dist/tasks/repo-turns.js'
import { LiveTurns } from '../dist/turns/live-turns.js'
import { TurnExecRecovery } from '../dist/turns/turn-exec-recovery.js'
import { TaskInboxFiles } from '../dist/turns/turn-inbox.js'
import { TaskEventTurnJournal } from '../dist/turns/turn-journal.js'
import { TaskProjectFiles } from '../dist/turns/turn-project-files.js'
import { TurnSupervisor } from '../dist/turns/turn-supervisor.js'

if (!process.send) throw new Error('Started by verify-runner.mjs only')
const { config } = await new Promise((resolve) => process.once('message', resolve))

/**
 * The synthetic agent, run by the runner as uid 10001 in /workspace/repo: the rows of
 * `opencode run --format json`, the session database and its journal in the home the snapshot
 * keeps, a log next to them that the snapshot must leave behind, and a file in the working
 * directory, which no snapshot keeps. A later turn first checks what restore brought back: both
 * session files. A gated agent then waits until the harness opens its gate: core or the runner may be killed
 * meanwhile.
 */
const AGENT = `set -eu
turn=$1 started=$2 message=$3 finished=$4 gated=$5
data=/agent-home/opencode/.local/share/opencode
if [ "$turn" -gt 1 ]; then
  grep -qx "turn $((turn - 1))" "$data/opencode.db"
  grep -qx "turn $((turn - 1))" "$data/opencode.db-wal"
fi
printf '%s\\n' "$started"
mkdir -p "$data/log"
printf 'turn %s\\n' "$turn" >> "$data/opencode.db"
printf 'turn %s\\n' "$turn" >> "$data/opencode.db-wal"
printf 'turn %s\\n' "$turn" > "$data/log/synthetic.log"
printf 'turn %s\\n' "$turn" > "turn-$turn.txt"
printf '%s\\n' "$message"
if [ "$gated" = 1 ]; then
  while [ ! -e /tmp/raditi-verify-go ]; do sleep 0.2; done
fi
printf '%s\\n' "$finished"
`

const result = (turn) => ({
  summary: `Синтетический ход ${turn}`,
  change_type: 'code',
  client_message: 'Изменение готово к проверке.',
  files_changed: [`turn-${turn}.txt`],
  questions: [],
  needs_approval: false,
  risk: 'low',
})

/** One row of the CLI's output: a part of the answer of the session. */
const row = (type, sessionID, part) =>
  JSON.stringify({
    type,
    timestamp: Date.now(),
    sessionID,
    part: { messageID: 'msg_verify', sessionID, ...part },
  })

/** The parser, session state and result of the sample driver; prepare and command are synthetic (no model). */
const sample = createOpencodeDriver({ image: `raditi/sbx-wordpress@sha256:${'a'.repeat(64)}` })
const driver = config.driverId
  ? { opencode: createOpencodeDriver }[config.driverId]({ image: config.sandboxImage })
  : {
      ...sample,
      async prepare(context) {
        return {
          context: { ...context },
          files: [
            {
              path: '/agent-home/opencode/.config/opencode/opencode.json',
              content: '{"synthetic":true}\n',
            },
          ],
          env: {},
          secrets: [
            { path: `${SANDBOX_SECRETS_DIR}/llm`, content: context.llm.apiKey },
            { path: `${SANDBOX_SECRETS_DIR}/mcp`, content: context.mcp.token },
          ],
        }
      },
      command(prepared, input) {
        const { turn, nativeSessionId } = prepared.context
        const session = nativeSessionId ?? `ses_${randomBytes(12).toString('hex')}`
        const gated = JSON.parse(input.prompt).gated === true
        return [
          'sh',
          '-c',
          AGENT,
          'synthetic-agent',
          String(turn),
          row('step_start', session, { type: 'step-start' }),
          row('text', session, { type: 'text', text: JSON.stringify(result(turn)) }),
          row('step_finish', session, {
            type: 'step-finish',
            reason: 'stop',
            tokens: {
              total: 40,
              input: 20,
              output: 8,
              reasoning: 2,
              cache: { write: 0, read: 10 },
            },
            cost: 0,
          }),
          gated ? '1' : '0',
        ]
      },
    }

const env = process.env
const db = createPrismaClient({ databaseUrl: env.DATABASE_URL, log: [] })
const leases = new PostgresSiteLeaseStore(db)
// The store the core role wires (LeasesModule): each turn is a TaskTurn of its task as well.
const assignments = new PostgresTaskTurnAssignmentStore(db)
const journal = new TaskEventTurnJournal(db)
// kill -9 of this core right after a phase of one task is journaled, before anything follows it;
// the point `issue` is the moment the turn's key is issued: a runner slot is reserved by then,
// and the prepare has not gone out.
const crashAfter = new Map()
const record = journal.record.bind(journal)
journal.record = async (input) => {
  await record(input)
  if (crashAfter.get(input.fence.taskId) === input.phase) process.kill(process.pid, 'SIGKILL')
}
// The client's «Отменить» at an exact moment of a task's turn: `issue` as above, `dispatch`
// when a poll of the runner takes the prepare.
const cancelAt = new Map()
// Presigned URLs are signed for S3 as the VM sees it (S3_RUNNER_ENDPOINT).
const storage = createS3ObjectStorage(storageConfigFromEnv(env))
const snapshots = new SnapshotService(storage, createVaultSecretStore(vaultConfigFromEnv(env)))
const hub = new RunnerHub({ assignments, leases })
const runnerTokens = parseRunnerTokens(config.runnerTokens).hashes
const server = new RunnerApiServer(hub, new RunnerAuthenticator(runnerTokens))
// As RunnerApiModule: a turn's key is bound to the address RUNNER_TOKENS names for its runner.
// The credentials themselves are synthetic, and nothing calls a model.
const executor = new RemoteTurnExecutor(hub, leases, assignments, (id) =>
  runnerCredentialAddress(runnerTokens, id),
)
const prepare = executor.prepare.bind(executor)
executor.prepare = (input, signal) =>
  prepare(
    {
      ...input,
      dispatched: () => {
        input.dispatched()
        if (cancelAt.get(input.fence.taskId) === 'dispatch')
          cancels.get(input.fence.taskId)?.abort()
      },
    },
    signal,
  )
const live = new LiveTurns()
// The trusted git of core (GitWorkspaceModule): every command goes to the git worker over its
// socket. The repositories of the projects are bare repositories of the stand below `root`,
// reached by the transport GitWorkspaceService keeps for tests (`local-test`, NODE_ENV=test only):
// the provider's side of a fetch — its API, OAuth, the pinned address and the token of git — is
// verify:projects', and none of it is in the way of a turn.
const git = config.git
  ? new GitWorkspaceService({
      runner: new GitWorkerClient(gitWorkerSocketPath(config.git.mirrorDir)),
      mirrorDir: config.git.mirrorDir,
      transport: { kind: 'local-test', root: config.git.root },
    })
  : null
/** A fetch of a public repository: no grant, as `git.repo.attach` of an open link takes it. */
const anonymous = () => ({
  auth: { kind: 'anonymous' },
  basic: null,
  expiresAt: new Date(Date.now() + 60_000),
})

// A stand-in for P3's store: the values each turn started with, kept by the harness.
const credentialKey = (ref) => `${ref.taskId}:${ref.sessionId}:${ref.turn}`
const kept = new Map(config.credentials)
const credentials = {
  async issue(ref, grant) {
    if (grant.boundSource !== config.runnerAddress)
      throw new Error('The turn key is not bound to the address of its runner')
    if (crashAfter.get(ref.taskId) === 'issue') process.kill(process.pid, 'SIGKILL')
    if (cancelAt.get(ref.taskId) === 'issue') cancels.get(ref.taskId)?.abort()
    const values = kept.get(credentialKey(ref))
    if (!values) throw new Error('Synthetic turn credentials unavailable')
    return values
  },
  async recover(ref) {
    process.send({ type: 'recovered' })
    return kept.get(credentialKey(ref)) ?? null
  },
  async revoke(ref) {
    kept.delete(credentialKey(ref))
  },
}
const supervisor = new TurnSupervisor({
  leases,
  assignments,
  snapshots,
  journal,
  executor,
  driver,
  live,
  credentials,
  // As TurnsModule: the files of a chat, read from raditi-inbox when the runner asks for them.
  inbox: new TaskInboxFiles(db, storage),
  // The files of the chat's project, the same way (docs/plan/84-projects.md, ПР8).
  projectFiles: new TaskProjectFiles(db, storage),
  // The trusted git of the repositories of projects (ПР12); null — a turn with one is refused.
  repository: git,
})
const credentialPolicy = {
  driverId: driver.id,
  // The provider the CLI of the stand belongs to; nothing here calls one.
  backend: 'zai-coding',
  modelSlug: 'synthetic',
  modelClass: 'standard',
  reasoningEffort: 'medium',
  ttlMs: 20 * 60_000,
  budgetRub: '100.00',
}
// Only the turns of this verification's workspace: never other unfinished rows of the dev database.
// Not by the fence: a chat without a project is fenced by its own id, which no site row names.
const unfinished = async (filter) =>
  (await assignments.unfinished(filter)).filter(
    (row) => row.plan.sandbox.labels.workspaceId === config.workspaceId,
  )
const recovery = new TurnExecRecovery({
  leases,
  // Every other method runs on the store itself: it keeps private state.
  assignments: new Proxy(assignments, {
    get(target, key) {
      if (key === 'unfinished') return unfinished
      const member = Reflect.get(target, key)
      return typeof member === 'function' ? member.bind(target) : member
    },
  }),
  executor,
  // A checkpointed turn with a repository has its publication finished here (ПР12, §4.3, step 7).
  repository: git,
  journal,
  driver: (id) => {
    if (id !== driver.id) throw new Error('Unknown driver')
    return driver
  },
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
      const done = await supervisor.run(
        withoutTurnCredentials(request),
        config.driverId
          ? {
              ...credentialPolicy,
              modelSlug: request.context.llm.model,
              reasoningEffort: request.context.llm.reasoningEffort,
            }
          : credentialPolicy,
        cancel.signal,
      )
      // What IPC carries: no closure (`refusesText`), the patch as base64.
      return {
        result: done.result,
        manifest: done.manifest,
        ...(done.repository
          ? {
              repository: {
                ...done.repository,
                patch: Buffer.from(done.repository.patch).toString('base64'),
              },
            }
          : {}),
      }
    } finally {
      cancels.delete(request.context.taskId)
    }
  },
  /**
   * The repository of a pass of a chat of a project (§4.3, step 3) as the product prepares it
   * (RepoTurnPreparer): the main branch fetched into the mirror, the base — the chat's own ref
   * once it published, else the head of the main branch —, the files that look like secrets
   * named and the bundle built. Only the fetch is the stand's: from `cloneUrl`, without a grant.
   */
  async repoPrepare({ chatId, row, cloneUrl }) {
    if (!git) throw new Error('This core has no trusted git')
    const preparer = new RepoTurnPreparer({
      db,
      git: {
        async fetchForTurn(projectRepositoryId) {
          const heads = await git.fetch({
            projectRepositoryId,
            remote: { cloneUrl, access: anonymous() },
            branches: [row.defaultBranch],
            sizeBytes: null,
          })
          return { sha: heads.get(row.defaultBranch), label: 'GitLab', chatHead: null }
        },
      },
      workspace: git,
    })
    return preparer.prepare(chatId, row)
  },
  /** The chat's ref of the mirror (`refs/raditi/<chatId>`): what core published, or null. */
  async repoRef({ projectRepositoryId, chatId }) {
    if (!git) throw new Error('This core has no trusted git')
    return git.readChatRef(projectRepositoryId, chatId)
  },
  async cancel({ taskId }) {
    cancels.get(taskId)?.abort()
    return null
  },
  async cancelAt({ taskId, point }) {
    cancelAt.set(taskId, point)
    return null
  },
  async crashAfter({ taskId, phase }) {
    crashAfter.set(taskId, phase)
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
