<?php
/**
 * Plugin Name: Stand: upload limit (pnpm verify:browser-task only)
 * Description: While the switch file exists, the site refuses PDF files above 20 KiB with its own
 * words, as a host with a small upload limit does (scenario I). A synthetic site of a disposable
 * stand; never a real one.
 */
function raditi_stand_upload_limit($file) {
	if (!file_exists('/var/stand/switches/limit-pdf-uploads')) {
		return $file;
	}
	$name = isset($file['name']) ? (string) $file['name'] : '';
	$pdf = (isset($file['type']) && 'application/pdf' === $file['type']) || preg_match('/\.pdf$/i', $name);
	if ($pdf && (int) ($file['size'] ?? 0) > 20 * 1024) {
		$file['error'] = 'Файл больше 20 КБ: этот сайт не принимает такие PDF.';
	}
	return $file;
}
add_filter('wp_handle_upload_prefilter', 'raditi_stand_upload_limit');
add_filter('wp_handle_sideload_prefilter', 'raditi_stand_upload_limit');
