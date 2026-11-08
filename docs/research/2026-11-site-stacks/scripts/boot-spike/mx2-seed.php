<?php
define('MODX_API_MODE', true);
require '/var/www/html/index.php';
$modx->initialize('mgr');
$modx->getService('error', 'error.modError');
$modx->user = $modx->getObject('modUser', ['username' => 'spikeadmin']);
foreach (['friendly_urls' => 1, 'use_alias_path' => 1] as $k => $v) { $s = $modx->getObject('modSystemSetting', $k); if ($s) { $s->set('value', $v); $s->save(); } }
$chunk = $modx->newObject('modChunk'); $chunk->fromArray(['name' => 'spikeHeader', 'snippet' => '<header>Шапка из чанка</header>']); $chunk->save();
$snip = $modx->newObject('modSnippet'); $snip->fromArray(['name' => 'spikeDate', 'snippet' => '<?php return "Сниппет работает: " . date("Y");']); $snip->save();
$tpl = $modx->getObject('modTemplate', 1);
$tpl->set('content', "<!doctype html><html><head><meta charset=\"utf-8\"><title>[[*pagetitle]] - [[++site_name]]</title><base href=\"[[++site_url]]\"></head><body>[[\$spikeHeader]]<h1>[[*pagetitle]]</h1><div>[[*content]]</div><p>[[!spikeDate]]</p><nav><a href=\"[[~1]]\">Главная</a> <a href=\"[[~2]]\">О компании</a></nav></body></html>");
$tpl->save();
$make = function ($title, $alias, $parent, $folder = 0) use ($modx) { $r = $modx->newObject('modDocument'); $r->fromArray(['pagetitle' => $title, 'alias' => $alias, 'parent' => $parent, 'isfolder' => $folder, 'published' => 1, 'template' => 1, 'content' => "<p>Текст страницы: {$title}.</p>", 'context_key' => 'web', 'publishedon' => time()]); $r->save(); return $r->get('id'); };
$make('О компании', 'o-kompanii', 0); $n = $make('Новости', 'novosti', 0, 1); $make('Первая новость', 'pervaya', $n); $make('Контакты', 'kontakty', 0);
$modx->cacheManager->refresh(); echo "seeded\n";
