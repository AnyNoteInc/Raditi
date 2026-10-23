import { badRequest } from '@repo/domain'

/** Stable JSON with limits applied before recursive descent. No input enters diagnostics. */
export function mcpCanonicalJson(value: unknown): string {
  let nodes = 0
  function visit(input: unknown, depth: number): unknown {
    if (++nodes > 5000 || depth > 16) throw badRequest('Invalid MCP journal JSON')
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (Array.isArray(input)) return input.map((child) => visit(child, depth + 1))
    if (
      typeof input !== 'object' ||
      !input ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      throw badRequest('Invalid MCP journal JSON')
    const entries = Object.entries(input).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [key, child] of entries) {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw badRequest('Invalid MCP journal JSON')
      result[key] = visit(child, depth + 1)
    }
    return result
  }
  const encoded = JSON.stringify(visit(value, 1))
  if (Buffer.byteLength(encoded) > 64 * 1024) throw badRequest('MCP journal JSON exceeds its limit')
  return encoded
}
