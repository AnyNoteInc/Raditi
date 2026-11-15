import { z } from 'zod'

import { parseEgressHost } from '../preview/egress-hosts.ts'

// The skills of a site's agent (owner's request of 26.10.2026: «установи для агента по умолчанию
// следующие скилы и сделай возможность добавлять — context7, playwright»): MCP servers the CLI of
// a turn connects to besides the platform's own, over the open internet of the sandbox. Two come
// with the platform and are on unless the owner of the site turns one off: Context7 — the current
// documentation of libraries — and Playwright — a headless browser inside the sandbox for pages
// of the internet. The owner adds others by the https address of a remote MCP server. Its address
// keeps nothing secret: no query string, no credentials in it. A server that wants a key or a
// sign-in (docs/plan/80-mcp-server-credentials.md) is reached through the relay of the role mcp,
// which adds the header from Vault: the turn's CLI knows only the relay's path and its MCP token.

export const agentSkillLimits = Object.freeze({
  /** Skills an owner adds to one site; the platform's own come on top. */
  added: 8,
  nameChars: 32,
  titleChars: 80,
  urlChars: 512,
})

/**
 * The name of a skill: the key of its server in the CLI's configuration and the prefix of its
 * tools there (`<name>_<tool>`). Lower-case letters, digits and inner hyphens; never one the
 * platform's own server could share a prefix with.
 */
export const agentSkillNameSchema = z
  .string()
  .regex(/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/, 'expected lower-case letters, digits and hyphens')
  .refine((name) => !name.startsWith('raditi'), 'a name of the platform')

/** The platform's own skills, by name. */
export const builtinAgentSkillNames = ['context7', 'playwright'] as const
export type BuiltinAgentSkillName = (typeof builtinAgentSkillNames)[number]

/**
 * What one skill of a turn is: a remote MCP server the CLI reaches over the open internet, one it
 * reaches through the relay of the role mcp (a server with authorization, plan 80), or a server
 * the sandbox image carries.
 */
export type TurnSkill =
  | { name: string; kind: 'remote'; url: string }
  | { name: string; kind: 'relayed' }
  | { name: BuiltinAgentSkillName; kind: 'local' }

/**
 * How an added server is authorized (plan 80, §3.3): nothing, a header of the owner's whose value
 * is in Vault, or tokens of an OAuth sign-in in Vault.
 */
export const agentSkillAuthKinds = ['none', 'header', 'oauth'] as const
export type AgentSkillAuthKind = (typeof agentSkillAuthKinds)[number]

/** Whether its authorization works, as the last check or relayed call found it. */
export const agentSkillAuthStates = ['ok', 'needs_login', 'failed'] as const
export type AgentSkillAuthState = (typeof agentSkillAuthStates)[number]

/** The path of the relay of one server, under the role mcp's own endpoint (`/mcp`). */
export const skillRelayPath = (name: string): string => `/mcp/skill/${name}`
/** A path the relay serves: one name of a skill, nothing after it. */
export const SKILL_RELAY_PATH = /^\/mcp\/skill\/([a-z](?:[a-z0-9-]{0,30}[a-z0-9])?)$/

export const agentSkillHeaderLimits = Object.freeze({
  nameChars: 64,
  /** The least that is masked in what the server answers (plan 80, §3.2, п. 6). */
  valueMinChars: 8,
  valueMaxChars: 4096,
})

/**
 * Headers the relay sets or the protocol owns: the owner's header is never one of them. The relay
 * also refuses any name the CLI sends on (`mcp-*`, `last-event-id`).
 */
const reservedHeaderNames = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'cookie',
  'accept',
  'accept-encoding',
  'last-event-id',
  'origin',
  'forwarded',
  'via',
])

/** The name of the owner's header: an HTTP token, not one of the relay's own. */
export const agentSkillHeaderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(agentSkillHeaderLimits.nameChars)
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, 'expected an HTTP header name')
  .refine((name) => {
    const lower = name.toLowerCase()
    return (
      !reservedHeaderNames.has(lower) &&
      !lower.startsWith('mcp-') &&
      !lower.startsWith('x-forwarded-')
    )
  }, 'a header the relay owns')

/** Its value: visible ASCII and spaces, one line, long enough to be masked in an answer. */
export const agentSkillHeaderValueSchema = z
  .string()
  .min(agentSkillHeaderLimits.valueMinChars)
  .max(agentSkillHeaderLimits.valueMaxChars)
  .regex(/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/, 'expected one line of visible characters')

export interface BuiltinAgentSkill {
  name: BuiltinAgentSkillName
  /** What the cabinet shows. */
  title: string
  description: string
  turn: TurnSkill
}

/** The Context7 MCP server: library documentation by name and version, no key needed. */
export const CONTEXT7_MCP_URL = 'https://mcp.context7.com/mcp'

export const builtinAgentSkills: readonly BuiltinAgentSkill[] = Object.freeze([
  {
    name: 'context7',
    title: 'Context7',
    description: 'Свежая документация библиотек и фреймворков, которыми сделан сайт.',
    turn: { name: 'context7', kind: 'remote', url: CONTEXT7_MCP_URL },
  },
  {
    name: 'playwright',
    title: 'Playwright',
    description: 'Браузер, в котором агент открывает страницы в интернете и ищет нужное.',
    turn: { name: 'playwright', kind: 'local' },
  },
])

export const isBuiltinAgentSkill = (name: string): name is BuiltinAgentSkillName =>
  (builtinAgentSkillNames as readonly string[]).includes(name)

/** The ports a remote skill may use: those the open internet of the sandbox tunnels TLS to. */
const SKILL_PORTS = new Set([443, 8443])

/**
 * The address of a remote skill as the owner gives it: https, a public DNS name on 443 or 8443,
 * a path, nothing else — no credentials, no query string, no fragment, no brace (the CLI
 * replaces `{env:…}` and `{file:…}` in the text of its configuration). null for anything else;
 * the result is the URL as the platform keeps it.
 */
export function parseAgentSkillUrl(text: string): string | null {
  if (text.length > agentSkillLimits.urlChars || /[{}\s\\]/.test(text)) return null
  const url = URL.parse(text)
  if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '')
    return null
  if (url.search !== '' || url.hash !== '' || text.includes('?') || text.includes('#')) return null
  const host = parseEgressHost(url.port === '' ? url.hostname : `${url.hostname}:${url.port}`)
  if (host === null || !SKILL_PORTS.has(host.port)) return null
  const kept = `https://${host.host}${host.port === 443 ? '' : `:${host.port}`}${url.pathname}`
  return kept.length <= agentSkillLimits.urlChars ? kept : null
}

export const agentSkillUrlSchema = z
  .string()
  .max(agentSkillLimits.urlChars)
  .transform((text, ctx) => {
    const url = parseAgentSkillUrl(text.trim())
    if (url === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'expected an https address on port 443 or 8443, without credentials or a query',
      })
      return z.NEVER
    }
    return url
  })

export const turnSkillSchema = z.discriminatedUnion('kind', [
  z
    .object({
      name: agentSkillNameSchema,
      kind: z.literal('remote'),
      url: z.string().refine((url) => parseAgentSkillUrl(url) === url, 'a kept skill address'),
    })
    .strict(),
  z.object({ name: agentSkillNameSchema, kind: z.literal('relayed') }).strict(),
  z.object({ name: z.enum(builtinAgentSkillNames), kind: z.literal('local') }).strict(),
]) satisfies z.ZodType<TurnSkill>

/** The skills of one turn: each name once. */
export const turnSkillsSchema = z
  .array(turnSkillSchema)
  .max(builtinAgentSkillNames.length + agentSkillLimits.added)
  .refine(
    (skills) => new Set(skills.map((skill) => skill.name)).size === skills.length,
    'duplicate skill',
  )

/** A row of the site's skills as the platform keeps it (`site_agent_skills`). */
export interface SiteAgentSkillRow {
  name: string
  enabled: boolean
  /** An added skill's address; null for one of the platform's own. */
  url: string | null
  /** How an added skill is authorized; absent — `none` (a row read without the column). */
  authKind?: AgentSkillAuthKind
  /** Whether that works; absent — `ok`. */
  authState?: AgentSkillAuthState
}

/**
 * The skills of a site's turn, in a fixed order: the platform's own first unless a row turns one
 * off, then the added ones that are on, by name. A row that does not parse is left out.
 *
 * A turn that has the platform's browser (`web_*`) gets no local one: the skill's Chromium would
 * run inside the turn's sandbox next to the session's, a second browser of the same chat — its
 * memory and CPU on every turn, and screenshots no client can see.
 *
 * An added skill with authorization goes through the relay (`relayed`, plan 80); one whose
 * authorization does not work now — the owner has to sign in again — is left out.
 */
export function turnSkillsOf(
  rows: readonly SiteAgentSkillRow[],
  { platformBrowser = false }: { platformBrowser?: boolean } = {},
): TurnSkill[] {
  const byName = new Map(rows.map((row) => [row.name, row]))
  const skills: TurnSkill[] = []
  for (const builtin of builtinAgentSkills)
    if (byName.get(builtin.name)?.enabled !== false)
      if (!(platformBrowser && builtin.turn.kind === 'local')) skills.push(builtin.turn)
  const added = rows
    .filter((row) => !isBuiltinAgentSkill(row.name) && row.enabled && row.url !== null)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const row of added.slice(0, agentSkillLimits.added)) {
    const authorized = (row.authKind ?? 'none') !== 'none'
    if (authorized && (row.authState ?? 'ok') !== 'ok') continue
    const skill = turnSkillSchema.safeParse(
      authorized
        ? { name: row.name, kind: 'relayed' }
        : { name: row.name, kind: 'remote', url: row.url },
    )
    if (skill.success) skills.push(skill.data)
  }
  return skills
}

/**
 * Where the secret of an added server lives (plan 80, §3.3): beside the site's accesses, so that
 * «Удалить проект» erases it with them. One version, written by CAS.
 */
export const agentSkillSecretPath = (siteId: string, name: string): string =>
  `kv/sites/${siteId}/mcp/${name}`

const oauthTokenSchema = z
  .string()
  .min(agentSkillHeaderLimits.valueMinChars)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/)

/**
 * The secret of an added server in Vault: the value of its header, or the tokens of its OAuth
 * sign-in. Anything else — a version without a value that erased it — is no secret.
 */
export const agentSkillSecretSchema = z.union([
  z.strictObject({ value: agentSkillHeaderValueSchema }),
  z.strictObject({
    accessToken: oauthTokenSchema,
    refreshToken: oauthTokenSchema.optional(),
    clientSecret: oauthTokenSchema.optional(),
  }),
])
export type AgentSkillSecret = z.infer<typeof agentSkillSecretSchema>
