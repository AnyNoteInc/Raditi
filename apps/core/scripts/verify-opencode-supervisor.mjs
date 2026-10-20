/* global console, process */
import assert from 'node:assert/strict'
import { verifyAgentSupervisor } from './verify-agent-supervisor.mjs'

export * from './verify-agent-supervisor.mjs'
export const verifyOpencodeSupervisor = (options = {}) =>
  verifyAgentSupervisor({ ...options, driverId: 'opencode' })

if (import.meta.main) {
  try {
    assert.equal(
      process.argv.slice(2).filter((value) => value !== '--').length,
      0,
      'This launcher accepts no arguments',
    )
    await verifyOpencodeSupervisor()
  } catch (error) {
    console.error(
      error.message?.startsWith('G3 ')
        ? error.message
        : 'G3 supervisor verification failed during local preflight',
    )
    process.exitCode = 1
  }
}
