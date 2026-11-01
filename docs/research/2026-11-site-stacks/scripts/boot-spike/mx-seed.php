<?php
// Spike: synthetic content of a MODX 3 site: nested resources, a chunk, a snippet, a template variable.
define('MODX_API_MODE', true);
require '/var/www/html/index.php';
use MODX\Revolution\modResource; use MODX\Revolution\modDocument; use MODX\Revolution\modChunk; use MODX\Revolution\modSnippet; use MODX\Revolution\modTemplate; use MODX\Revolution\modTemplateVar; use MODX\Revolution\modTemplateVarTemplate; use MODX\Revolution\modSystemSetting; use MODX\Revolution\modUser;
$modx->initialize('mgr');
$modx->user = $modx->getObject(modUser::class, ['username' => 'spikeadmin']);
foreach (['friendly_urls' => 1, 'use_alias_path' => 1, 'friendly_alias_realtime' => 1] as $k => $v) {
  $s = $modx->getObject(modSystemSetting::class, $k); if ($s) { $s->set('value', $v); $s->save(); }
}
$chunk = $modx->newObject(modChunk::class); $chunk->fromArray(['name' => 'spikeHeader', 'snippet' => '<header class="spike">Шапка из чанка</header>']); $chunk->save();
$snip = $modx->newObject(modSnippet::class); $snip->fromArray(['name' => 'spikeDate', 'snippet' => '<?php return "Сниппет работает: " . date("Y");']); $snip->save();
$tv = $modx->newObject(modTemplateVar::class); $tv->fromArray(['name' => 'spikeNote', 'caption' => 'Заметка', 'type' => 'text']); $tv->save();
$tpl = $modx->getObject(modTemplate::class, 1);
$tpl->set('content', "<!doctype html><html><head><meta charset=\"utf-8\"><title>[[*pagetitle]] - [[++site_name]]</title><base href=\"[[++site_url]]\"></head><body>[[\$spikeHeader]]<h1>[[*pagetitle]]</h1><div>[[*content]]</div><p>[[!spikeDate]]</p><p>[[*spikeNote]]</p><nav><a href=\"[[~1]]\">Главная</a> <a href=\"[[~2]]\">О компании</a> <a href=\"[[~4]]\">Новость</a></nav></body></html>");
$tpl->save();
$tvt = $modx->newObject(modTemplateVarTemplate::class); $tvt->fromArray(['tmplvarid' => $tv->get('id'), 'templateid' => 1, 'rank' => 0], '', true, true); $tvt->save();
$make = function ($title, $alias, $parent, $folder = 0) use ($modx) {
  $r = $modx->newObject(modDocument::class);
  $r->fromArray(['pagetitle' => $title, 'alias' => $alias, 'parent' => $parent, 'isfolder' => $folder, 'published' => 1, 'template' => 1, 'content' => "<p>Текст страницы: {$title}. Ссылка [[~1]].</p>", 'context_key' => 'web', 'publishedon' => time()]);
  $r->save(); return $r->get('id');
};
$about = $make('О компании', 'o-kompanii', 0);
$news = $make('Новости', 'novosti', 0, 1);
$a = $make('Первая новость', 'pervaya', $news);
$make('Вторая новость', 'vtoraya', $news);
$make('Контакты', 'kontakty', 0);
$doc = $modx->getObject(modResource::class, $a); $doc->setTVValue('spikeNote', 'Значение TV');
$modx->cacheManager->refresh();
echo "ids: about=$about news=$news a=$a\n";
