<?php
/**
 * Plugin Name: Stand: cookie tap (pnpm verify:browser-task only)
 * Description: Writes the values of the sign-in cookies WordPress sets to a file outside the
 * document root, so the stand can look for them where they must never be: the requests to the
 * model, the logs, the events of the task, its objects in S3 (docs/plan/57-browser-tasks.md, Б19).
 * A synthetic site of a disposable stand; never a real one.
 */
foreach (array('set_auth_cookie', 'set_logged_in_cookie') as $raditi_stand_hook) {
	add_action(
		$raditi_stand_hook,
		static function ($cookie) {
			$dir = '/var/stand/cookies';
			if (!is_dir($dir)) {
				@mkdir($dir, 0700, true);
			}
			@file_put_contents($dir . '/values.txt', $cookie . "\n", FILE_APPEND | LOCK_EX);
		},
		10,
		1
	);
}
