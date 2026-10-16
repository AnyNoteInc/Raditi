import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/verify-opencode.mjs', import.meta.url))
const marker = 'synthetic-docker-credential-must-not-leak'

async function verify(env: Record<string, string | undefined>) {
  const directory = await mkdtemp(join(tmpdir(), 'raditi-opencode-docker-guard-'))
  try {
    const log = join(directory, 'calls')
    await writeFile(
      join(directory, 'docker'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$VERIFY_DOCKER_LOG"\nif [ "$1" = context ]; then\n  printf "%s\\n" "$VERIFY_DOCKER_ENDPOINT"\n  exit "${VERIFY_DOCKER_CONTEXT_EXIT:-0}"\nfi\nprintf "%s\\n" "transport:${DOCKER_HOST-unset}:${DOCKER_CONTEXT-unset}:${DOCKER_TLS_VERIFY-unset}" >> "$VERIFY_DOCKER_LOG"\nexit 99\n',
      { mode: 0o700 },
    )
    const output = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        DOCKER_HOST: undefined,
        DOCKER_CONTEXT: undefined,
        DOCKER_TLS: undefined,
        DOCKER_TLS_VERIFY: undefined,
        DOCKER_CERT_PATH: undefined,
        PATH: directory,
        VERIFY_DOCKER_LOG: log,
        ...env,
      },
    })
    return {
      status: output.status,
      text: `${output.stdout}${output.stderr}`,
      calls: await readFile(log, 'utf8').catch(() => ''),
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('the opt-in OpenCode proof stays on a local Docker socket', () => {
  it.each([`ssh://user:${marker}@remote.example`, `tcp://user:${marker}@remote.example:2376`])(
    'rejects a remote DOCKER_HOST before invoking Docker and never prints credentials',
    async (endpoint) => {
      const result = await verify({ DOCKER_HOST: endpoint })
      expect(result.status).not.toBe(0)
      expect(result.text).toContain('A local Docker Unix socket is required')
      expect(result.text).not.toContain(marker)
      expect(result.calls).toBe('')
    },
  )

  it.each([undefined, 'explicit-context'])(
    'checks the selected context before mutations',
    async (context) => {
      const result = await verify({
        DOCKER_CONTEXT: context,
        ...(context ? { DOCKER_HOST: 'unix:///unused.sock' } : {}),
        VERIFY_DOCKER_ENDPOINT: `ssh://user:${marker}@remote.example`,
      })
      expect(result.status).not.toBe(0)
      expect(result.text).toContain('A local Docker Unix socket is required')
      expect(result.text).not.toContain(marker)
      expect(result.calls.trim().split('\n')).toEqual([
        `context inspect ${context ? `${context} ` : ''}--format {{.Endpoints.docker.Host}}`,
      ])
    },
  )

  it('fails closed when context inspection fails without printing its output', async () => {
    const result = await verify({ VERIFY_DOCKER_CONTEXT_EXIT: '1', VERIFY_DOCKER_ENDPOINT: marker })
    expect(result.status).not.toBe(0)
    expect(result.text).toContain('Cannot resolve the local Docker endpoint')
    expect(result.text).not.toContain(marker)
    expect(result.calls).not.toContain('image inspect')
  })

  it('pins a resolved socket and clears environment transport overrides before image inspection', async () => {
    const result = await verify({
      DOCKER_CONTEXT: 'local-proof',
      DOCKER_HOST: `ssh://user:${marker}@ignored.example`,
      DOCKER_TLS_VERIFY: '1',
      VERIFY_DOCKER_ENDPOINT: 'unix:///synthetic.sock',
    })
    expect(result.status).not.toBe(0)
    expect(result.text).not.toContain(marker)
    expect(result.calls).toContain(
      '--host unix:///synthetic.sock image inspect raditi-g3verify-sandbox:local',
    )
    expect(result.calls).toContain('transport:unset:unset:unset')
    expect(result.calls).not.toContain('run ')
  })
})
