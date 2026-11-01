<?php
// Spike: generated configuration of a preview, no secret in it.
$raditi = (static function () {
    $raw = @file_get_contents('/run/raditi/preview/settings.json');
    $settings = is_string($raw) ? json_decode($raw, true, 32) : null;
    if (!is_array($settings) || !is_array($settings['database'] ?? null)) {
        if (PHP_SAPI !== 'cli' && !headers_sent()) { http_response_code(503); }
        echo "Предпросмотр ещё не готов.\n";
        exit(1);
    }
    return $settings;
})();
define('APPLICATION', 'Catalog');
define('HTTP_SERVER', $raditi['origin'] . '/');
define('DIR_OPENCART', '/var/www/html/');
define('DIR_APPLICATION', DIR_OPENCART . 'catalog/');
define('DIR_SYSTEM', DIR_OPENCART . 'system/');
define('DIR_EXTENSION', DIR_OPENCART . 'extension/');
define('DIR_IMAGE', DIR_OPENCART . 'image/');
define('DIR_STORAGE', DIR_SYSTEM . 'storage/');
define('DIR_LANGUAGE', DIR_APPLICATION . 'language/');
define('DIR_TEMPLATE', DIR_APPLICATION . 'view/template/');
define('DIR_CONFIG', DIR_SYSTEM . 'config/');
define('DIR_CACHE', DIR_STORAGE . 'cache/');
define('DIR_DOWNLOAD', DIR_STORAGE . 'download/');
define('DIR_LOGS', DIR_STORAGE . 'logs/');
define('DIR_SESSION', DIR_STORAGE . 'session/');
define('DIR_UPLOAD', DIR_STORAGE . 'upload/');
define('DB_DRIVER', 'mysqli');
define('DB_HOSTNAME', $raditi['database']['host']);
define('DB_USERNAME', $raditi['database']['user']);
define('DB_PASSWORD', $raditi['database']['password']);
define('DB_DATABASE', $raditi['database']['name']);
define('DB_PREFIX', (string) ($raditi['settings']['TABLE_PREFIX'] ?? 'oc_'));
define('DB_PORT', (string) $raditi['database']['port']);
define('CACHE_ENGINE', 'file');
