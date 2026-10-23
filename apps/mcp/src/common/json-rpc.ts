import { z } from 'zod'

/** The id of a JSON-RPC request: what the policy admits and what an error answer repeats. */
export const rpcId = z.union([z.string().min(1).max(128), z.number().int().safe()])

export function mcpErrorId(body: unknown): string | number | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const parsed = rpcId.safeParse((body as { id?: unknown }).id)
  return parsed.success ? parsed.data : null
}
