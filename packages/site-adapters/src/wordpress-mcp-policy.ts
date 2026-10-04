/**
 * Hard limits of the WordPress MCP tools — spec §8, §11, CLAUDE.md rule 4.
 *
 * `wp_cli` and `wp_rest` accept only their own allowlists (P10); this denylist is checked on top
 * of them, so a too-broad allowlist entry still cannot reach users, orders, payment settings,
 * plugins, themes, core or server config. The MCP gateway (P6 process, P10 WordPress tools)
 * enforces it on every call before anything reaches the site:
 * - wp_cli: isWpCliCommandDenied(argv); the gateway runs WP-CLI with an argv, never a shell,
 *   and sets --path, --url and --user itself;
 * - wp_rest: isRestRequestDenied(method, route); only the gateway builds headers, so there is
 *   no X-HTTP-Method-Override;
 * - browser_*: isAdminUrlDenied(url) on navigation and, through request interception, on every
 *   request the page makes (forms, XHR), plus isAdminAjaxActionDenied for admin-ajax.php;
 * - object-level checks need the site: a post ID that turns out to be an order (deniedPostTypes)
 *   is refused by the gateway after it looks the ID up;
 * - the gateway counts objects changed in a turn: above maxChangedObjectsPerTurn every further
 *   change needs request_approval (spec §11, mass edits).
 * Matching is case-insensitive and fails closed: anything that cannot be parsed is denied.
 */

export interface WordpressMcpPolicy {
  readonly wpCli: {
    /** Command groups (the first argument) that never run. */
    readonly deniedCommands: readonly string[]
    /** `group subcommand` pairs that never run; deletions go through wp_delete. */
    readonly deniedSubcommands: readonly string[]
    /** Global parameters that run code, switch the target or the WordPress user. */
    readonly deniedGlobalFlags: readonly string[]
  }
  readonly rest: {
    /** Route prefixes under /wp-json; `*` is one path segment. */
    readonly deniedRoutes: readonly string[]
    readonly deniedMethods: readonly string[]
    /** Query parameters that change what WordPress runs. */
    readonly deniedParams: readonly string[]
  }
  /** Options the agent may neither read nor write; `*` is a wildcard. */
  readonly protectedOptions: readonly string[]
  /** Orders, personal data requests and form entries (spec §11). */
  readonly deniedPostTypes: readonly string[]
  readonly admin: {
    /** Pages under /wp-admin/: `page.php`, `dir/` or `page.php?param=value`; `*` in a value is a wildcard. */
    readonly deniedPages: readonly string[]
    readonly deniedAjaxActions: readonly string[]
  }
  /** Above this, changes in one turn need request_approval (spec §11). */
  readonly maxChangedObjectsPerTurn: number
}

const freezeDeep = <T extends object>(value: T): T => {
  for (const nested of Object.values(value)) {
    if (typeof nested === 'object' && nested !== null) freezeDeep(nested as object)
  }
  return Object.freeze(value)
}

export const wordpressMcpPolicy: WordpressMcpPolicy = freezeDeep({
  wpCli: {
    deniedCommands: [
      // Users, roles and logins.
      'user',
      'role',
      'cap',
      'super-admin',
      'login',
      // Code, plugins, themes and server config: only through git or the dangerous tools.
      'plugin',
      'theme',
      'core',
      'config',
      'package',
      'language',
      'scaffold',
      'i18n',
      'dist-archive',
      'rewrite',
      // Arbitrary PHP and SQL.
      'eval',
      'eval-file',
      'shell',
      'db',
      'server',
      'cli',
      'cron',
      'action-scheduler',
      // WooCommerce: orders, customers, payments.
      'wc',
      // Names, emails and IP addresses of site visitors (spec §11).
      'comment',
      // Mass or site-wide changes.
      'search-replace',
      'import',
      'export',
      'site',
      'network',
      'maintenance-mode',
    ],
    deniedSubcommands: [
      'post delete',
      'term delete',
      'comment delete',
      'menu delete',
      'post generate',
      'term generate',
      'comment generate',
      'media regenerate',
      // Dumps every option value, secrets included.
      'option list',
    ],
    deniedGlobalFlags: ['exec', 'require', 'ssh', 'http', 'path', 'url', 'user'],
  },
  rest: {
    deniedRoutes: [
      '/wp/v2/users',
      '/wp/v2/plugins',
      '/wp/v2/themes',
      '/wp/v2/settings',
      '/wp/v2/block-directory',
      // Comments and form entries carry personal data of site visitors (spec §11).
      '/wp/v2/comments',
      '/wp/v2/feedback',
      // One request that carries many: it would bypass every route below.
      '/batch',
      // Runs any registered ability, plugins' included; abilities get their own tools.
      '/wp-abilities',
      // Fetches arbitrary URLs from the site server.
      '/oembed/1.0/proxy',
      '/wc/*/orders',
      '/wc/*/refunds',
      '/wc/*/customers',
      '/wc/*/payment_gateways',
      '/wc/*/settings',
      '/wc/*/webhooks',
      '/wc/*/system_status',
      '/wc/*/reports',
      '/wc/store',
      '/wc-admin',
      '/wc-analytics',
    ],
    deniedMethods: ['DELETE'],
    // `_embed` makes WordPress run the linked routes itself: comments (`replies`) and users
    // (`author`) of a post would come back in spite of the routes denied above.
    deniedParams: ['_method', '_embed'],
  },
  protectedOptions: [
    'active_plugins',
    'active_sitewide_plugins',
    'recently_activated',
    'uninstall_plugins',
    'auto_update_plugins',
    'auto_update_themes',
    'template',
    'stylesheet',
    'current_theme',
    'siteurl',
    'home',
    'admin_email',
    'new_admin_email',
    'blog_public',
    'users_can_register',
    'default_role',
    '*user_roles',
    'permalink_structure',
    'rewrite_rules',
    'upload_path',
    'upload_url_path',
    'cron',
    'db_version',
    'initial_db_version',
    'mailserver_*',
    'woocommerce_*_settings',
    'woocommerce_gateway_order',
    'woocommerce_currency*',
    'yookassa_*',
    // Credentials that plugins keep in options: never read into an LLM context.
    '*password*',
    '*passwd*',
    '*secret*',
    '*token*',
    '*api_key*',
    '*apikey*',
    '*_key',
    '*_salt',
  ],
  deniedPostTypes: [
    'shop_order',
    'shop_order_refund',
    'shop_order_placehold',
    'shop_subscription',
    'user_request',
    // Form entries: Flamingo (Contact Form 7) and Jetpack.
    'flamingo_inbound',
    'flamingo_contact',
    'feedback',
  ],
  admin: {
    deniedPages: [
      'plugins.php',
      'plugin-install.php',
      'plugin-editor.php',
      'theme-editor.php',
      'themes.php',
      'theme-install.php',
      'users.php',
      'user-new.php',
      'user-edit.php',
      'profile.php',
      'authorize-application.php',
      'options.php',
      'options-general.php',
      'options-writing.php',
      'options-reading.php',
      'options-discussion.php',
      'options-media.php',
      'options-permalink.php',
      'options-privacy.php',
      'update-core.php',
      'update.php',
      'tools.php',
      'import.php',
      'export.php',
      'export-personal-data.php',
      'erase-personal-data.php',
      'network/',
      'user/',
      'admin.php?page=wc-settings',
      'admin.php?page=wc-orders',
      'admin.php?page=wc-admin',
      'admin.php?page=wc-status',
      'admin.php?page=wc-reports',
      'admin.php?page=wc-addons',
      'edit.php?post_type=shop_order',
      'edit.php?post_type=shop_order_refund',
      'edit.php?post_type=shop_subscription',
      'post-new.php?post_type=shop_order',
      'edit-comments.php',
      'comment.php',
      'admin.php?page=flamingo*',
      'admin.php?page=wpforms-entries',
      'edit.php?post_type=flamingo_inbound',
      'edit.php?post_type=flamingo_contact',
      'edit.php?post_type=feedback',
    ],
    deniedAjaxActions: [
      'install-plugin',
      'update-plugin',
      'delete-plugin',
      'install-theme',
      'update-theme',
      'delete-theme',
      'toggle-auto-updates',
      'wp-privacy-export-personal-data',
      'wp-privacy-erase-personal-data',
    ],
  },
  maxChangedObjectsPerTurn: 20,
})

const policy = wordpressMcpPolicy
const lower = (s: string) => s.toLowerCase()

/** `*` matches any run of characters; the whole name must match. */
function wildcard(pattern: string): RegExp {
  const body = pattern
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${body}$`, 'i')
}

const optionMatchers = policy.protectedOptions.map(wildcard)

/** Option names compare case-insensitively, as the options table collation does. */
export function isProtectedOption(name: string): boolean {
  return optionMatchers.some((re) => re.test(name.trim()))
}

/** argv of one WP-CLI call, with or without the leading `wp`. */
export function isWpCliCommandDenied(argv: readonly string[]): boolean {
  const args = argv[0] === 'wp' ? argv.slice(1) : [...argv]
  const positional: string[] = []
  for (const arg of args) {
    if (arg === '--' || arg.includes('\0')) return true
    if (!arg.startsWith('--')) {
      positional.push(lower(arg))
      continue
    }
    const [rawName = '', ...rest] = arg.slice(2).split('=')
    const name = lower(rawName)
    if (policy.wpCli.deniedGlobalFlags.includes(name)) return true
    if (name === 'post_type' || name === 'post-type') {
      const types = rest
        .join('=')
        .split(',')
        .map((t) => lower(t.trim()))
      if (types.some((t) => policy.deniedPostTypes.includes(t))) return true
    }
  }

  const [group, subcommand] = positional
  // No command, or an alias (`@prod`) that may point at another server.
  if (group === undefined || positional.some((p) => p.startsWith('@'))) return true
  if (policy.wpCli.deniedCommands.includes(group)) return true
  if (policy.wpCli.deniedSubcommands.includes(`${group} ${subcommand ?? ''}`)) return true
  return group === 'option' && positional.slice(2).some(isProtectedOption)
}

/** Collapses `//` and `.`, lower-cases; null for `..`, NUL or leftover percent-encoding. */
function normalizeUrlPath(path: string): string[] | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('%') || decoded.includes('\\')) return null
  const segments = lower(decoded)
    .split('/')
    .filter((s) => s !== '' && s !== '.')
  return segments.includes('..') ? null : segments
}

const routeMatchers = policy.rest.deniedRoutes.map((route) => route.split('/').filter(Boolean))

function isRouteDenied(route: string): boolean {
  const segments = normalizeUrlPath(route)
  if (segments === null) return true
  // /index.php/wp-json/… (PATH_INFO) and /wp-json/… both lead to the REST route.
  if (segments[0] === 'index.php') segments.shift()
  if (segments[0] === 'wp-json') segments.shift()
  return routeMatchers.some(
    (pattern) =>
      segments.length >= pattern.length &&
      pattern.every((part, i) => part === '*' || part === segments[i]),
  )
}

/**
 * A request of the wp_rest tool: `route` is relative to /wp-json (a leading /wp-json is
 * accepted) and may carry a query string. `?rest_route=` wins over the path in WordPress, so
 * every such value is checked too.
 */
export function isRestRequestDenied(method: string, route: string): boolean {
  if (policy.rest.deniedMethods.includes(method.trim().toUpperCase())) return true
  const [path = '', query = ''] = route.split('#')[0]!.split(/\?(.*)/s)
  const params = new URLSearchParams(query)
  for (const key of params.keys()) {
    if (policy.rest.deniedParams.includes(lower(key))) return true
  }
  return [path, ...params.getAll('rest_route')].some(isRouteDenied)
}

const adminPages = policy.admin.deniedPages.map((entry) => {
  const [page = '', query = ''] = entry.split('?')
  return {
    page,
    params: [...new URLSearchParams(query)].map(([key, value]) => [key, wildcard(value)] as const),
  }
})

/** A URL the browser tools would open or submit to, absolute or relative to the site. */
export function isAdminUrlDenied(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url, 'https://site.invalid/')
  } catch {
    return true
  }
  const segments = normalizeUrlPath(parsed.pathname)
  if (segments === null) return true
  const adminIndex = segments.indexOf('wp-admin')
  if (adminIndex === -1) return false
  const rest = segments.slice(adminIndex + 1).join('/')

  return adminPages.some(({ page, params }) => {
    const pageMatches = page.endsWith('/')
      ? rest === page.slice(0, -1) || rest.startsWith(page)
      : rest === page
    // PHP keeps the last of repeated parameters: any matching value counts.
    return (
      pageMatches &&
      params.every(([key, value]) =>
        parsed.searchParams.getAll(key).some((v) => value.test(v.trim())),
      )
    )
  })
}

/** An admin-ajax.php `action` the browser page may not send. */
export function isAdminAjaxActionDenied(action: string): boolean {
  return policy.admin.deniedAjaxActions.includes(lower(action.trim()))
}
