<?php
/**
 * Plugin Name: Stand: a page that takes a file (pnpm verify:browser-task only)
 * Description: `/?raditi_stand_file=1` answers a plain page with one file field: the page writes
 * the name of the file it was given and the text the file holds under the field, so the stand
 * sees what reached the page through `web_upload` of a chat without a project (scenario P,
 * docs/plan/61-chats-first.md, 61.25). Nothing is sent to the site. A synthetic site of a
 * disposable stand; never a real one.
 */
add_action(
	'init',
	static function () {
		if (!isset($_GET['raditi_stand_file'])) {
			return;
		}
		header('Content-Type: text/html; charset=utf-8');
		echo '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Файл стенда</title></head><body>';
		echo '<h1>Файл стенда</h1>';
		echo '<label for="file">Файл клиента</label> <input type="file" id="file">';
		echo '<p id="read">Файла нет</p>';
		echo '<script>';
		echo 'document.getElementById("file").addEventListener("change", (event) => {';
		echo '  const file = event.target.files[0];';
		echo '  if (!file) return;';
		echo '  file.text().then((text) => { document.getElementById("read").textContent = "Получен " + file.name + ": " + text.trim(); });';
		echo '});';
		echo '</script></body></html>';
		exit;
	}
);
