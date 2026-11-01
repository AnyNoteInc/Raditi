<?php
// Spike: expiry by the file's own time, drop of a folder named by a constant, not by the request.
define('GAP6_HASH', 'REPLACE_HASH');
define('GAP6_DROP', 'core/cache');
header('Content-Type: application/json');
header('Cache-Control: no-store');
function gap6_out($a) { echo json_encode($a); exit; }
if (time() - filemtime(__FILE__) > 900) { @unlink(__FILE__); header('HTTP/1.1 410 Gone'); exit; }
$t = isset($_SERVER['HTTP_X_RADITI_TOKEN']) ? (string) $_SERVER['HTTP_X_RADITI_TOKEN'] : '';
if (!hash_equals(GAP6_HASH, hash('sha256', $t))) { header('HTTP/1.1 404 Not Found'); exit; }
$root = dirname(__FILE__) . DIRECTORY_SEPARATOR . GAP6_DROP;
$files = 0; $dirs = 0; $inv = 0; $bad = 0;
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
foreach ($it as $e) {
  $p = $e->getPathname();
  if ($e->isLink()) { continue; }
  if ($e->isDir()) { if (@rmdir($p)) { $dirs++; } continue; }
  if (substr($p, -4) === '.php' && function_exists('opcache_invalidate')) { if (@opcache_invalidate($p, true) === true) { $inv++; } else { $bad++; } }
  if (@unlink($p)) { $files++; }
}
gap6_out(array('raditi' => 'probe', 'files' => $files, 'dirs' => $dirs, 'invalidated' => $inv, 'failed' => $bad));
