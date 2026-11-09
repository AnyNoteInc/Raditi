/** WP-CLI arguments that would override the runner's site or account. */
const wpCliTargetFlags = new Set(['ssh', 'http', 'path', 'url', 'user'])

/** argv of one WP-CLI call, with or without the leading `wp`. */
export function isWpCliCommandDenied(argv: readonly string[]): boolean {
  const args = argv[0] === 'wp' ? argv.slice(1) : argv
  let hasCommand = false
  for (const arg of args) {
    if (arg === '--' || arg.includes('\0') || arg.startsWith('@')) return true
    if (arg.startsWith('--')) {
      const name = arg.slice(2).split('=', 1)[0]!.toLowerCase()
      if (wpCliTargetFlags.has(name)) return true
    } else if (arg.trim() !== '') {
      hasCommand = true
    }
  }
  return !hasCommand
}

/** Reject paths with ambiguous encoding or traversal. */
function isWordpressPathInvalid(path: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return true
  }
  return (
    decoded.includes('\0') ||
    decoded.includes('%') ||
    decoded.includes('\\') ||
    decoded.split('/').includes('..')
  )
}

const reads = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Preserve the browser's read/write boundary for WordPress's query method override. */
export function isRestRequestDenied(method: string, route: string): boolean {
  const [path = '', query = ''] = route.split('#')[0]!.split(/\?(.*)/s)
  const params = new URLSearchParams(query)
  if (isWordpressPathInvalid(path)) return true
  for (const [key, value] of params) {
    if (key.includes('\0')) return true
    const name = key.replace(/^ +/, '').replace(/\[.*$/s, '').replace(/[ .]/g, '_')
    if (name === 'rest_route' && isWordpressPathInvalid(value)) return true
    if (
      name === '_method' &&
      reads.has(method.trim().toUpperCase()) &&
      !reads.has(value.trim().toUpperCase())
    )
      return true
  }
  return false
}
