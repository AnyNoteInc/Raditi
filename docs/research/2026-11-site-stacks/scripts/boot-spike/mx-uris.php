<?php
define('MODX_API_MODE', true);
require '/var/www/html/index.php';
$modx->initialize('mgr');
$modx->call(MODX\Revolution\modResource::class, 'refreshURIs', [&$modx]);
$modx->cacheManager->refresh();
echo "refreshed\n";
