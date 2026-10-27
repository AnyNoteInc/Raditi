<?php
/**
 * wp-config.php of a Raditi preview (docs/plan/53-chat-preview-release.md, Р13–Р15; docs/plan/58).
 * The same file for every preview, with no secret in it: what differs per preview — its address,
 * the address of production, the database of its container, the client's variables — comes from
 * the settings file the platform writes on a tmpfs. The platform writes this file
 * over every tree it writes; the site's own wp-config.php never reaches a preview.
 */

$raditi_preview = (static function () {
    $raw = @file_get_contents('/run/raditi/preview/settings.json');
    $settings = is_string($raw) ? json_decode($raw, true, 32) : null;
    if (!is_array($settings) || ($settings['v'] ?? null) !== 2 || !is_array($settings['database'] ?? null)
        || !is_string($settings['origin'] ?? null) || !is_string($settings['productionOrigin'] ?? null)) {
        if (PHP_SAPI !== 'cli' && !headers_sent()) {
            http_response_code(503);
            header('Content-Type: text/plain; charset=utf-8');
            header('Retry-After: 5');
        }
        echo "Предпросмотр ещё не готов. Обновите страницу через несколько секунд.\n";
        exit(1);
    }
    return $settings;
})();

// The database of the preview's own container, on its loopback (docs/plan/58).
$raditi_database = $raditi_preview['database'];
define('DB_NAME', (string) $raditi_database['name']);
define('DB_USER', (string) $raditi_database['user']);
define('DB_PASSWORD', (string) $raditi_database['password']);
define('DB_HOST', (string) $raditi_database['host'] . ':' . (int) $raditi_database['port']);

// Read from the production configuration (SiteAdapter.databaseSettings): the seed is in that
// connection's encoding and its tables carry that prefix.
$raditi_settings = is_array($raditi_preview['settings'] ?? null) ? $raditi_preview['settings'] : array();
define('DB_CHARSET', (string) ($raditi_settings['DB_CHARSET'] ?? 'utf8mb4'));
define('DB_COLLATE', (string) ($raditi_settings['DB_COLLATE'] ?? ''));
$table_prefix = (string) ($raditi_settings['TABLE_PREFIX'] ?? 'wp_');

// Keys and salts of this preview: derived from its database password, which only this preview
// and the runtime know, so a rebuild with the same database keeps the sessions.
foreach (array('AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY',
    'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT') as $raditi_name) {
    define($raditi_name, hash_hmac('sha256', 'raditi-preview:' . $raditi_name, (string) $raditi_database['password']));
}

// The preview answers as itself; its database keeps the production address, and the mu-plugin
// raditi-preview.php puts the preview's in its place when a page is sent.
define('WP_HOME', $raditi_preview['origin']);
define('WP_SITEURL', $raditi_preview['origin']);
define('RADITI_PREVIEW_ORIGIN', $raditi_preview['origin']);
define('RADITI_PREVIEW_PRODUCTION_ORIGIN', $raditi_preview['productionOrigin']);
$raditi_origin = parse_url($raditi_preview['origin']);
if (is_array($raditi_origin) && isset($raditi_origin['host'])) {
    $_SERVER['HTTP_HOST'] = $raditi_origin['host'] . (isset($raditi_origin['port']) ? ':' . $raditi_origin['port'] : '');
    $_SERVER['SERVER_NAME'] = $raditi_origin['host'];
    // The gateway ends TLS: an https preview is https to WordPress too, or it redirects in a loop.
    if (($raditi_origin['scheme'] ?? '') === 'https') {
        $_SERVER['HTTPS'] = 'on';
        $_SERVER['SERVER_PORT'] = (string) ($raditi_origin['port'] ?? 443);
    } else {
        unset($_SERVER['HTTPS']);
    }
}

// Out of the preview: the internet is open (owner's answer of 26.10.2026, docs/plan/58); the
// host, the private networks and the platform are closed by the rules of its bridge.

// A preview is a staging copy: no mail (the mu-plugin), no cron, no updates, no installs, no
// file edits from the admin, no page cache drop-in.
define('WP_ENVIRONMENT_TYPE', 'staging');
define('DISABLE_WP_CRON', true);
define('DISALLOW_FILE_MODS', true);
define('DISALLOW_FILE_EDIT', true);
define('AUTOMATIC_UPDATER_DISABLED', true);
define('WP_AUTO_UPDATE_CORE', false);
define('WP_CACHE', false);
define('WP_DEBUG', false);

if (!defined('ABSPATH')) {
    define('ABSPATH', __DIR__ . '/');
}

// The client's variables (Р13), as the site's code reads them on its hosting: from the
// environment, and as constants of wp-config.php. A name WordPress reads as its own
// configuration — paths of plugins and uploads, multisite, cookies, the users table, SSL, file
// access, cron, debugging, its request flags and constants — stays in the environment only:
// as a constant it would move or switch off the platform's mu-plugins. So does a name already
// defined.
$raditi_reserved = '/^(?:(?:WP|WPMU|DB|RADITI|FS|FTP|FORCE_SSL|ALLOW_UNFILTERED|DISALLOW|DISABLE|AUTOMATIC_UPDATER'
    . '|CUSTOM_USER|COMPRESS|RECOVERY_MODE|DOING|EP|MAGPIE)_|.*COOKIE|.*_IN_(?:BYTES|SECONDS)$'
    . '|(?:ABSPATH|WPINC|SHORTINIT|MULTISITE|SUNRISE|SUBDOMAIN_INSTALL|VHOST|NOBLOGREDIRECT|UPLOADS'
    . '|UPLOADBLOGSDIR|BLOGUPLOADDIR|PLUGINDIR|MUPLUGINDIR|LANGDIR|TEMPLATEPATH|STYLESHEETPATH'
    . '|DOMAIN_CURRENT_SITE|PATH_CURRENT_SITE|SITE_ID_CURRENT_SITE|BLOG_ID_CURRENT_SITE|ALTERNATE_WP_CRON'
    . '|EMPTY_TRASH_DAYS|MEDIA_TRASH|AUTOSAVE_INTERVAL|IMAGE_EDIT_OVERWRITE|CONCATENATE_SCRIPTS|ENFORCE_GZIP'
    . '|SCRIPT_DEBUG|SAVEQUERIES|ERRORLOGFILE|CORE_UPGRADE_SKIP_NEW_BUNDLED|XMLRPC_REQUEST|REST_REQUEST'
    . '|IFRAME_REQUEST|APP_REQUEST|IS_PROFILE_PAGE|OBJECT|OBJECT_K|ARRAY_A|ARRAY_N|EZSQL_VERSION)$)/D';
foreach ((array) ($raditi_preview['env'] ?? array()) as $raditi_name => $raditi_value) {
    if (!is_string($raditi_name) || !is_string($raditi_value) || !preg_match('/^[A-Z][A-Z0-9_]{1,63}$/D', $raditi_name)) {
        continue;
    }
    putenv($raditi_name . '=' . $raditi_value);
    $_ENV[$raditi_name] = $raditi_value;
    if (!defined($raditi_name) && !preg_match($raditi_reserved, $raditi_name)) {
        define($raditi_name, $raditi_value);
    }
}
unset($raditi_preview, $raditi_database, $raditi_settings, $raditi_name, $raditi_origin, $raditi_value,
    $raditi_reserved);

require_once ABSPATH . 'wp-settings.php';
