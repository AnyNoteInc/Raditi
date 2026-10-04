import { badRequest, type LlmBackend } from '@repo/domain'
import { refreshCodexCredential, revokeCodexCredential } from './auth.ts'
import { codexCredentialMetadata, codexCredentialSchema } from './credentials.ts'
import { codexEgress, codexUrls } from './egress.ts'
import { codexDeviceLogin } from './login.ts'
import { assertCodexRoute, normalizeCodexBody } from './policy.ts'
import {
  classifyCodexResponse,
  codexAccountHeaders,
  codexRefusal,
  codexWindowsFromHeaders,
  probeCodexAccount,
} from './responses.ts'
import { createCodexUsageMeter } from './usage.ts'
import { createCodexStreamInspector } from './stream.ts'

const forwardedHeaders = [
  'user-agent',
  'originator',
  'session-id',
  'thread-id',
  'x-client-request-id',
  'x-openai-subagent',
  'x-codex-turn-state',
]
// Responses Lite moves tool definitions into input; the CLI marks that wire mode.
const liteHeader = 'x-openai-internal-codex-responses-lite'

export const codexBackend: LlmBackend = {
  id: 'openai-chatgpt',
  routes: [{ method: 'POST', path: '/codex/responses' }],
  credentialSchema: codexCredentialSchema,
  clientHeaders: [...forwardedHeaders, liteHeader],
  responseHeaders: ['x-codex-turn-state'],
  egress: codexEgress,
  credentialMetadata: codexCredentialMetadata,
  validateClientHeaders(headers) {
    const value = headers.get('user-agent')
    if (
      value === null ||
      !/^codex_(?:exec|cli_rs)\/0\.(?:154\.0|158\.0|159\.1)(?: \([^\r\n]{1,256}\))?$/.test(value)
    )
      throw badRequest('Invalid Codex client identity')
    const lite = headers.get(liteHeader)
    if (lite !== null && lite !== 'true') throw badRequest('Invalid Codex client identity')
  },
  streamInspector: createCodexStreamInspector,
  normalizeBody: normalizeCodexBody,
  upstream(route, _body, clientHeaders, credential, identity) {
    assertCodexRoute(route)
    const headers = codexAccountHeaders(credential, identity)
    for (const key of forwardedHeaders) {
      const value = clientHeaders.get(key)
      if (value !== null) headers.set(key, value)
    }
    if (clientHeaders.get(liteHeader) === 'true') headers.set(liteHeader, 'true')
    headers.set('accept', 'text/event-stream')
    headers.set('content-type', 'application/json')
    return { url: codexUrls.responses, method: 'POST', headers }
  },
  usageMeter: createCodexUsageMeter,
  classify: classifyCodexResponse,
  windowsFromHeaders: codexWindowsFromHeaders,
  refusal: codexRefusal,
  probe: probeCodexAccount,
  refresh: refreshCodexCredential,
  login: codexDeviceLogin,
  revoke: revokeCodexCredential,
}
