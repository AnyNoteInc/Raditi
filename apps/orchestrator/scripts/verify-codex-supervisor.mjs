/* global console, process */
import assert from 'node:assert/strict'
import { verifyAgentSupervisor } from './verify-agent-supervisor.mjs'

export * from './verify-agent-supervisor.mjs'
export const verifyCodexSupervisor = (options = {}) =>
  verifyAgentSupervisor({ ...options, driverId: 'codex' })

if (import.meta.main) {
  try {
    assert.equal(
      process.argv.slice(2).filter((value) => value !== '--').length,
      0,
      'This launcher accepts no arguments',
    )
    await verifyCodexSupervisor()
  } catch (error) {
    console.error(
      error.message?.startsWith('P4 ')
        ? error.message
        : 'P4 supervisor verification failed during local preflight',
    )
    process.exitCode = 1
  }
}
