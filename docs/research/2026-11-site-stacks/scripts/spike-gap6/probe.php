<?php
// Spike of a one-attempt probe: PHP 5.2 syntax on purpose; token hash and expiry are constants.
define('GAP6_HASH', 'REPLACE_HASH');
define('GAP6_UNTIL', REPLACE_UNTIL);
header('Content-Type: application/json');
header('Cache-Control: no-store');
function gap6_out($a) { echo json_encode($a); exit; }
if (time() > GAP6_UNTIL) { header('HTTP/1.1 410 Gone'); gap6_out(array('raditi' => 'probe', 'expired' => true)); }
$t = isset($_SERVER['HTTP_X_RADITI_TOKEN']) ? (string) $_SERVER['HTTP_X_RADITI_TOKEN'] : '';
$h = hash('sha256', $t);
$same = function_exists('hash_equals') ? hash_equals(GAP6_HASH, $h) : ($h === GAP6_HASH);
if (!$same) { header('HTTP/1.1 404 Not Found'); exit; }
$on = extension_loaded('Zend OPcache') && filter_var(ini_get('opcache.enable'), FILTER_VALIDATE_BOOLEAN);
$out = array('raditi' => 'probe', 'v' => 1, 'php' => PHP_VERSION, 'sapi' => PHP_SAPI,
  'opcache' => $on, 'validate' => ini_get('opcache.validate_timestamps'),
  'freq' => ini_get('opcache.revalidate_freq'), 'restrict' => ini_get('opcache.restrict_api'),
  'protect' => ini_get('opcache.file_update_protection'),
  'dir' => dirname(__FILE__), 'root' => isset($_SERVER['DOCUMENT_ROOT']) ? $_SERVER['DOCUMENT_ROOT'] : '');
$body = json_decode(file_get_contents('php://input'), true);
if (is_array($body) && isset($body['invalidate']) && $on) {
  $done = 0; $failed = 0;
  foreach ($body['invalidate'] as $p) {
    $full = realpath(dirname(__FILE__) . DIRECTORY_SEPARATOR . $p);
    if ($full === false || strpos($full, dirname(__FILE__) . DIRECTORY_SEPARATOR) !== 0) { continue; }
    if (@opcache_invalidate($full, true) === true) { $done++; } else { $failed++; }
  }
  $out['invalidated'] = $done; $out['failed'] = $failed;
}
gap6_out($out);
