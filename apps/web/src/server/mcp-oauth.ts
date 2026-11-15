import 'server-only'

import { createHash, randomBytes } from 'node:crypto'

import {
  PublicRequestRefused,
  type PublicAnswer,
  type PublicRequester,
} from '@/server/public-request'

// The sign-in of an MCP server that wants OAuth (docs/plan/81-mcp-server-credentials.md, §3.4;
// the authorization of the MCP specification): the server names its metadata (RFC 9728), that
// names the server of sign-in and its metadata (RFC 8414); the platform registers a public client
// there (RFC 7591), sends the owner to sign in with PKCE (S256) and the resource (RFC 8707), and
// exchanges the code for tokens. Every request goes to a public address (public-request.ts).

export type McpOAuthReason =
  'no_sign_in' | 'unsupported' | 'unreachable' | 'address_refused' | 'refused'

export class McpOAuthRefused extends Error {
  readonly reason: McpOAuthReason

  constructor(reason: McpOAuthReason) {
    super(reason)
    this.reason = reason
  }
}

/** What a started sign-in keeps until the owner comes back: in a sealed cookie, never in the base. */
export interface PendingSignIn {
  url: string
  issuer: string
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  verifier: string
  state: string
  scope?: string
  redirectUri: string
}

export interface SignInTokens {
  accessToken: string
  refreshToken?: string
  /** Seconds, as the server said. */
  expiresIn?: number
  scope?: string
}

const json = (answer: PublicAnswer): Record<string, unknown> | null => {
  if (answer.status !== 200) return null
  try {
    const parsed: unknown = JSON.parse(answer.body)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const text = (value: unknown, max = 2048): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined

const base64url = (bytes: Buffer) => bytes.toString('base64url')

/** The well-known addresses of a metadata document, the path of `base` inserted (RFC 8414, 3.1). */
function wellKnown(base: string, name: string): string[] {
  const url = new URL(base)
  const path = url.pathname.replace(/\/$/, '')
  const candidates = [`${url.origin}/.well-known/${name}${path}`]
  if (path !== '') candidates.push(`${url.origin}/.well-known/${name}`)
  return candidates
}

export function mcpOAuthClient(request: PublicRequester) {
  const refusal = (error: unknown): never => {
    if (error instanceof McpOAuthRefused) throw error
    if (error instanceof PublicRequestRefused)
      throw new McpOAuthRefused(
        error.reason === 'address_refused' ? 'address_refused' : 'unreachable',
      )
    throw new McpOAuthRefused('unreachable')
  }
  const getJson = async (url: string) =>
    json(await request({ url, method: 'GET', headers: { accept: 'application/json' } }))
  const firstJson = async (urls: readonly string[]) => {
    for (const url of urls) {
      const found = await getJson(url).catch(() => null)
      if (found !== null) return found
    }
    return null
  }

  return {
    /** Finds where the server signs in, registers the platform there and builds the address. */
    async start(
      url: string,
      redirectUri: string,
    ): Promise<{ authorizationUrl: string; pending: PendingSignIn }> {
      try {
        // The server says where its metadata is when it refuses a request without a token.
        const asked = await request({
          url,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'raditi-check', version: '1' },
            },
          }),
        })
        const named = /resource_metadata="([^"]+)"/.exec(
          String(asked.headers['www-authenticate'] ?? ''),
        )?.[1]
        const resource = await firstJson(
          named ? [named] : wellKnown(url, 'oauth-protected-resource'),
        )
        const servers = resource?.authorization_servers
        const issuer = Array.isArray(servers) ? text(servers[0]) : undefined
        if (issuer === undefined) throw new McpOAuthRefused('no_sign_in')
        const metadata = await firstJson([
          ...wellKnown(issuer, 'oauth-authorization-server'),
          ...wellKnown(issuer, 'openid-configuration'),
        ])
        const authorizationEndpoint = text(metadata?.authorization_endpoint)
        const tokenEndpoint = text(metadata?.token_endpoint)
        const registrationEndpoint = text(metadata?.registration_endpoint)
        const methods = metadata?.code_challenge_methods_supported
        // PKCE with S256 is the protocol's; a server that registers no client is not one we use.
        if (
          authorizationEndpoint === undefined ||
          tokenEndpoint === undefined ||
          registrationEndpoint === undefined ||
          (Array.isArray(methods) && !methods.includes('S256'))
        )
          throw new McpOAuthRefused('unsupported')
        const registered = await request({
          url: registrationEndpoint,
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            client_name: 'Радити',
            redirect_uris: [redirectUri],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          }),
        })
        const client =
          registered.status === 201 || registered.status === 200
            ? json({ ...registered, status: 200 })
            : null
        const clientId = text(client?.client_id, 512)
        if (clientId === undefined) throw new McpOAuthRefused('unsupported')
        const clientSecret = text(client?.client_secret, 8192)
        const scopes = resource?.scopes_supported
        const scope = Array.isArray(scopes)
          ? scopes
              .filter((item): item is string => typeof item === 'string')
              .join(' ')
              .slice(0, 1024) || undefined
          : undefined
        const verifier = base64url(randomBytes(32))
        const state = base64url(randomBytes(24))
        const authorization = new URL(authorizationEndpoint)
        // The owner's browser goes there: https, or plain http to loopback alone (tests and stands).
        if (
          authorization.protocol !== 'https:' &&
          !(
            authorization.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(authorization.hostname)
          )
        )
          throw new McpOAuthRefused('unsupported')
        for (const [name, value] of Object.entries({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: base64url(createHash('sha256').update(verifier).digest()),
          code_challenge_method: 'S256',
          state,
          resource: url,
          ...(scope ? { scope } : {}),
        }))
          authorization.searchParams.set(name, value)
        return {
          authorizationUrl: authorization.href,
          pending: {
            url,
            issuer,
            tokenEndpoint,
            clientId,
            ...(clientSecret ? { clientSecret } : {}),
            verifier,
            state,
            ...(scope ? { scope } : {}),
            redirectUri,
          },
        }
      } catch (error) {
        return refusal(error)
      }
    },

    /** Exchanges the code the owner came back with for tokens. */
    async finish(pending: PendingSignIn, code: string): Promise<SignInTokens> {
      try {
        const form = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: pending.redirectUri,
          client_id: pending.clientId,
          code_verifier: pending.verifier,
          resource: pending.url,
          ...(pending.clientSecret ? { client_secret: pending.clientSecret } : {}),
        })
        const answer = await request({
          url: pending.tokenEndpoint,
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: form.toString(),
        })
        const tokens = json(answer)
        const accessToken = text(tokens?.access_token, 8192)
        if (accessToken === undefined) throw new McpOAuthRefused('refused')
        const refreshToken = text(tokens?.refresh_token, 8192)
        const expiresIn =
          typeof tokens?.expires_in === 'number' && tokens.expires_in > 0
            ? tokens.expires_in
            : undefined
        const scope = text(tokens?.scope, 1024)
        return {
          accessToken,
          ...(refreshToken ? { refreshToken } : {}),
          ...(expiresIn ? { expiresIn } : {}),
          ...(scope ? { scope } : {}),
        }
      } catch (error) {
        return refusal(error)
      }
    },
  }
}

export type McpOAuthClient = ReturnType<typeof mcpOAuthClient>
