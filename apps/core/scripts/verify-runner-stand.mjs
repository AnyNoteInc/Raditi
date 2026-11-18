/* global console, process */
// verify:runner (P2 gates 2 and 3, spec §8): the seven scenarios of verify-runner.mjs with the
// synthetic agent and the real runner under gVisor, over disposable PostgreSQL, SeaweedFS and
// OpenBao of the supervisor stand — never the services of .env (П47, docs/plan/84-projects.md,
// §10, «Раннер песочной ВМ и CI»). The real CLI and the chats of projects with a repository are
// verify:opencode-supervisor.
import assert from 'node:assert/strict'

import { verifyAgentSupervisor } from './verify-agent-supervisor.mjs'

if (import.meta.main) {
  try {
    assert.equal(
      process.argv.slice(2).filter((value) => value !== '--').length,
      0,
      'This launcher accepts no arguments',
    )
    await verifyAgentSupervisor({ agent: 'synthetic' })
  } catch (error) {
    console.error(
      error.message?.startsWith('P2 ')
        ? error.message
        : 'P2 runner verification failed during local preflight',
    )
    process.exitCode = 1
  }
}
