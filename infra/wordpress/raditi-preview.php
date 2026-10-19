<?php
/**
 * Plugin Name: Raditi preview
 * Description: Written by the platform into every preview of a dialog (docs/plan/53-chat-preview-release.md, Р14, Р15).
 * A preview sends no mail, runs no cron and answers with its own address where the database
 * keeps the production one. HTTP requests to hosts the preview may not reach are refused here
 * as a second line: the network of the preview is the boundary. Inert outside a preview.
 */
if (!defined('ABSPATH')) { exit; }
// The generated wp-config.php of a preview defines these from its settings file.
if (!defined('RADITI_PREVIEW_ORIGIN') || !defined('RADITI_PREVIEW_PRODUCTION_ORIGIN')) { return; }

// No mail leaves a preview. wp_mail() is pluggable and mu-plugins load before every plugin, so
// this definition wins over a mailer plugin's; pre_wp_mail answers for any other definition.
if (!function_exists('wp_mail')) {
    function wp_mail($to, $subject, $message, $headers = '', $attachments = array()) {
        return false;
    }
}
add_filter('pre_wp_mail', 'raditi_preview_no_mail', PHP_INT_MAX);
function raditi_preview_no_mail() {
    return false;
}

// DISABLE_WP_CRON stops the spawn on page loads; a request to wp-cron.php finds no event due.
add_filter('pre_get_ready_cron_jobs', 'raditi_preview_no_cron_jobs', PHP_INT_MAX);
function raditi_preview_no_cron_jobs() {
    return array();
}

// Only the hosts of the client's variables, at their ports (RADITI_PREVIEW_EGRESS, `host:port`).
add_filter('pre_http_request', 'raditi_preview_http_request', PHP_INT_MAX, 3);
function raditi_preview_http_request($preempt, $args, $url) {
    $parts = is_string($url) ? parse_url($url) : false;
    $scheme = is_array($parts) && isset($parts['scheme']) ? strtolower($parts['scheme']) : '';
    $host = is_array($parts) && isset($parts['host']) ? strtolower($parts['host']) : '';
    $port = is_array($parts) && isset($parts['port']) ? (int) $parts['port']
        : ($scheme === 'https' ? 443 : ($scheme === 'http' ? 80 : 0));
    $allowed = defined('RADITI_PREVIEW_EGRESS') ? (array) RADITI_PREVIEW_EGRESS : array();
    if ($host !== '' && in_array($host . ':' . $port, $allowed, true)) { return $preempt; }
    return new WP_Error('raditi_preview_blocked', 'Предпросмотр не обращается к этому адресу.');
}

// A preview is never indexed, never asks to confirm the admin email and never loads a second
// copy of the platform's content plugin installed as an ordinary plugin of the site.
add_filter('wp_robots', 'wp_robots_no_robots', PHP_INT_MAX);
add_filter('admin_email_check_interval', '__return_zero', PHP_INT_MAX);
// The platform signs in to a preview with an application password (Р24). WordPress offers them
// over https or in a `local` environment only; a preview is `staging`, reached over plain http
// on the platform's own network when it is served over http.
add_filter('wp_is_application_passwords_available', '__return_true', PHP_INT_MAX);
add_filter('option_active_plugins', 'raditi_preview_active_plugins', PHP_INT_MAX);
function raditi_preview_active_plugins($plugins) {
    if (!is_array($plugins)) { return $plugins; }
    $kept = array();
    foreach ($plugins as $plugin) {
        if (!is_string($plugin) || basename($plugin) !== 'raditi-content.php') { $kept[] = $plugin; }
    }
    return $kept;
}

/**
 * The hosts whose addresses a preview answers with its own: production as the platform knows
 * it, the `home` and `siteurl` the copied database keeps (raw, past WP_HOME and WP_SITEURL), and
 * the `www.` twin of each — content often links the other spelling of the same site. With a
 * port where the address has one; the longest first, so a host with a port is found before the
 * same host without it.
 */
function raditi_preview_production_hosts() {
    $origins = array(RADITI_PREVIEW_PRODUCTION_ORIGIN);
    $options = function_exists('wp_load_alloptions') ? wp_load_alloptions() : array();
    foreach (array('home', 'siteurl') as $name) {
        if (isset($options[$name]) && is_string($options[$name])) { $origins[] = trim($options[$name]); }
    }
    $preview = strtolower((string) parse_url(RADITI_PREVIEW_ORIGIN, PHP_URL_HOST));
    $hosts = array();
    foreach ($origins as $origin) {
        $parts = parse_url($origin);
        $scheme = is_array($parts) && isset($parts['scheme']) ? strtolower($parts['scheme']) : '';
        $host = is_array($parts) && isset($parts['host']) ? strtolower($parts['host']) : '';
        if (($scheme !== 'http' && $scheme !== 'https')
            || !preg_match('/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/D', $host)) {
            continue;
        }
        $port = isset($parts['port']) ? ':' . (int) $parts['port'] : '';
        $names = array($host);
        $twin = strpos($host, 'www.') === 0 ? substr($host, 4) : 'www.' . $host;
        if (strpos($host, '.') !== false && strpos($twin, '.') !== false) { $names[] = $twin; }
        foreach ($names as $name) {
            if ($name !== $preview) { $hosts[$name . $port] = true; }
        }
    }
    $hosts = array_keys($hosts);
    usort($hosts, static function ($a, $b) { return strlen($b) - strlen($a); });
    return $hosts;
}

/**
 * The production addresses in their spellings (both schemes, protocol-relative, JSON-escaped
 * and URL-encoded) and what stands in their place; a host is matched in any letter case and
 * only as a whole host, never as the start of a longer one.
 */
function raditi_preview_addresses() {
    static $addresses = null;
    if ($addresses !== null) { return $addresses; }
    $addresses = array();
    $preview = parse_url(RADITI_PREVIEW_ORIGIN);
    if (!is_array($preview) || !isset($preview['host'], $preview['scheme'])) {
        return $addresses;
    }
    $authority = $preview['host'] . (isset($preview['port']) ? ':' . $preview['port'] : '');
    $origin = $preview['scheme'] . '://' . $authority;
    $forms = array(
        array('https://', $origin),
        array('http://', $origin),
        array('//', '//' . $authority),
        array('https:\\/\\/', str_replace('/', '\\/', $origin)),
        array('http:\\/\\/', str_replace('/', '\\/', $origin)),
        array('\\/\\/', '\\/\\/' . $authority),
        array('https%3A%2F%2F', rawurlencode($origin)),
        array('http%3A%2F%2F', rawurlencode($origin)),
    );
    foreach (raditi_preview_production_hosts() as $host) {
        foreach ($forms as $form) {
            $addresses[] = array(
                '~' . preg_quote($form[0], '~') . preg_quote($host, '~') . '(?![A-Za-z0-9-]|\.[A-Za-z0-9])~i',
                $form[1],
            );
        }
    }
    return $addresses;
}

function raditi_preview_rewrite($text) {
    // The longest spellings first: `https://host` before the `//host` inside it.
    foreach (raditi_preview_addresses() as $address) {
        $replaced = preg_replace($address[0], $address[1], $text);
        if (is_string($replaced)) { $text = $replaced; }
    }
    return $text;
}

add_filter('wp_redirect', 'raditi_preview_rewrite', PHP_INT_MAX);

// Headers set by header() itself: an address of production in Location, Link or Refresh.
if (PHP_SAPI !== 'cli') {
    header_register_callback('raditi_preview_headers');
}
function raditi_preview_headers() {
    $found = array();
    foreach (headers_list() as $line) {
        $colon = strpos($line, ':');
        if ($colon === false) { continue; }
        $name = strtolower(trim(substr($line, 0, $colon)));
        if (in_array($name, array('location', 'content-location', 'link', 'refresh'), true)) {
            $found[$name][] = array(trim(substr($line, 0, $colon)), ltrim(substr($line, $colon + 1)));
        }
    }
    foreach ($found as $name => $lines) {
        $changed = false;
        foreach ($lines as $index => $header) {
            $value = raditi_preview_rewrite($header[1]);
            $changed = $changed || $value !== $header[1];
            $lines[$index][1] = $value;
        }
        if (!$changed) { continue; }
        header_remove($lines[0][0]);
        foreach ($lines as $header) { header($header[0] . ': ' . $header[1], false); }
    }
}

// What WordPress keeps in its tables — content with production links — is rewritten when a page
// is sent. Never where the text is the record itself: the REST routes of the platform, the
// editing context of the REST API, its writes, the admin screens and WP-CLI, so that nothing
// saved from a preview carries the preview's address.
add_filter('rest_pre_dispatch', 'raditi_preview_rest_request', PHP_INT_MAX, 3);
function raditi_preview_rest_request($result, $server, $request) {
    $route = (string) $request->get_route();
    if (strpos($route, '/raditi/') === 0 || $request->get_param('context') === 'edit'
        || !in_array($request->get_method(), array('GET', 'HEAD'), true)) {
        $GLOBALS['raditi_preview_raw'] = true;
    }
    return $result;
}

function raditi_preview_rewrites_body() {
    if (!empty($GLOBALS['raditi_preview_raw']) || is_admin() || wp_doing_ajax()
        || (defined('XMLRPC_REQUEST') && XMLRPC_REQUEST)) {
        return false;
    }
    $type = 'text/html';
    foreach (headers_list() as $line) {
        if (stripos($line, 'content-encoding:') === 0) { return false; }
        if (stripos($line, 'content-type:') === 0) { $type = strtolower(trim(substr($line, 13))); }
    }
    return (bool) preg_match('~^(?:text/html|application/xhtml\+xml|application/json|text/xml|application/xml|application/[a-z0-9.-]+\+(?:json|xml))(?:;|$)~', $type);
}

// The whole body is held until the end: an address split between two flushes is still found.
// A body that is not rewritten passes through from the first flush on.
function raditi_preview_output($buffer, $phase) {
    static $rewrite = null;
    static $held = '';
    // ob_clean() and ob_end_clean(): what was buffered is dropped, and so is what is held.
    if ($phase & PHP_OUTPUT_HANDLER_CLEAN) {
        $held = '';
        return '';
    }
    if ($rewrite === null) { $rewrite = raditi_preview_rewrites_body(); }
    if (!$rewrite) { return $buffer; }
    $held .= $buffer;
    if (!($phase & PHP_OUTPUT_HANDLER_FINAL)) { return ''; }
    $body = raditi_preview_rewrite($held);
    $held = '';
    if (!headers_sent()) { header_remove('Content-Length'); }
    return $body;
}

if (PHP_SAPI !== 'cli') {
    ob_start('raditi_preview_output');
}
