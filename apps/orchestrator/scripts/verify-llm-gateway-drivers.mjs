// B13 with what production runs: each CLI starts from its driver's prepare + command (config,
// AGENTS.md, output schema, MCP server, image argument, resume), through sandbox-gw to the role
// llm and its body policy. The MCP server is synthetic but lists the production profile's tools.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'

import { createCodexDriver, createKimiDriver } from '@repo/agent-drivers'
import {
  preparedFilesSchema,
  preparedRunExposesSecret,
  turnCredentials,
  turnResultSchema,
} from '@repo/domain'
import { z } from 'zod'

import { CLI_IMAGE, dockerCommand } from '../../../infra/dev/llm-verify/cli.mjs'
import { SYNTHETIC_MCP_MARKER } from '../../../infra/dev/llm-verify/fake-subscriptions.mjs'
import { run } from '../../../infra/dev/llm-verify/stack.mjs'

const GATEWAY = 'http://sandbox-gw:8080'
const IMAGE_NAME = 'b13-pixel.png'
const PROVIDER_PATHS = {
  codex: '/backend-api/codex/responses',
  kimi: '/coding/v1/chat/completions',
}
const ENDPOINTS = {
  codex: { baseUrl: `${GATEWAY}/codex`, model: 'gpt-6-sol' },
  kimi: { baseUrl: `${GATEWAY}/kimi/v1`, model: 'k3-256k' },
}

/**
 * A file the CLI wrote into its workspace. The container's uid 10001 owns it: on native Linux
 * the host user reads it only if the CLI left it readable by others, so a refused read goes
 * through the container that wrote it.
 */
async function workspaceFile(cli, name) {
  try {
    return await readFile(join(cli.workspace, name), 'utf8')
  } catch (error) {
    if (error?.code !== 'EACCES') throw error
    const read = await dockerCommand(['exec', cli.containerName, 'cat', `/workspace/repo/${name}`])
    assert.equal(read.code, 0, `The CLI container cannot read ${name}`)
    return read.stdout
  }
}

/** The tools the role mcp's production profile lists, in mcp-nest's tools/list shape. */
export async function productionMcpTools() {
  await import('reflect-metadata')
  const { default: mcpNest } = await import('@rekog/mcp-nest')
  const { McpToolsController } = await import('../dist/mcp/mcp-tools.controller.js')
  const tools = Object.getOwnPropertyNames(McpToolsController.prototype).flatMap((name) => {
    const meta = Reflect.getMetadata(
      mcpNest.MCP_TOOL_METADATA_KEY,
      McpToolsController.prototype[name],
    )
    return meta
      ? [
          {
            name: meta.name,
            description: meta.description,
            annotations: meta.annotations,
            inputSchema: z.toJSONSchema(meta.parameters, { target: 'draft-2020-12', io: 'input' }),
          },
        ]
      : []
  })
  assert.ok(
    tools.some((tool) => tool.name === 'site_info'),
    'The production MCP profile lost site_info',
  )
  return tools
}

/** A valid 8×8 PNG: a real image attachment for the CLI to encode. */
export function syntheticPng() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(8, 0)
  header.writeUInt32BE(8, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.concat(
    Array.from({ length: 8 }, () => Buffer.from([0, ...Array(8).fill([40, 120, 200]).flat()])),
  )
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const resultFor = (summary, files) => ({
  summary,
  change_type: files.length ? 'code' : 'none',
  client_message: 'Синтетическая проверка завершена, изменения готовы.',
  files_changed: files,
  questions: [],
  needs_approval: false,
  risk: 'low',
})

/** Flattened tool declarations of one provider request body. */
function declaredTools(body, backend) {
  if (backend === 'kimi') return (body.tools ?? []).map((tool) => tool.function ?? tool)
  return [
    ...(body.tools ?? []),
    ...(body.input ?? [])
      .filter((item) => item.type === 'additional_tools')
      .flatMap((item) => item.tools ?? []),
  ].flatMap((tool) =>
    tool.type === 'namespace'
      ? (tool.tools ?? []).map((nested) => ({ ...nested, namespace: tool.name }))
      : [tool],
  )
}

/**
 * Runs one turn the way production does: the driver's prepare and command, the executor's checks,
 * then exactly that in the CLI container, through sandbox-gw to the role llm and the MCP route.
 */
export async function createDriverRunner({ cli, control, secretMarkers, instructions }) {
  const imageId = (
    await run('docker', ['image', 'inspect', '--format', '{{.Id}}', CLI_IMAGE])
  ).stdout.trim()
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/)
  const image = `raditi-p3verify-cli@${imageId}`
  const drivers = { codex: createCodexDriver({ image }), kimi: createKimiDriver({ image }) }
  const tools = await productionMcpTools()
  const providerRequests = async (backend) =>
    (await control('state')).requests.filter((entry) => entry.path === PROVIDER_PATHS[backend])
  const mcpRequests = async () => (await control('state')).mcp.requests

  return async function runDriver({
    driver: id,
    turn,
    prompt,
    attachments = [],
    nativeSessionId,
    timeoutMs = 180_000,
  }) {
    const driver = drivers[id]
    secretMarkers.add(turn.values.mcpToken)
    await control('mcp', { token: turn.values.mcpToken, tools })
    const context = {
      taskId: turn.ref.taskId,
      sessionId: turn.ref.sessionId,
      turn: turn.ref.turn,
      llm: {
        ...ENDPOINTS[id],
        apiKey: turn.values.llmApiKey,
        reasoningEffort: turn.grant.reasoningEffort,
      },
      mcp: { url: `${GATEWAY}/mcp`, token: turn.values.mcpToken },
      instructions,
      ...(nativeSessionId ? { nativeSessionId } : {}),
    }
    const prepared = await driver.prepare(context)
    const argv = driver.command(prepared, { prompt, attachments })
    // LocalTurnExecutor's own checks before anything is written into a sandbox.
    const files = preparedFilesSchema.parse({
      files: prepared.files,
      env: prepared.env,
      secrets: prepared.secrets,
    })
    assert.equal(
      preparedRunExposesSecret(files, turnCredentials(context, files.secrets), argv),
      false,
      'A prepared file, env value or argument carries a turn credential',
    )
    const before = {
      provider: (await providerRequests(id)).length,
      mcp: (await mcpRequests()).length,
    }
    const result = await cli.runPrepared({ ...files, argv, timeoutMs })
    const events = result.stdout.split('\n').flatMap((line) => driver.parseEvent(line))
    return {
      ...result,
      events,
      nativeSessionId: events.find((event) => event.type === 'started')?.nativeSessionId,
      result: driver.extractResult(events, null),
      provider: (await providerRequests(id)).slice(before.provider),
      mcp: (await mcpRequests()).slice(before.mcp),
    }
  }
}

export async function verifyDriverTurns(ctx) {
  const { cli, control, passed, codexTurn, kimiTurn, promptMarker, secretMarkers } = ctx
  const instructionsMarker = `B13_PLATFORM_INSTRUCTIONS_${promptMarker.slice(-12)}`
  const instructions = `# Raditi platform rules (synthetic)\n${instructionsMarker}: work only inside the repository.\n`
  await writeFile(join(cli.inbox, IMAGE_NAME), syntheticPng(), { mode: 0o644 })
  const runDriver = await createDriverRunner({ cli, control, secretMarkers, instructions })

  const assertMcpHandshake = (requests, label) => {
    assert.ok(
      requests.every((request) => request.authorized),
      `${label}: an MCP request without the turn token`,
    )
    for (const method of ['initialize', 'tools/list'])
      assert.ok(
        requests.some((request) => request.rpc === method),
        `${label}: MCP ${method} missing`,
      )
  }
  const assertMcpCalled = (requests, provider, label) => {
    assert.ok(
      requests.some((request) => request.rpc === 'tools/call' && request.tool === 'site_info'),
      `${label}: the MCP tool was not called`,
    )
    // The tool's answer went back to the model through the gateway's body policy.
    assert.ok(
      provider.some((request) => JSON.stringify(request.body).includes(SYNTHETIC_MCP_MARKER)),
      `${label}: the MCP tool output never reached the provider`,
    )
  }

  // Codex: exec with two shell rounds and an image, then resume with an MCP tool call.
  const codexFirst = resultFor('B13 Codex exec', ['b13-first.txt', 'b13-second.txt'])
  await control('scenario', { scenario: 'tools', backend: 'codex', output: codexFirst })
  const codexExec = await runDriver({
    driver: 'codex',
    turn: codexTurn,
    prompt: `${promptMarker}. Complete the synthetic task using the requested tools.`,
    attachments: [`/workspace/inbox/${IMAGE_NAME}`],
  })
  assert.equal(codexExec.code, 0, `Driver Codex exec failed with exit ${codexExec.code}`)
  assert.ok(codexExec.nativeSessionId, 'Codex session id is missing')
  assert.deepEqual(codexExec.result, codexFirst)
  assert.equal(await workspaceFile(cli, 'b13-first.txt'), 'synthetic-one\n')
  assert.equal(await workspaceFile(cli, 'b13-second.txt'), 'synthetic-two\n')
  assert.equal(codexExec.provider.length, 3)
  for (const request of codexExec.provider) {
    const { body } = request
    assert.equal(body.model, 'gpt-6-sol')
    assert.equal(body.reasoning?.effort, 'low')
    assert.equal(body.text?.format?.type, 'json_schema')
    assert.equal(body.text.format.strict, true)
    assert.ok(body.text.format.schema?.properties?.client_message, 'Turn result schema missing')
    // Codex 0.158 in code mode keeps MCP tools nested in its `exec` tool (tools.mcp__raditi__*,
    // ALL_TOOLS) instead of declaring them; the resume below calls one through an exec cell.
    assert.ok(
      declaredTools(body, 'codex').some(
        (tool) =>
          (tool.type === 'custom' && tool.name === 'exec') ||
          /(^|[_.])site_info$/.test(tool.name ?? ''),
      ),
      'Codex declared no way to reach the platform MCP tool',
    )
    assert.ok(JSON.stringify(body).includes(instructionsMarker), 'Platform instructions missing')
  }
  assert.ok(
    /data:image\/[a-z]+;base64,/.test(JSON.stringify(codexExec.provider[0].body.input)),
    'The image attachment did not reach the provider',
  )
  assertMcpHandshake(codexExec.mcp, 'Codex exec')
  passed(
    'driver-prepared Codex exec: two tool rounds, image, MCP tools and strict result schema pass the gateway policy',
  )

  const codexSecond = resultFor('B13 Codex resume', [])
  await control('scenario', { scenario: 'mcp', backend: 'codex', output: codexSecond })
  const codexResume = await runDriver({
    driver: 'codex',
    turn: codexTurn,
    prompt: 'Continue the synthetic task: read the site information.',
    nativeSessionId: codexExec.nativeSessionId,
  })
  assert.equal(codexResume.code, 0, `Driver Codex resume failed with exit ${codexResume.code}`)
  assert.equal(codexResume.nativeSessionId, codexExec.nativeSessionId)
  assert.deepEqual(codexResume.result, codexSecond)
  assert.equal(codexResume.provider.length, 2)
  assert.ok(
    JSON.stringify(codexResume.provider[0].body).includes(promptMarker),
    'The resumed Codex session lost its history',
  )
  assertMcpHandshake(codexResume.mcp, 'Codex resume')
  assertMcpCalled(codexResume.mcp, codexResume.provider, 'Codex resume')
  passed('driver-prepared Codex resume calls the platform MCP tool through sandbox-gw')

  // Kimi: exec with two shell rounds, then resume of the same session with an MCP tool call.
  const kimiFirst = resultFor('B13 Kimi exec', ['b13-first.txt', 'b13-second.txt'])
  await control('scenario', { scenario: 'tools', backend: 'kimi', text: JSON.stringify(kimiFirst) })
  const kimiExec = await runDriver({
    driver: 'kimi',
    turn: kimiTurn,
    prompt: `${promptMarker}. Complete the synthetic task using the requested tools.`,
    attachments: [`/workspace/inbox/${IMAGE_NAME}`],
  })
  assert.equal(kimiExec.code, 0, `Driver Kimi exec failed with exit ${kimiExec.code}`)
  assert.ok(kimiExec.nativeSessionId, 'Kimi session id is missing')
  assert.deepEqual(kimiExec.result, kimiFirst)
  assert.equal(await workspaceFile(cli, 'b13-first.txt'), 'synthetic-one\n')
  assert.equal(kimiExec.provider.length, 3)
  for (const request of kimiExec.provider) {
    const { body } = request
    assert.equal(body.model, 'k3-256k')
    assert.deepEqual(
      { type: body.thinking?.type, effort: body.thinking?.effort },
      { type: 'enabled', effort: 'low' },
    )
    assert.equal(body.max_completion_tokens ?? body.max_tokens, 65_536)
    assert.ok(
      declaredTools(body, 'kimi').some((tool) => /(^|[_.])site_info$/.test(tool.name ?? '')),
      'Kimi did not declare the platform MCP tool',
    )
    const serialized = JSON.stringify(body)
    assert.ok(serialized.includes(instructionsMarker), 'Platform instructions missing')
    assert.ok(serialized.includes('raditi-instructions-'), 'Result contract missing')
  }
  assertMcpHandshake(kimiExec.mcp, 'Kimi exec')
  passed(
    'driver-prepared Kimi exec: agent profile, thinking, tool allowlist and MCP tools pass the gateway policy',
  )

  const kimiSecond = resultFor('B13 Kimi resume', [])
  await control('scenario', { scenario: 'mcp', backend: 'kimi', text: JSON.stringify(kimiSecond) })
  const kimiResume = await runDriver({
    driver: 'kimi',
    turn: kimiTurn,
    prompt: 'Continue the synthetic task: read the site information.',
    nativeSessionId: kimiExec.nativeSessionId,
  })
  assert.equal(kimiResume.code, 0, `Driver Kimi resume failed with exit ${kimiResume.code}`)
  assert.equal(kimiResume.nativeSessionId, kimiExec.nativeSessionId)
  assert.deepEqual(kimiResume.result, kimiSecond)
  assert.equal(kimiResume.provider.length, 2)
  assert.ok(
    JSON.stringify(kimiResume.provider[0].body).includes(promptMarker),
    'The resumed Kimi session lost its history',
  )
  assertMcpHandshake(kimiResume.mcp, 'Kimi resume')
  assertMcpCalled(kimiResume.mcp, kimiResume.provider, 'Kimi resume')
  passed('driver-prepared Kimi resume calls the platform MCP tool through sandbox-gw')
  for (const value of [codexFirst, codexSecond, kimiFirst, kimiSecond])
    assert.ok(turnResultSchema.safeParse(value).success)
  return { codexRequests: 5, kimiRequests: 5, runDriver }
}
