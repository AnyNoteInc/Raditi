import {
  badRequest,
  llmGatewayUnavailable,
  type DeviceLogin,
  type DeviceLoginState,
  type EgressRequest,
} from '@repo/domain'

import { decodeControlJson, encodeJson } from '../shared.ts'
import { object } from '../usage.ts'
import { codexAuthHeaders, codexClientId } from './auth.ts'
import { credentialFromTokens } from './credentials.ts'
import { codexUrls } from './egress.ts'

const verificationUri = 'https://auth.openai.com/codex/device'
const callbackUri = 'https://auth.openai.com/deviceauth/callback'
const codeLifetimeMs = 15 * 60_000
const token = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value)

function privateState(state: DeviceLoginState): Record<string, unknown> {
  const value = object(state.privateState)
  if (
    value === undefined ||
    (value.phase !== 'poll' && value.phase !== 'exchange') ||
    !token(value.deviceAuthId) ||
    !token(state.userCode) ||
    state.verificationUri !== verificationUri ||
    !Number.isFinite(state.expiresAt.getTime()) ||
    !Number.isSafeInteger(state.intervalMs) ||
    state.intervalMs < 1000 ||
    state.intervalMs > codeLifetimeMs
  )
    throw badRequest('Invalid Codex login state')
  return value
}

export const codexDeviceLogin: DeviceLogin = {
  start(_identity) {
    return {
      url: codexUrls.deviceCode,
      method: 'POST',
      headers: codexAuthHeaders(),
      body: encodeJson({ client_id: codexClientId }),
    }
  },
  parseStart(response, now) {
    const body = decodeControlJson(response.body)
    if (response.status !== 200 || body === null || !Number.isFinite(now.getTime()))
      throw llmGatewayUnavailable()
    const userCode = body.user_code ?? body.usercode
    const interval =
      body.interval === undefined
        ? 5
        : typeof body.interval === 'string' && /^\d+$/.test(body.interval.trim())
          ? Number(body.interval.trim())
          : body.interval
    if (
      !token(body.device_auth_id) ||
      !token(userCode) ||
      typeof interval !== 'number' ||
      !Number.isSafeInteger(interval) ||
      interval < 1 ||
      interval > 900
    )
      throw llmGatewayUnavailable()
    const expiresAt = new Date(now.getTime() + codeLifetimeMs)
    if (!Number.isFinite(expiresAt.getTime())) throw llmGatewayUnavailable()
    return {
      verificationUri,
      userCode,
      expiresAt,
      intervalMs: interval * 1000,
      privateState: { phase: 'poll', deviceAuthId: body.device_auth_id },
    }
  },
  poll(state) {
    const value = privateState(state)
    if (value.phase !== 'poll') throw badRequest('Codex login is awaiting token exchange')
    return {
      url: codexUrls.deviceToken,
      method: 'POST',
      headers: codexAuthHeaders(),
      body: encodeJson({ device_auth_id: value.deviceAuthId, user_code: state.userCode }),
    }
  },
  parsePoll(response, state, now) {
    const value = privateState(state)
    if (!Number.isFinite(now.getTime())) throw badRequest('Invalid Codex login time')
    // The deadline bounds polling. Tokens the provider has already issued in the exchange
    // are kept even when its reply is late: dropped here, they would remain a live
    // refresh-token chain that nobody stores and nobody can revoke.
    if (value.phase === 'poll' && now >= state.expiresAt) return { kind: 'denied' }
    if (value.phase === 'poll' && (response.status === 403 || response.status === 404))
      return { kind: 'pending', intervalMs: state.intervalMs }
    const body = decodeControlJson(response.body)
    if (response.status !== 200) return { kind: 'denied' }
    if (body === null || body.error !== undefined) throw llmGatewayUnavailable()
    if (value.phase === 'exchange') {
      const credential = credentialFromTokens(body, now)
      if (credential === null) throw llmGatewayUnavailable()
      return { kind: 'complete', credential }
    }
    if (
      !token(body.authorization_code) ||
      !token(body.code_verifier) ||
      !token(body.code_challenge)
    )
      throw llmGatewayUnavailable()
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: codexClientId,
      code: body.authorization_code,
      redirect_uri: callbackUri,
      code_verifier: body.code_verifier,
    })
    const request: EgressRequest = {
      url: codexUrls.token,
      method: 'POST',
      headers: codexAuthHeaders('application/x-www-form-urlencoded'),
      body: new TextEncoder().encode(form.toString()),
    }
    return {
      kind: 'next',
      request,
      state: { ...state, privateState: { ...value, phase: 'exchange' } },
    }
  },
}
