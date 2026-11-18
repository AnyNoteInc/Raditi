/* global console, process */
// verify:snapshots (P1): verify-snapshots.mjs over disposable SeaweedFS and OpenBao of its own —
// no database, no runner and never the services of .env (П47, docs/plan/84-projects.md, §10,
// «Раннер песочной ВМ и CI»).
import assert from 'node:assert/strict'

import { verifyDisposableSnapshots } from './verify-agent-supervisor.mjs'

if (import.meta.main) {
  try {
    assert.equal(
      process.argv.slice(2).filter((value) => value !== '--').length,
      0,
      'This launcher accepts no arguments',
    )
    await verifyDisposableSnapshots()
  } catch (error) {
    console.error(
      error.message?.startsWith('P1 ')
        ? error.message
        : 'P1 snapshot verification failed during local preflight',
    )
    process.exitCode = 1
  }
}
