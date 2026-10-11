import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'

import {
  envVar,
  isProduction,
  llmEgressOriginSchema,
  parseEnv,
  type AppEnv,
  type Env,
  type LlmBackend,
} from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { z } from 'zod'

import { ipLiteral } from './private-address.ts'

export const DEFAULT_LLM_GATEWAY_PORT = 8084
/**
 * The one extra CA the role llm takes in production: the CA of Vault, at the path the profile
 * of the app VM gives it (infra/app/docker-compose.yml; the contract test holds the two
 * together). Provider TLS does not read the variable: the transport verifies against the
 * bundled roots alone.
 */
export const PRODUCTION_VAULT_CA_FILE = '/run/raditi/vault-ca.pem'

/** What the adapters declare, checked: a malformed declaration stops the configuration. */
const declaredOrigins = (backends: readonly LlmBackend[]) =>
  backends.flatMap((backend) => backend.egress.map((entry) => llmEgressOriginSchema.parse(entry)))

/** The fixed provider origins of the platform's adapters; the role connects to nothing else. */
export const providerOrigins: readonly string[] = [
  ...new Set(declaredOrigins(llmBackends).map((entry) => entry.origin)),
]

/** How a provider's own TLS is verified and where a stand points an origin, on either path. */
interface ProviderAccess {
  upstreamCaFile: string | null
  /** Only nonproduction may replace the adapters' fixed origins with HTTPS fakes on localhost. */
  backendOrigins: ReadonlyMap<string, string>
}

/** The proxy's CA is separate from the CA set used inside its CONNECT tunnel. */
export interface ProxyEgressConfig extends ProviderAccess {
  proxyUrl: URL
  caFile: string
  clientCertFile: string
  clientKeyFile: string
}

/**
 * No egress node: the role connects itself, and only to the origins whose adapters declare
 * that they need none (`LlmEgressOrigin.direct`). Any other origin stays unreachable.
 */
export interface DirectEgressConfig extends ProviderAccess {
  proxyUrl: null
}

/** The one way out of the role: through the proxy of the egress node when it is configured. */
export type EgressConfig = ProxyEgressConfig | DirectEgressConfig

/** One allowed client range, already validated: an address, its prefix length and family. */
export interface LlmClientRange {
  address: string
  prefix: number
  family: 'ipv4' | 'ipv6'
}

export interface LlmConfig {
  appEnv: AppEnv
  port: number
  listenHost: string
  clients: readonly LlmClientRange[]
  hosts: readonly string[]
  maxRequestsPerKey: number
  /** Calls one turn key may start within thirty seconds; one more is refused for good. */
  maxCallsPerKey30s: number
  /** Calls one turn key may start at all. */
  maxCallsPerKey: number
  egress: EgressConfig
}

const optional = envVar(z.string().optional())
const egressSchema = z.object({
  LLM_EGRESS_PROXY_URL: optional,
  LLM_EGRESS_CA_FILE: optional,
  LLM_EGRESS_CLIENT_CERT_FILE: optional,
  LLM_EGRESS_CLIENT_KEY_FILE: optional,
  LLM_UPSTREAM_CA_FILE: optional,
})
const schema = egressSchema.extend({
  LLM_GATEWAY_PORT: envVar(
    z.coerce.number().int().min(1).max(65_535).default(DEFAULT_LLM_GATEWAY_PORT),
  ),
  LLM_GATEWAY_LISTEN_HOST: optional,
  LLM_GATEWAY_CLIENTS: optional,
  LLM_GATEWAY_HOSTS: optional,
  LLM_MAX_REQUESTS_PER_KEY: envVar(z.coerce.number().int().min(1).max(2).default(2)),
  // The last line against a CLI that repeats a request without a pause, whatever the cause: a
  // turn of the pinned CLI is one request per step, and a real model answers in seconds.
  LLM_MAX_CALLS_PER_KEY_30S: envVar(z.coerce.number().int().min(1).max(1_000).default(20)),
  LLM_MAX_CALLS_PER_KEY: envVar(z.coerce.number().int().min(1).max(100_000).default(600)),
})
const invalid = (problems: readonly string[]) =>
  new Error(`[llm] invalid configuration: ${[...new Set(problems)].join('; ')}`)

function origin(raw: string): URL | null {
  const url = URL.parse(raw)
  return url &&
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash
    ? url
    : null
}

function validHost(host: string): boolean {
  const parsed = URL.parse(`http://${host}`)
  if (
    !parsed ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  )
    return false
  return (
    /^[a-z0-9.[\]:_-]+$/i.test(host) &&
    (parsed.host.toLowerCase() === host.toLowerCase() ||
      (host.endsWith(':80') && `${parsed.hostname}:80`.toLowerCase() === host.toLowerCase()))
  )
}

/** Validates without echoing an address, file path or potentially secret URL. */
export function llmConfigFromEnv(
  env: Env,
  appEnv: AppEnv,
  backends: readonly LlmBackend[] = llmBackends,
): LlmConfig {
  const own = parseEnv('llm', schema, env)
  const production = isProduction(appEnv)
  const problems: string[] = []
  const listenHost = own.LLM_GATEWAY_LISTEN_HOST ?? (production ? '0.0.0.0' : '127.0.0.1')
  if (!isIP(listenHost)) problems.push('LLM_GATEWAY_LISTEN_HOST: must be an IP address')
  const writtenClients = (
    own.LLM_GATEWAY_CLIENTS ?? (production ? '' : '127.0.0.1/32,172.16.0.0/12')
  )
    .split(',')
    .map((value) => value.trim())
  const clients: LlmClientRange[] = []
  for (const value of writtenClients) {
    const [written = '', prefix = '', ...extra] = value.split('/')
    const address = ipLiteral(written)
    const bits = Number(prefix)
    const family = address?.includes(':') ? ('ipv6' as const) : ('ipv4' as const)
    if (
      !address ||
      !/^\d{1,3}$/.test(prefix) ||
      extra.length ||
      bits > (family === 'ipv6' ? 128 : 32)
    )
      problems.push('LLM_GATEWAY_CLIENTS: must contain valid IP CIDRs')
    else clients.push({ address, prefix: bits, family })
  }
  if (production && !own.LLM_GATEWAY_CLIENTS)
    problems.push('LLM_GATEWAY_CLIENTS: required in production')
  const hosts = (
    own.LLM_GATEWAY_HOSTS ??
    (production
      ? ''
      : `127.0.0.1:${own.LLM_GATEWAY_PORT},host.docker.internal:${own.LLM_GATEWAY_PORT}`)
  )
    .split(',')
    .map((value) => value.trim().toLowerCase())
  if (hosts.some((host) => !validHost(host)))
    problems.push('LLM_GATEWAY_HOSTS: must contain exact host names with optional ports')
  if (production && !own.LLM_GATEWAY_HOSTS)
    problems.push('LLM_GATEWAY_HOSTS: required in production')

  const egress = egressFrom(own, env, production, problems, backends)
  // The role alone: a command of the operator runs wherever the operator keeps the CA of Vault.
  // Compared as written, the way Node opens it: any other file would add roots of its own.
  const extraCa = env.NODE_EXTRA_CA_CERTS
  if (production && extraCa && extraCa !== PRODUCTION_VAULT_CA_FILE)
    problems.push('NODE_EXTRA_CA_CERTS: only the CA file of Vault is allowed in production')
  if (problems.length) throw invalid(problems)
  return {
    appEnv,
    port: own.LLM_GATEWAY_PORT,
    listenHost,
    clients,
    hosts,
    maxRequestsPerKey: own.LLM_MAX_REQUESTS_PER_KEY,
    maxCallsPerKey30s: own.LLM_MAX_CALLS_PER_KEY_30S,
    maxCallsPerKey: own.LLM_MAX_CALLS_PER_KEY,
    egress,
  }
}

/** Only the way out, for operator commands that send through it but never listen. */
export function egressConfigFromEnv(
  env: Env,
  appEnv: AppEnv,
  backends: readonly LlmBackend[] = llmBackends,
): EgressConfig {
  const problems: string[] = []
  const egress = egressFrom(
    parseEnv('llm', egressSchema, env),
    env,
    isProduction(appEnv),
    problems,
    backends,
  )
  if (problems.length) throw invalid(problems)
  return egress
}

function egressFrom(
  own: z.output<typeof egressSchema>,
  env: Env,
  production: boolean,
  problems: string[],
  backends: readonly LlmBackend[],
): EgressConfig {
  const files = [
    'LLM_EGRESS_CA_FILE',
    'LLM_EGRESS_CLIENT_CERT_FILE',
    'LLM_EGRESS_CLIENT_KEY_FILE',
  ] as const
  for (const name of [...files, 'LLM_UPSTREAM_CA_FILE'] as const)
    if (own[name] && !isAbsolute(own[name])) problems.push(`${name}: must be an absolute path`)
  // All four or none, in every environment: half a proxy is a mistake, never the direct path.
  const configured = [own.LLM_EGRESS_PROXY_URL, ...files.map((name) => own[name])]
  if (configured.some(Boolean) && configured.some((value) => !value))
    problems.push(
      'LLM_EGRESS_PROXY_URL, LLM_EGRESS_CA_FILE, LLM_EGRESS_CLIENT_CERT_FILE, LLM_EGRESS_CLIENT_KEY_FILE: required together',
    )
  const proxyUrl = own.LLM_EGRESS_PROXY_URL ? origin(own.LLM_EGRESS_PROXY_URL) : null
  if (own.LLM_EGRESS_PROXY_URL && !proxyUrl)
    problems.push('LLM_EGRESS_PROXY_URL: must be an HTTPS origin without credentials')

  // Each adapter names the variable that points one of its origins at a stand's fake.
  const declared = declaredOrigins(backends)
  const overrides: Record<string, string | undefined> = parseEnv(
    'llm',
    z.object(Object.fromEntries(declared.map((entry) => [entry.overrideEnv, optional]))),
    env,
  )
  const backendOrigins = new Map<string, string>()
  for (const { origin: fixed, overrideEnv: name } of declared) {
    const raw = overrides[name]
    if (!raw) continue
    if (production) problems.push(`${name}: forbidden in production`)
    const replacement = origin(raw)
    // The name alone: provider TLS runs under the host of the override, and TLS takes no IP
    // address for a server name.
    if (replacement?.hostname !== 'localhost')
      problems.push(`${name}: must be an HTTPS origin on localhost`)
    else backendOrigins.set(fixed, replacement.origin)
  }
  if (production) {
    // The same switches the live profile of the stands refuses (infra/dev/llm-verify/live.mjs):
    // other roots for provider TLS, and a proxy of the environment under the requests the role
    // makes itself, to Vault among them.
    for (const name of [
      'LLM_UPSTREAM_CA_FILE',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'NODE_USE_SYSTEM_CA',
      'NODE_USE_ENV_PROXY',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
    ])
      if (env[name]?.trim()) problems.push(`${name}: forbidden in production`)
    if (/(?:^|\s|["'])--use-(?:system|openssl)-ca(?:=|\s|["']|$)/.test(env.NODE_OPTIONS ?? ''))
      problems.push('NODE_OPTIONS: provider CA override flags are forbidden in production')
  }
  const providers = { upstreamCaFile: own.LLM_UPSTREAM_CA_FILE ?? null, backendOrigins }
  return proxyUrl
    ? {
        proxyUrl,
        caFile: own.LLM_EGRESS_CA_FILE!,
        clientCertFile: own.LLM_EGRESS_CLIENT_CERT_FILE!,
        clientKeyFile: own.LLM_EGRESS_CLIENT_KEY_FILE!,
        ...providers,
      }
    : { proxyUrl: null, ...providers }
}
