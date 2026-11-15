import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import type { PrismaClient } from '@repo/db'
import {
  agentSkillSecretPath,
  type AgentSkillOAuth,
  type AgentSkillSecret,
  type SecretStore,
} from '@repo/domain'

import type { SkillSecretRead, SkillSecrets } from './skill-secrets.ts'
import type { upstreamResolver } from './upstream.ts'

// The renewal of the access token of a server signed in with OAuth
// (docs/plan/81-mcp-server-credentials.md, §3.4): under an advisory lock of the server, so that the
// turns that need it at once renew it once; Vault is read again under the lock — another turn may
// have renewed it already —, the refresh token is spent at the token endpoint of the sign-in (a
// public address, no redirect), and the new tokens are written back by CAS with the expiry in the row.

const TIMEOUT_MS = 10_000
const ANSWER_BYTES = 64 * 1024

type Resolve = ReturnType<typeof upstreamResolver>

export interface TokenRenewerDeps {
  prisma: Pick<PrismaClient, '$transaction'>
  secrets: Pick<SkillSecrets, 'read' | 'forget'>
  vault: Pick<SecretStore, 'kvWrite'>
  resolve: Resolve
  now?: () => Date
}

/** A form posted to the token endpoint; its JSON answer, or null. */
async function postForm(
  resolve: Resolve,
  endpoint: string,
  form: URLSearchParams,
): Promise<Record<string, unknown> | null> {
  const url = new URL(endpoint)
  const target = await resolve(url)
  const secure = url.protocol === 'https:'
  return new Promise((resolveAnswer) => {
    const req = (secure ? httpsRequest : httpRequest)(
      {
        host: target.address,
        family: target.family,
        port: target.port ?? (url.port === '' ? (secure ? 443 : 80) : Number(url.port)),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          host: url.host,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'user-agent': 'Raditi-MCP-Relay/1',
        },
        timeout: TIMEOUT_MS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(secure ? { servername: url.hostname } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > ANSWER_BYTES) req.destroy()
          else chunks.push(chunk)
        })
        res.on('end', () => {
          if (res.statusCode !== 200) return resolveAnswer(null)
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            resolveAnswer(
              parsed !== null && typeof parsed === 'object'
                ? (parsed as Record<string, unknown>)
                : null,
            )
          } catch {
            resolveAnswer(null)
          }
        })
        res.on('error', () => resolveAnswer(null))
      },
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolveAnswer(null))
    req.end(form.toString())
  })
}

const token = (value: unknown): string | undefined =>
  typeof value === 'string' &&
  value.length >= 8 &&
  value.length <= 8192 &&
  /^[\x21-\x7e]+$/.test(value)
    ? value
    : undefined

export class TokenRenewer {
  constructor(private readonly deps: TokenRenewerDeps) {}

  /**
   * The secret of the server with a fresh access token, or null when it cannot be renewed — no
   * refresh token, or the server of sign-in refused it: the owner signs in again.
   */
  async renew(
    siteId: string,
    name: string,
    oauth: AgentSkillOAuth,
    used: SkillSecretRead,
  ): Promise<SkillSecretRead | null> {
    const now = (this.deps.now ?? (() => new Date()))()
    return this.deps.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mcp-skill:${siteId}/${name}`}, 0))`
        this.deps.secrets.forget(siteId, name)
        const fresh = await this.deps.secrets.read(siteId, name)
        if (fresh === null || !('accessToken' in fresh.secret)) return null
        // Another turn renewed it while this one waited for the lock.
        if (fresh.version !== used.version) return fresh
        const { refreshToken, clientSecret } = fresh.secret
        if (refreshToken === undefined) return null
        const answer = await postForm(
          this.deps.resolve,
          oauth.tokenEndpoint,
          new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: oauth.clientId,
            resource: oauth.resource,
            ...(clientSecret ? { client_secret: clientSecret } : {}),
          }),
        ).catch(() => null)
        const accessToken = token(answer?.access_token)
        if (accessToken === undefined) return null
        const secret: AgentSkillSecret = {
          accessToken,
          // A server that rotates refresh tokens gives a new one; one that does not keeps the old.
          refreshToken: token(answer?.refresh_token) ?? refreshToken,
          ...(clientSecret ? { clientSecret } : {}),
        }
        const written = await this.deps.vault.kvWrite(
          agentSkillSecretPath(siteId, name),
          Object.fromEntries(Object.entries(secret).filter(([, value]) => value !== undefined)),
          { cas: fresh.version, maxVersions: 1 },
        )
        const seconds =
          typeof answer?.expires_in === 'number' && answer.expires_in > 0 ? answer.expires_in : null
        const { expiresAt: _expired, ...kept } = oauth
        await tx.siteAgentSkill.updateMany({
          where: { siteId, name, authKind: 'oauth' },
          data: {
            oauth:
              seconds === null
                ? kept
                : { ...kept, expiresAt: new Date(now.getTime() + seconds * 1000).toISOString() },
            authState: 'ok',
            authError: null,
            authCheckedAt: now,
          },
        })
        this.deps.secrets.forget(siteId, name)
        return { secret, version: written.version }
      },
      { timeout: 30_000 },
    )
  }
}
