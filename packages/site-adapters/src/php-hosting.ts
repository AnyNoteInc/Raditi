/**
 * PHP server configuration in the docroot. `auto_prepend_file` and friends run code outside
 * the repository and a typo takes the whole site down, so an agent diff never touches them.
 */
export const phpServerConfigFiles = ['.htaccess', '.user.ini', 'php.ini'] as const

/**
 * Database dumps and archives: full copies of the site with personal data and credentials.
 * Never imported into git or packed into a turn snapshot, at any depth (.gitignore lines).
 */
export const archivesAndDumps = [
  '*.sql',
  '*.sql.gz',
  '*.sql.bz2',
  '*.sql.zst',
  '*.dump',
  '*.zip',
  '*.tar',
  '*.tar.gz',
  '*.tgz',
  '*.tar.bz2',
  '*.7z',
  '*.rar',
  '*.bak',
  // All-in-One WP Migration and Akeeba archives.
  '*.wpress',
  '*.jpa',
] as const

/**
 * Secrets that hostings and developers leave next to the code. The list is a first line only:
 * gitleaks scans every import (P11) and every agent diff (DiffPolicy).
 */
export const secretFiles = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.ssh/',
  '.htpasswd',
  '.git-credentials',
  '.npmrc',
  'auth.json',
  // Credential files of client tools; the editor folders keep deployment passwords.
  '.my.cnf',
  '.pgpass',
  '.netrc',
  'sftp-config.json',
  '.ftpconfig',
  '.vscode/',
  '.idea/',
] as const

/**
 * Exports and file databases: orders, clients and form submissions saved next to the code.
 * Never imported into git, at any depth.
 */
export const dataFiles = [
  '*.csv',
  '*.xls',
  '*.xlsx',
  '*.sqlite',
  '*.sqlite3',
  '*.db',
  '*.mdb',
] as const

/**
 * Web server logs under their usual names on cPanel hostings, which have no extension: they
 * hold visitors' addresses and request data.
 */
export const serverLogs = ['error_log', 'access_log'] as const
