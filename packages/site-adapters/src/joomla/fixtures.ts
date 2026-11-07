import type { PublicPage } from '@repo/domain'
import { JOOMLA_MANIFEST_URL } from './joomla-version.ts'

// Fixtures of the tests of the Joomla modules (docs/plan/62-slices/e3.md, Э3.2). The manifests are
// the files `administrator/manifests/files/joomla.xml` of the releases, word for word: 3.10.12 and
// 6.2.0 from the packages read for the research (docs/research/2026-11-site-stacks/joomla.md),
// 2.5.28 from the tag `2.5.28` of joomla/joomla-cms. The lists of names are of installed sites;
// the pages are synthetic. Pages that say nothing of a site are `neutralPublicPages` of the contract.

/**
 * The manifest of Joomla 2.5.28: below `refuseBelow`. Text of Joomla under GPL-2.0-or-later, word
 * for word from
 * https://raw.githubusercontent.com/joomla/joomla-cms/2.5.28/administrator/manifests/files/joomla.xml
 * (1 754 bytes, sha256 40adcf7273439e282f342c46f91f0389ab998abbc85de02e023418f19660036d).
 */
export const manifest2528 = `<?xml version="1.0" encoding="UTF-8"?>
<extension version="2.5" type="file" method="upgrade">
	<name>files_joomla</name>
	<author>Joomla! Project</author>
	<authorEmail>admin@joomla.org</authorEmail>
	<authorUrl>www.joomla.org</authorUrl>
	<copyright>(C) 2005 - 2014 Open Source Matters. All rights reserved</copyright>
	<license>GNU General Public License version 2 or later; see LICENSE.txt</license>
	<version>2.5.28</version>
	<creationDate>December 2014</creationDate>
	<description>FILES_JOOMLA_XML_DESCRIPTION</description>

	<scriptfile>administrator/components/com_admin/script.php</scriptfile>

	<update> <!-- Runs on update; New in 1.7 -->
		<schemas>
			<schemapath type="mysql">administrator/components/com_admin/sql/updates/mysql</schemapath>
			<schemapath type="sqlsrv">administrator/components/com_admin/sql/updates/sqlsrv</schemapath>
			<schemapath type="sqlazure">administrator/components/com_admin/sql/updates/sqlazure</schemapath>
		</schemas>
	</update>

	<fileset>
		<files>
			<folder>administrator</folder>
			<folder>cache</folder>
			<folder>cli</folder>
			<folder>components</folder>
			<folder>images</folder>
			<folder>includes</folder>
			<folder>language</folder>
			<folder>libraries</folder>
			<folder>logs</folder>
			<folder>media</folder>
			<folder>modules</folder>
			<folder>plugins</folder>
			<folder>templates</folder>
			<folder>tmp</folder>
			<file>htaccess.txt</file>
			<file>web.config.txt</file>
			<file>LICENSE.txt</file>
			<file>README.txt</file>
			<file>index.php</file>
		</files>
	</fileset>

	<updateservers>
		<server type="collection">http://update.joomla.org/core/list.xml</server>
		<server type="collection">http://update.joomla.org/jed/list.xml</server>
	</updateservers>
</extension>
`

/** The manifest of Joomla 3.10.12. */
export const manifest31012 = `<?xml version="1.0" encoding="UTF-8"?>
<extension version="3.6" type="file" method="upgrade">
	<name>files_joomla</name>
	<author>Joomla! Project</author>
	<authorEmail>admin@joomla.org</authorEmail>
	<authorUrl>www.joomla.org</authorUrl>
	<copyright>(C) 2019 Open Source Matters, Inc.</copyright>
	<license>GNU General Public License version 2 or later; see LICENSE.txt</license>
	<version>3.10.12</version>
	<creationDate>July 2023</creationDate>
	<description>FILES_JOOMLA_XML_DESCRIPTION</description>

	<scriptfile>administrator/components/com_admin/script.php</scriptfile>

	<update>
		<schemas>
			<schemapath type="mysql">administrator/components/com_admin/sql/updates/mysql</schemapath>
			<schemapath type="sqlsrv">administrator/components/com_admin/sql/updates/sqlazure</schemapath>
			<schemapath type="sqlazure">administrator/components/com_admin/sql/updates/sqlazure</schemapath>
			<schemapath type="postgresql">administrator/components/com_admin/sql/updates/postgresql</schemapath>
		</schemas>
	</update>

	<fileset>
		<files>
			<folder>administrator</folder>
			<folder>bin</folder>
			<folder>cache</folder>
			<folder>cli</folder>
			<folder>components</folder>
			<folder>images</folder>
			<folder>includes</folder>
			<folder>language</folder>
			<folder>layouts</folder>
			<folder>libraries</folder>
			<folder>media</folder>
			<folder>modules</folder>
			<folder>plugins</folder>
			<folder>templates</folder>
			<folder>tmp</folder>
			<file>htaccess.txt</file>
			<file>web.config.txt</file>
			<file>LICENSE.txt</file>
			<file>README.txt</file>
			<file>index.php</file>
		</files>
	</fileset>

	<updateservers>
		<server name="Joomla! Core" type="collection">https://update.joomla.org/core/list.xml</server>
	</updateservers>
</extension>
`

/** The manifest of Joomla 6.2.0. */
export const manifest620 = `<?xml version="1.0" encoding="UTF-8"?>
<extension type="file" method="upgrade">
	<name>files_joomla</name>
	<author>Joomla! Project</author>
	<authorEmail>admin@joomla.org</authorEmail>
	<authorUrl>www.joomla.org</authorUrl>
	<copyright>(C) 2019 Open Source Matters, Inc.</copyright>
	<license>GNU General Public License version 2 or later; see LICENSE.txt</license>
	<version>6.2.0</version>
	<creationDate>2026-10</creationDate>
	<description>FILES_JOOMLA_XML_DESCRIPTION</description>

	<scriptfile>administrator/components/com_admin/script.php</scriptfile>

	<update>
		<schemas>
			<schemapath type="mysql">administrator/components/com_admin/sql/updates/mysql</schemapath>
			<schemapath type="postgresql">administrator/components/com_admin/sql/updates/postgresql</schemapath>
		</schemas>
	</update>

	<fileset>
		<files>
			<folder>administrator</folder>
			<folder>api</folder>
			<folder>cache</folder>
			<folder>cli</folder>
			<folder>components</folder>
			<folder>images</folder>
			<folder>includes</folder>
			<folder>language</folder>
			<folder>layouts</folder>
			<folder>libraries</folder>
			<folder>media</folder>
			<folder>modules</folder>
			<folder>plugins</folder>
			<folder>templates</folder>
			<folder>tmp</folder>
			<file>htaccess.txt</file>
			<file>web.config.txt</file>
			<file>LICENSE.txt</file>
			<file>README.txt</file>
			<file>index.php</file>
		</files>
	</fileset>

	<updateservers>
		<server name="Joomla! Core" type="collection">https://update.joomla.org/core/list.xml</server>
	</updateservers>
</extension>
`

/** The root of an installed Joomla 3.10. */
export const root310Names: readonly string[] = [
  '.htaccess',
  'administrator',
  'bin',
  'cache',
  'cli',
  'components',
  'configuration.php',
  'htaccess.txt',
  'images',
  'includes',
  'index.php',
  'language',
  'layouts',
  'libraries',
  'LICENSE.txt',
  'media',
  'modules',
  'plugins',
  'README.txt',
  'robots.txt',
  'templates',
  'tmp',
  'web.config.txt',
]

/** The root of an installed Joomla 6.2. */
export const root620Names: readonly string[] = [
  '.htaccess',
  'administrator',
  'api',
  'cache',
  'cli',
  'components',
  'configuration.php',
  'files',
  'htaccess.txt',
  'images',
  'includes',
  'index.php',
  'language',
  'layouts',
  'libraries',
  'LICENSE.txt',
  'media',
  'modules',
  'plugins',
  'README.txt',
  'robots.txt',
  'templates',
  'tmp',
  'web.config.txt',
]

/** The folder `administrator/` of an installed Joomla 3.10. */
export const administratorNames: readonly string[] = [
  'cache',
  'components',
  'help',
  'includes',
  'index.php',
  'language',
  'logs',
  'manifests',
  'modules',
  'templates',
]

/**
 * The public folder of Joomla 5.0+ (`PublicFolderGeneratorHelper` of 5.4.10): `libraries` and
 * `plugins` stay above it, `media` is a link, `images` and `files` are the local folders.
 */
export const publicFolderNames: readonly string[] = [
  '.htaccess',
  'administrator',
  'api',
  'defines.php',
  'files',
  'images',
  'index.php',
  'media',
  'robots.txt',
]

const home = (head: string, body: string): PublicPage => ({
  path: '/',
  html: [
    '<!doctype html><html lang="ru"><head><meta charset="utf-8">',
    head,
    '<title>Мастерская «Пример»</title></head><body>',
    body,
    '</body></html>',
  ].join('\n'),
})

/** The manifest as the site gives it below the origin. */
export const manifestPage = (text: string): PublicPage => ({
  path: JOOMLA_MANIFEST_URL,
  html: text,
})

/** The home page of Joomla 3 with its tag `generator` and the assets `/media/jui/`. */
export const joomla3Home = home(
  '<meta name="generator" content="Joomla! - Open Source Content Management" />\n' +
    '<script src="/media/jui/js/jquery.min.js?5c1a6e"></script>',
  '<h1>Мастерская</h1>',
)

/** A home page of Joomla with the tag `generator` only. */
export const joomlaGeneratorHome = home(
  '<meta name="generator" content="Joomla! - Open Source Content Management">',
  '<h1>Мастерская</h1>',
)

/** A home page of Joomla 3 without the tag: only the assets `/media/jui/`. */
export const juiHome = home(
  '<link href="/media/jui/css/bootstrap.min.css" rel="stylesheet">',
  '<h1>Мастерская</h1>',
)

/** A home page of Joomla 4+ without the tag: the assets `/media/vendor/` beside `/media/system/`. */
export const vendorHome = home(
  '<script src="/media/vendor/bootstrap/js/bootstrap.min.js"></script>\n' +
    '<script src="/media/system/js/core.min.js"></script>',
  '<h1>Мастерская</h1>',
)

/** `/media/jui/` of Joomla next to the tag of WordPress: the own sign wins. */
export const juiWithWordpressGeneratorHome = home(
  '<meta name="generator" content="WordPress 6.8.3">\n' +
    '<link href="/media/jui/css/bootstrap.min.css" rel="stylesheet">',
  '<h1>Мастерская</h1>',
)

/** A working WordPress: its tag `generator`. */
export const wordpressGeneratorHome = home(
  '<meta name="generator" content="WordPress 6.8.3" />',
  '<h1>Мастерская</h1>',
)

/** A working Drupal: its tag `generator`. */
export const drupalGeneratorHome = home(
  '<meta name="Generator" content="Drupal 10 (https://www.drupal.org)" />',
  '<h1>Мастерская</h1>',
)

/** What an old site on 1С-Битрикс left: links to `/bitrix/` in `src` and `href`. */
export const bitrixRemainsHome = home(
  '<link href="/bitrix/templates/main/styles.css" rel="stylesheet">',
  '<img src="/bitrix/images/logo.png" alt="Логотип"><a href="/bitrix/catalog/">Каталог</a>',
)

/** What an old site on WordPress left: links to `/wp-content/` in `src` and `href`. */
export const wordpressRemainsHome = home(
  '<link href="/wp-content/themes/old/style.css" rel="stylesheet">',
  '<img src="/wp-content/uploads/2019/05/logo.png" alt="Логотип">' +
    '<a href="/wp-content/uploads/price.pdf">Прайс</a>',
)

/** A page with nothing on it. */
export const emptyHome: PublicPage = { path: '/', html: '' }

// Paths of real installations for the rules of the import (docs/plan/62-slices/e3.md, Э3.3): files
// of the core of 3.10.12 and 6.2.0 whose names a mask of the configuration would catch in another
// letter case, folders of the same names deeper down, and what hostings and extensions leave.

/** The import takes them: the core, and the media of the client. */
export const importTakenPaths: readonly string[] = [
  'libraries/vendor/joomla/application/src/ConfigurationAwareApplicationInterface.php',
  'libraries/vendor/lcobucci/jwt/src/Configuration.php',
  'administrator/components/com_admin/src/Service/HTML/Configuration.php',
  'includes/defines.php',
  'administrator/includes/defines.php',
  'api/includes/defines.php',
  'libraries/src/Cache/Cache.php',
  'media/cache/x',
  'administrator/components/com_scheduler/tmpl/logs/default.php',
  'images/a.png',
  'images/price.pdf',
  // Classes of extensions: PSR-4 `Configuration.php` and a model of 3.x.
  'plugins/system/s3media/vendor/aws/aws-sdk-php/src/Retry/Configuration.php',
  'components/com_foo/src/Service/Configuration.php',
  'components/com_foo/models/configuration.php',
  'templates/x/vendor/league/config/src/Configuration.php',
]

/** The import leaves them out: the configuration and its copies, caches, logs, backups, orders. */
export const importExcludedPaths: readonly string[] = [
  'configuration.php',
  'configuration.php.bak',
  'old/configuration.php',
  'old/configuration.php.save',
  'configuration_old.php',
  'old/configuration_old.php',
  'defines.php',
  'installation/index.php',
  'cache/page/x',
  'administrator/logs/error.php',
  'tmp/x',
  'backup.jps',
  'backup.j01',
  'backup.j10',
  'site/backup.j99',
  'components/com_jshopping/files/pdf_orders/1.pdf',
]

/** A document outside the folders of the media: a file of an extension's visitors. */
export const importDocumentPaths: readonly string[] = ['components/com_x/files/order.pdf']

// `configuration.php` of an installed site in the two forms Joomla writes (Э3.3): every value a
// string in 3.x (Registry 1, `public $sef = '1';`), typed values since Registry 2.0
// (`public $sef = true;`, `pkg-6.2.0:libraries/vendor/joomla/registry/src/Format/Php.php`). The
// properties and their order are those of the installers of 3.10.12
// (`installation/configuration.php-dist`) and 6.2.0 (`installation/src/Model/ConfigurationModel.php`);
// the values are synthetic: no password here is anyone's.

/** The secrets of `configuration31012`, in the order of the file. */
export const secrets31012 = [
  'synthetic-db-password-310',
  'synthetic-secret-310',
  'synthetic-ftp-password',
  'synthetic-smtp-password',
  'synthetic-redis-password',
  'synthetic-proxy-password',
  'synthetic-session-redis-password',
]

/** The form of 3.10: strings, comments of the dist file on the right of some values. */
export const configuration31012 = `<?php
class JConfig {
	public $offline = '0';
	public $offline_message = 'This site is down for maintenance.<br /> Please check back again soon.';
	public $display_offline_message = '1';
	public $offline_image = '';
	public $sitename = 'Мастерская «Пример»';
	public $editor = 'tinymce';
	public $captcha = '0';
	public $list_limit = '20';
	public $access = '1';
	public $debug = '0';
	public $debug_lang = '0';
	public $debug_lang_const = '1';
	public $dbtype = 'mysqli';               // Normally mysqli
	public $host = 'localhost';
	public $user = 'synthetic_user';
	public $password = 'synthetic-db-password-310';
	public $db = 'synthetic_db';
	public $dbprefix = 'x7k2_';
	public $live_site = '';
	public $secret = 'synthetic-secret-310';
	public $gzip = '0';
	public $error_reporting = 'default';
	public $helpurl = 'https://help.joomla.org/proxy?keyref=Help{major}{minor}:{keyref}&lang={langcode}';
	public $ftp_host = '127.0.0.1';
	public $ftp_port = '21';
	public $ftp_user = 'synthetic_ftp';
	public $ftp_pass = 'synthetic-ftp-password';
	public $ftp_root = '';
	public $ftp_enable = '0';
	public $offset = 'Europe/Moscow';
	public $mailonline = '1';
	public $mailer = 'smtp';
	public $mailfrom = 'site@example.test';
	public $fromname = 'Мастерская';
	public $sendmail = '/usr/sbin/sendmail';
	public $smtpauth = '1';
	public $smtpuser = 'site@example.test';
	public $smtppass = 'synthetic-smtp-password';
	public $smtphost = 'smtp.example.test';
	public $smtpsecure = 'ssl';
	public $smtpport = '465';
	public $caching = '0';
	public $cache_handler = 'file';
	public $cachetime = '15';
	public $cache_platformprefix = '0';
	public $MetaDesc = 'Ремонт обуви и сумок в центре города';
	public $MetaKeys = '';
	public $MetaTitle = '1';
	public $MetaAuthor = '1';
	public $MetaVersion = '0';
	public $robots = '';
	public $sef = '1';
	public $sef_rewrite = '1';
	public $sef_suffix = '0';
	public $unicodeslugs = '0';
	public $feed_limit = '10';
	public $feed_email = 'none';
	public $log_path = '/home/u1/public_html/administrator/logs';
	public $tmp_path = '/home/u1/public_html/tmp';
	public $lifetime = '15';
	public $session_handler = 'database';
	public $shared_session = '0';
	public $memcached_persist = '1';
	public $memcached_compress = '0';
	public $memcached_server_host = 'localhost';
	public $memcached_server_port = '11211';
	public $redis_persist = '1';
	public $redis_server_host = 'localhost';
	public $redis_server_port = '6379';
	public $redis_server_auth = 'synthetic-redis-password';
	public $redis_server_db = '0';
	public $proxy_enable = '0';
	public $proxy_host = '';
	public $proxy_port = '';
	public $proxy_user = '';
	public $proxy_pass = 'synthetic-proxy-password';
	public $massmailoff = '0';
	public $replyto = '';
	public $replytoname = '';
	public $MetaRights = '';
	public $sitename_pagetitles = '2';
	public $force_ssl = '0';
	public $session_memcached_server_host = 'localhost';
	public $session_memcached_server_port = '11211';
	public $session_redis_persist = 1;
	public $session_redis_server_host = 'localhost';
	public $session_redis_server_port = '6379';
	public $session_redis_server_auth = 'synthetic-session-redis-password';
	public $session_redis_server_db = '0';
	public $frontediting = '1';
	public $cookie_domain = '';
	public $cookie_path = '';
	public $asset_id = '1';
}
`

/** The secrets of `configuration620`, in the order of the file. */
export const secrets620 = [
  'synthetic-db-password-620',
  'synthetic-secret-620',
  'synthetic-smtp-password',
  'synthetic-oauth2-secret',
  'synthetic-oauth2-refresh',
]

/** The form of 6.2: typed values, as `Format\\Php` writes them, without a closing tag. */
export const configuration620 = `<?php
class JConfig {
	public $offline = false;
	public $offline_message = 'Сайт закрыт на техническое обслуживание.<br>Пожалуйста, зайдите позже.';
	public $display_offline_message = 1;
	public $offline_image = '';
	public $sitename = 'Мастерская «Пример»';
	public $editor = 'tinymce';
	public $captcha = '0';
	public $list_limit = 20;
	public $access = 1;
	public $frontediting = 1;
	public $debug = false;
	public $debug_lang = false;
	public $debug_lang_const = true;
	public $dbtype = 'pdomysql';
	public $host = 'localhost';
	public $user = 'synthetic_user';
	public $password = 'synthetic-db-password-620';
	public $db = 'synthetic_db';
	public $dbprefix = 'q3w9_';
	public $dbencryption = 0;
	public $dbsslverifyservercert = false;
	public $dbsslkey = '';
	public $dbsslcert = '';
	public $dbsslca = '';
	public $dbsslcipher = '';
	public $force_ssl = 0;
	public $live_site = '';
	public $secret = 'synthetic-secret-620';
	public $gzip = false;
	public $error_reporting = 'default';
	public $helpurl = 'https://help.joomla.org/proxy?keyref=Help{major}{minor}:{keyref}&lang={langcode}';
	public $offset = 'Europe/Moscow';
	public $cors = false;
	public $cors_allow_origin = '*';
	public $cors_allow_methods = '';
	public $cors_allow_headers = 'Content-Type,X-Joomla-Token,Authorization';
	public $mailonline = true;
	public $mailer = 'smtp';
	public $mailfrom = 'site@example.test';
	public $fromname = 'Мастерская';
	public $sendmail = '/usr/sbin/sendmail';
	public $smtpauth = true;
	public $smtpuser = 'site@example.test';
	public $smtppass = 'synthetic-smtp-password';
	public $smtphost = 'smtp.example.test';
	public $smtpsecure = 'ssl';
	public $smtpport = 465;
	public $smtp_oauth2_client_secret = 'synthetic-oauth2-secret';
	public $smtp_oauth2_refresh_token = 'synthetic-oauth2-refresh';
	public $caching = 0;
	public $cache_handler = 'file';
	public $cachetime = 15;
	public $cache_platformprefix = false;
	public $MetaDesc = 'Ремонт обуви и сумок в центре города';
	public $MetaAuthor = true;
	public $MetaVersion = false;
	public $robots = '';
	public $sef = true;
	public $sef_rewrite = false;
	public $sef_suffix = false;
	public $unicodeslugs = false;
	public $feed_limit = 10;
	public $feed_email = 'none';
	public $log_path = '/var/www/html/administrator/logs';
	public $tmp_path = '/var/www/html/tmp';
	public $lifetime = 15;
	public $session_handler = 'database';
	public $shared_session = false;
	public $session_metadata = true;
	public $sitename_pagetitles = 0;
	public $proxy_enable = false;
	public $proxy_host = '';
	public $proxy_port = '';
	public $proxy_user = '';
	public $proxy_pass = '';
}`
