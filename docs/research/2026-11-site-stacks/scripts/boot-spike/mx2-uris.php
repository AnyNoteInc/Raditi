<?php
define('MODX_API_MODE', true);
require '/var/www/html/index.php';
$modx->initialize('mgr');
$modx->call("modResource", 'refreshURIs', [&$modx]);
$modx->cacheManager->refresh();
echo "refreshed\n";
