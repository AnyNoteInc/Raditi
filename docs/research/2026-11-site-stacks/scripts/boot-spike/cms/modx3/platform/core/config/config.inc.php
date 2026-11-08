<?php
/** Spike: the generated configuration of a MODX preview, no secret in it (modx.md §4.5). */
$raditi_raw = @file_get_contents('/run/raditi/preview/settings.json');
$raditi = is_string($raditi_raw) ? json_decode($raditi_raw, true, 32) : null;
if (!is_array($raditi) || !is_array($raditi['database'] ?? null)) {
    if (PHP_SAPI !== 'cli' && !headers_sent()) { http_response_code(503); }
    echo "Предпросмотр ещё не готов.\n";
    exit(1);
}
$raditi_db = $raditi['database'];
$raditi_origin = parse_url($raditi['origin']);
if (PHP_SAPI !== 'cli') {
    $_SERVER['HTTP_HOST'] = $raditi_origin['host'] . (isset($raditi_origin['port']) ? ':' . $raditi_origin['port'] : '');
    $_SERVER['SERVER_NAME'] = $raditi_origin['host'];
    if (!empty($raditi['settings']['FORCE_HTTPS'])) { $_SERVER['HTTPS'] = 'on'; }
}
$database_type = 'mysql';
$database_server = $raditi_db['host'];
$database_connection_charset = (string) ($raditi['settings']['DB_CHARSET'] ?? 'utf8mb4');
$table_prefix = (string) ($raditi['settings']['TABLE_PREFIX'] ?? 'modx_');
$dbase = $raditi_db['name'];
$database_user = $raditi_db['user'];
$database_password = $raditi_db['password'];
$database_dsn = 'mysql:host=' . $raditi_db['host'] . ';port=' . $raditi_db['port'] . ';dbname=' . $raditi_db['name'] . ';charset=' . $database_connection_charset;
$config_options = array();
$driver_options = array();
$lastInstallTime = 1;
$site_id = 'modx' . substr(hash_hmac('sha256', 'site_id', $raditi_db['password']), 0, 22);
$site_sessionname = 'SN' . substr(hash_hmac('sha256', 'sess', $raditi_db['password']), 0, 13);
$https_port = '443';
$uuid = '00000000-0000-4000-8000-000000000000';
if (!defined('MODX_ASSETS_PATH')) { $modx_assets_path = '/var/www/html/assets/'; $modx_assets_url = '/assets/'; define('MODX_ASSETS_PATH', $modx_assets_path); define('MODX_ASSETS_URL', $modx_assets_url); }
if (!defined('MODX_BASE_PATH')) { $modx_base_path = '/var/www/html/'; $modx_base_url = '/'; define('MODX_BASE_PATH', $modx_base_path); define('MODX_BASE_URL', $modx_base_url); }
if (!defined('MODX_CONNECTORS_PATH')) { $modx_connectors_path = '/var/www/html/connectors/'; $modx_connectors_url = '/connectors/'; define('MODX_CONNECTORS_PATH', $modx_connectors_path); define('MODX_CONNECTORS_URL', $modx_connectors_url); }
if (!defined('MODX_CORE_PATH')) { $modx_core_path = '/var/www/html/core/'; define('MODX_CORE_PATH', $modx_core_path); }
if (!defined('MODX_MANAGER_PATH')) { $modx_manager_path = '/var/www/html/manager/'; $modx_manager_url = '/manager/'; define('MODX_MANAGER_PATH', $modx_manager_path); define('MODX_MANAGER_URL', $modx_manager_url); }
if (!defined('MODX_PROCESSORS_PATH')) { $modx_processors_path = '/var/www/html/core/src/Revolution/Processors/'; define('MODX_PROCESSORS_PATH', $modx_processors_path); }
if (!defined('MODX_LOG_LEVEL_FATAL')) { define('MODX_LOG_LEVEL_FATAL', 0); define('MODX_LOG_LEVEL_ERROR', 1); define('MODX_LOG_LEVEL_WARN', 2); define('MODX_LOG_LEVEL_INFO', 3); define('MODX_LOG_LEVEL_DEBUG', 4); }
if (!defined('MODX_CACHE_DISABLED')) { $modx_cache_disabled = false; define('MODX_CACHE_DISABLED', $modx_cache_disabled); }
$raditi_host = $raditi_origin['host'] . (isset($raditi_origin['port']) ? ':' . $raditi_origin['port'] : '');
$http_host = $raditi_host;
$url_scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https://' : 'http://';
$isSecureRequest = $url_scheme === 'https://';
if (!defined('MODX_URL_SCHEME')) { define('MODX_URL_SCHEME', $url_scheme); }
if (!defined('MODX_HTTP_HOST')) { define('MODX_HTTP_HOST', $raditi_host); }
if (!defined('MODX_SITE_URL')) { $site_url = $url_scheme . $raditi_host . '/'; define('MODX_SITE_URL', $site_url); }
