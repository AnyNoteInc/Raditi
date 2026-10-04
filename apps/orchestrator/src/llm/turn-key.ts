import { createHash, randomBytes } from 'node:crypto'

import type { Prisma } from '@repo/db'
import { snapshotIdSchema, type TurnCredentialRef, type TurnCredentialValues } from '@repo/domain'
import { z } from 'zod'

const LLM_KEY_FORMAT = 'sk-rdt-[A-Za-z0-9_-]{43}'
const MCP_TOKEN_FORMAT = 'mcp_[a-f0-9]{64}'
/** The key of one turn for the subscription gateway: 32 random bytes in base64url. */
export const LLM_KEY_PATTERN = new RegExp(`^${LLM_KEY_FORMAT}$`)
/** The MCP token issued in pair with it: 32 random bytes in hex. */
export const MCP_TOKEN_PATTERN = new RegExp(`^${MCP_TOKEN_FORMAT}$`)
/** Either of the pair anywhere in a text: for a filter that must not let one out. */
export const TURN_KEY_IN_TEXT = new RegExp(`${LLM_KEY_FORMAT}|${MCP_TOKEN_FORMAT}`)

/** A new pair for one turn. The values live in Vault `turns/`; SQL keeps only their hashes. */
export function newTurnKeys(): TurnCredentialValues {
  return {
    llmApiKey: `sk-rdt-${randomBytes(32).toString('base64url')}`,
    mcpToken: `mcp_${randomBytes(32).toString('hex')}`,
  }
}

/** What `llm_keys.key_hash` and `llm_keys.mcp_token_hash` hold for a key or a token. */
export function turnKeyHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** Where the llm role keeps an account's subscription credential; `credential_refs` stores it. */
export function subscriptionCredentialPath(backendId: string, accountId: string): string {
  return `subs/${backendId}/${accountId}`
}

/**
 * The mutex of one provider's pool, held until the transaction ends. Key issue, account import,
 * retirement and the sweeper's final disable take it before any account row, and only through
 * this function: holders that spell the key differently do not exclude one another.
 */
export async function lockSubscriptionPool(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  backendSlug: string,
): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pool:${backendSlug}`}, 0))::text`
}

export const turnCredentialRefSchema = z
  .object({
    taskId: z.uuid().transform((id) => id.toLowerCase()),
    // The sandbox session label: printable, so its Vault metadata can never be refused.
    sessionId: snapshotIdSchema,
    turn: z.number().int().positive().max(999_999),
    epoch: z.number().int().positive().max(2_147_483_647),
  })
  .strict()

/** A deterministic write-once path; session identity is checked in the value and SQL. */
export function turnCredentialPath(value: TurnCredentialRef): string {
  const ref = turnCredentialRefSchema.parse(value)
  return `turns/t_${ref.taskId}_${ref.turn}_${ref.epoch}`
}

export function parseTurnCredentialPath(name: string): Omit<TurnCredentialRef, 'sessionId'> | null {
  const match = /^(?:turns\/)?t_([0-9a-f-]{36})_([1-9][0-9]{0,5})_([1-9][0-9]{0,9})$/.exec(name)
  if (!match) return null
  const result = turnCredentialRefSchema.omit({ sessionId: true }).safeParse({
    taskId: match[1],
    turn: Number(match[2]),
    epoch: Number(match[3]),
  })
  return result.success ? result.data : null
}
