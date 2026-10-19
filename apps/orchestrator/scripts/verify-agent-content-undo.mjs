// The trusted return of a turn's content edits, for the live mode of the agent-content stand:
// the content service of the role mcp, composed the way the regular role composes it (content
// profile, its own S3 client, Vault under the AppRole of the mcp service, the site access from
// Vault through credential_refs), asked by the fence of the turn lease alone — no token of the
// turn, which is revoked by then. The product has no network channel from core to this yet
// (N8): the stand calls the role's trusted side in a process of its own.
// Input, one JSON line on stdin: {"fence": {siteId, taskId, operation, epoch}, "turn": n}.
// Output: {"restored": n}. The environment is the one of the role mcp (roleEnvironment).
import 'reflect-metadata'
import assert from 'node:assert/strict'
import process from 'node:process'

import { NestFactory } from '@nestjs/core'
import { storageConfigFromEnv } from '@repo/storage'

import { McpAppModule } from '../dist/mcp/mcp-app.module.js'
import { MCP_CONTENT } from '../dist/mcp/mcp-content.js'

assert.equal(process.env.APP_ENV, 'test', 'Disposable verification only')
assert.equal(process.env.VAULT_DEV_ROOT_TOKEN, undefined, 'The role holds no operator token')
let input = ''
for await (const chunk of process.stdin) input += chunk
const request = JSON.parse(input)
const storage = storageConfigFromEnv(process.env)
const app = await NestFactory.createApplicationContext(
  McpAppModule.forRoot({
    appEnv: 'test',
    port: 0,
    allowedHosts: ['127.0.0.1'],
    db: { databaseUrl: process.env.DATABASE_URL },
    vault: {
      addr: process.env.VAULT_ADDR,
      appRole: { roleId: process.env.VAULT_ROLE_ID, secretId: process.env.VAULT_SECRET_ID },
    },
    // The P6 path of the stands: no previews here (plan 53, Р3).
    contentProfile: 'local-site',
    storage: {
      endpoint: storage.endpoint,
      region: storage.region,
      accessKeyId: storage.accessKeyId,
      secretAccessKey: storage.secretAccessKey,
      forcePathStyle: storage.forcePathStyle,
      buckets: { artifacts: storage.buckets.artifacts },
    },
  }),
  { logger: false },
)
try {
  const result = await app.get(MCP_CONTENT).undoTurn({ fence: request.fence, turn: request.turn })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  // The code of a domain error alone: nothing of the site or of its content.
  process.stderr.write(`Trusted content undo failed: ${String(error?.code ?? 'error')}\n`)
  process.exitCode = 1
} finally {
  await app.close()
}
