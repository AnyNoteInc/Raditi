import { isIP } from 'node:net'

/** Hostnames only: sandbox-gw rewrites Host to the configured upstream's host. */
export function parseMcpHosts(raw: string | undefined, production: boolean): string[] {
  if (!raw?.trim()) {
    if (production) throw new Error('MCP_ALLOWED_HOSTS: required for the mcp role in production')
    // Same hosts as the LLM_GATEWAY_HOSTS dev default: on Docker Desktop sandbox-gw sends
    // Host: host.docker.internal for both upstreams.
    return ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']
  }
  const names = raw.split(',').map((value) => value.trim().toLowerCase())
  for (const name of names) {
    const ip = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name
    if (isIP(ip) === 6 && ip !== name) continue
    if (isIP(name) === 4) continue
    if (
      name.length > 253 ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
        name,
      )
    )
      throw new Error('MCP_ALLOWED_HOSTS: expected exact hostnames or IP addresses, without ports')
  }
  // WHATWG URL canonicalises IPv6 in incoming Host headers. Apply the same rule to config
  // before comparing or deduplicating equivalent full and compressed spellings.
  try {
    return [...new Set(names.map((name) => new URL(`http://${name}`).hostname.toLowerCase()))]
  } catch {
    throw new Error('MCP_ALLOWED_HOSTS: expected exact hostnames or IP addresses, without ports')
  }
}
