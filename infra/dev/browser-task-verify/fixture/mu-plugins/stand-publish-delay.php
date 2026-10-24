<?php
/**
 * Plugin Name: Stand: slow publish (pnpm verify:browser-task only)
 * Description: While the switch file exists, the next publish of a post through the REST API is
 * held 30 seconds before WordPress does it, once — longer than the agent waits for it
 * (scenario J). A synthetic site of a disposable stand; never a real one.
 */
add_filter(
	'rest_request_before_callbacks',
	static function ($response, $handler, $request) {
		$switch = '/var/stand/switches/delay-next-publish';
		if (!file_exists($switch)) {
			return $response;
		}
		if (!in_array($request->get_method(), array('POST', 'PUT', 'PATCH'), true)) {
			return $response;
		}
		if (!preg_match('#^/wp/v2/posts/\d+$#', (string) $request->get_route())) {
			return $response;
		}
		if ('publish' !== $request->get_param('status')) {
			return $response;
		}
		if (!@unlink($switch)) {
			return $response;
		}
		sleep(30);
		return $response;
	},
	10,
	3
);
