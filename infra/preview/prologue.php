<?php
/**
 * The first thing the generated configuration of a stack does: `require` of this file, which the
 * platform writes next to the settings file on every ensure, outside the tree. No secret here.
 * It answers 503 until the settings are there, marks the page (`ready.header`) and makes the
 * request look like one to the preview's own address. $raditi_preview stays for the configuration,
 * which unsets it.
 */
$raditi_preview = (static function () {
    $raw = @file_get_contents('/run/raditi/preview/settings.json');
    $settings = is_string($raw) ? json_decode($raw, true, 32) : null;
    if (!is_array($settings) || ($settings['v'] ?? null) !== 2
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
if (PHP_SAPI !== 'cli' && !headers_sent()) {
    header('X-Raditi-Preview: 1');
}
$raditi_origin = parse_url($raditi_preview['origin']);
if (is_array($raditi_origin) && isset($raditi_origin['host'])) {
    $_SERVER['HTTP_HOST'] = $raditi_origin['host'] . (isset($raditi_origin['port']) ? ':' . $raditi_origin['port'] : '');
    $_SERVER['SERVER_NAME'] = $raditi_origin['host'];
    // The gateway ends TLS: an https preview is https to the site too, or it redirects in a loop.
    if (($raditi_origin['scheme'] ?? '') === 'https') {
        $_SERVER['HTTPS'] = 'on';
        $_SERVER['SERVER_PORT'] = (string) ($raditi_origin['port'] ?? 443);
    } else {
        unset($_SERVER['HTTPS']);
    }
}
unset($raditi_origin);
