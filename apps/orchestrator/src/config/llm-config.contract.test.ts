import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { PRODUCTION_VAULT_CA_FILE } from './llm-config.ts'

// In production the role llm refuses every extra CA but one: the CA of Vault, at the path the
// profile of the app VM gives it. That profile is a Compose file of another directory, read by
// no code of the role; this is the one place that holds the two sides to each other.
const composeFile = fileURLToPath(
  new URL('../../../../infra/app/docker-compose.yml', import.meta.url),
)

describe('the extra CA of the production role llm and the profile of the app VM', () => {
  const compose = readFileSync(composeFile, 'utf8')

  it('is the file the llm service of the profile is given', () => {
    // The block of the service: from its key to the next key of the same depth.
    const service = /^ {2}llm:\n(?:(?: {4}.*)?\n)+/m.exec(compose)?.[0] ?? ''
    expect(service).toContain('ORCHESTRATOR_ROLES: llm')
    expect(service).toContain(`      NODE_EXTRA_CA_CERTS: ${PRODUCTION_VAULT_CA_FILE}\n`)
  })

  it('is the only value the profile gives the variable anywhere', () => {
    const values = [...compose.matchAll(/^\s*NODE_EXTRA_CA_CERTS:\s*(.*)$/gm)].map(
      (match) => match[1],
    )
    expect(values.length).toBeGreaterThanOrEqual(2)
    expect([...new Set(values)]).toEqual([PRODUCTION_VAULT_CA_FILE])
  })
})
