/* global console, process */
import assert from 'node:assert/strict'
import { verifyAgentSupervisor } from './verify-agent-supervisor.mjs'

export * from './verify-agent-supervisor.mjs'
export const verifyKimiSupervisor = (options = {}) =>
  verifyAgentSupervisor({ ...options, driverId: 'kimi' })

if (import.meta.main) {
  try {
    assert.equal(
      process.argv.slice(2).filter((value) => value !== '--').length,
      0,
      'This launcher accepts no arguments',
    )
    await verifyKimiSupervisor()
  } catch (error) {
    console.error(
      error.message?.startsWith('P5 ')
        ? error.message
        : 'P5 supervisor verification failed during local preflight',
    )
    process.exitCode = 1
  }
}
