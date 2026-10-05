import {
  preparedRunExposesSecret,
  preparedRunSchema,
  SANDBOX_AGENT_HOME,
  SANDBOX_SECRETS_DIR,
  SANDBOX_WORKDIR,
  turnCredentials,
  type PreparedRun,
  type RunContext,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { createAgentDrivers } from './registry.ts'

const context: RunContext = {
  taskId: 't',
  sessionId: 's',
  turn: 1,
  llm: {
    baseUrl: 'http://sandbox-gw:8080/codex',
    apiKey: 'test-llm-key',
    model: 'm',
    reasoningEffort: 'medium' as const,
  },
  mcp: { url: 'http://sandbox-gw:8080/mcp', token: 'test-mcp-token' },
  instructions: '',
}
const run = (overrides: Partial<PreparedRun> = {}): PreparedRun => ({
  context,
  files: [{ path: `${SANDBOX_AGENT_HOME}/codex/config.toml`, content: 'x' }],
  env: {},
  secrets: [{ path: `${SANDBOX_SECRETS_DIR}/llm`, content: 'test-llm-key' }],
  ...overrides,
})

describe('prepared run paths', () => {
  it('accepts driver files under /agent-home and secrets in their tmpfs', () =>
    expect(preparedRunSchema.safeParse(run()).success).toBe(true))

  it.each([
    `${SANDBOX_WORKDIR}/AGENTS.md`,
    SANDBOX_WORKDIR,
    '/workspace/out/schema.json',
    '/workspace/inbox/file.txt',
    `${SANDBOX_AGENT_HOME}/../workspace/repo/AGENTS.md`,
    `${SANDBOX_AGENT_HOME}/./codex/config.toml`,
    `${SANDBOX_AGENT_HOME}//codex/config.toml`,
    `${SANDBOX_AGENT_HOME}/codex/`,
    `${SANDBOX_AGENT_HOME}/.git/config`,
    SANDBOX_AGENT_HOME,
    'agent-home/codex/config.toml',
    `${SANDBOX_SECRETS_DIR}/config.toml`,
  ])('refuses a driver file at %j', (path) => {
    expect(preparedRunSchema.safeParse(run({ files: [{ path, content: 'x' }] })).success).toBe(
      false,
    )
  })

  it.each([`${SANDBOX_WORKDIR}/.env`, `${SANDBOX_AGENT_HOME}/codex/auth.json`, '/tmp/key'])(
    'refuses a secret outside the secrets tmpfs: %j',
    (path) => {
      expect(preparedRunSchema.safeParse(run({ secrets: [{ path, content: 'k' }] })).success).toBe(
        false,
      )
    },
  )

  it('refuses duplicates, bad modes and oversized content', () => {
    const file = { path: `${SANDBOX_AGENT_HOME}/codex/a`, content: 'x' }
    expect(preparedRunSchema.safeParse(run({ files: [file, file] })).success).toBe(false)
    expect(preparedRunSchema.safeParse(run({ files: [{ ...file, mode: 0o4755 }] })).success).toBe(
      false,
    )
    expect(
      preparedRunSchema.safeParse(
        run({ files: [{ ...file, content: 'x'.repeat(4 * 1024 * 1024 + 1) }] }),
      ).success,
    ).toBe(false)
  })

  it.each(
    createAgentDrivers({
      image: `registry.local:3300/raditi/sbx-wordpress@sha256:${'a'.repeat(64)}`,
    }),
  )(
    '$id.prepare output, once implemented, never writes into /workspace or exposes credentials',
    async (driver) => {
      let prepared: PreparedRun
      try {
        prepared = await driver.prepare(
          driver.id === 'kimi'
            ? {
                ...context,
                llm: {
                  ...context.llm,
                  baseUrl: 'http://sandbox-gw:8080/kimi/v1',
                  reasoningEffort: 'low',
                },
              }
            : context,
        )
      } catch (error) {
        // P4/P5 implement prepare; until then the schema tests above carry the guarantee.
        expect(error).toMatchObject({ code: 'NOT_IMPLEMENTED' })
        return
      }
      expect(preparedRunSchema.parse(prepared)).toBeTruthy()
      for (const file of [...prepared.files, ...prepared.secrets])
        expect(file.path.startsWith('/workspace')).toBe(false)
      // /agent-home is packed into the S3 snapshot: credentials only as secret files.
      expect(preparedRunExposesSecret(prepared, turnCredentials(context, prepared.secrets))).toBe(
        false,
      )
    },
  )
})
