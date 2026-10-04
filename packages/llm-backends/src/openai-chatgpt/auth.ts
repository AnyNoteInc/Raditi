import { llmGatewayUnavailable, type LlmBackend } from '@repo/domain'

import { controlRequest, decodeControlJson, encodeJson } from '../shared.ts'
import { object } from '../usage.ts'
import { credentialFromTokens, readCodexCredential } from './credentials.ts'
import { codexUrls } from './egress.ts'

export const codexClientId = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const codexAuthHeaders = (contentType = 'application/json'): Headers =>
  new Headers({
    'content-type': contentType,
    accept: 'application/json',
    'accept-encoding': 'identity',
    originator: 'codex_cli_rs',
    'user-agent': 'codex_cli_rs/0.158.0',
  })

const finalCodes = new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
])

export const refreshCodexCredential: NonNullable<LlmBackend['refresh']> = async (value, http) => {
  const credential = readCodexCredential(value)
  try {
    const response = await controlRequest(http, {
      url: codexUrls.token,
      method: 'POST',
      headers: codexAuthHeaders(),
      body: encodeJson({
        grant_type: 'refresh_token',
        client_id: codexClientId,
        refresh_token: credential.refreshToken,
      }),
    })
    const body = decodeControlJson(response.body)
    if (body === null) return { kind: 'ambiguous' }
    if (response.status === 200) {
      if (body.error !== undefined) return { kind: 'ambiguous' }
      const merged = credentialFromTokens(body, new Date(), credential)
      return merged === null ? { kind: 'ambiguous' } : { kind: 'ok', credential: merged }
    }
    const error = object(body.error)
    const code = typeof body.error === 'string' ? body.error : (error?.code ?? error?.type)
    const hasError = typeof body.error === 'string' || error !== undefined
    if (response.status === 403 && code === 'unsupported_country_region_territory')
      return { kind: 'final', reason: 'region' }
    if (hasError && (response.status === 400 || response.status === 401)) {
      if (
        response.status === 401 ||
        (typeof code === 'string' && finalCodes.has(code)) ||
        code === 'invalid_grant'
      )
        return { kind: 'final', reason: 'auth' }
    }
    return { kind: 'ambiguous' }
  } catch {
    return { kind: 'ambiguous' }
  }
}

export const revokeCodexCredential: NonNullable<LlmBackend['revoke']> = async (value, http) => {
  const credential = readCodexCredential(value)
  const response = await controlRequest(http, {
    url: codexUrls.revoke,
    method: 'POST',
    headers: codexAuthHeaders(),
    body: encodeJson({
      token: credential.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: codexClientId,
    }),
  })
  if (response.status < 200 || response.status >= 300) throw llmGatewayUnavailable()
}
