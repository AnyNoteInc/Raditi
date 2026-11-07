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
