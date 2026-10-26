import { describe, expect, it } from 'vitest'

import { wordpressPublicOriginals } from './wordpress-public-code.ts'

const encoder = new TextEncoder()
const reader = (files: Record<string, string>) => async (path: string) =>
  path in files ? encoder.encode(files[path]) : null

const site = reader({
  'wp-content/plugins/kadence-blocks/kadence-blocks.php':
    "<?php\n/**\n * Plugin Name: Kadence Blocks\n * Version: 3.7.8.2\n */",
  'wp-content/themes/twentytwentyfive/style.css': '/*\nTheme Name: Twenty Twenty-Five\nVersion: 1.4\n*/',
  'wp-includes/version.php': "<?php\n$wp_version = '6.9';\n",
})

describe('wordpressPublicOriginals', () => {
  it('names the published original of a file of a plugin, a theme and the core by their versions', async () => {
    const answers = await wordpressPublicOriginals(
      [
        'wp-content/plugins/kadence-blocks/includes/blocks/class-kadence-blocks-googlemaps-block.php',
        'wp-content/themes/twentytwentyfive/patterns/page-cv-bio.php',
        'wp-includes/js/dist/vendor/react.js',
        'xmlrpc.php',
      ],
      site,
    )
    expect(Object.fromEntries(answers)).toEqual({
      'wp-content/plugins/kadence-blocks/includes/blocks/class-kadence-blocks-googlemaps-block.php':
        'https://plugins.svn.wordpress.org/kadence-blocks/tags/3.7.8.2/includes/blocks/class-kadence-blocks-googlemaps-block.php',
      'wp-content/themes/twentytwentyfive/patterns/page-cv-bio.php':
        'https://themes.svn.wordpress.org/twentytwentyfive/1.4/patterns/page-cv-bio.php',
      'wp-includes/js/dist/vendor/react.js':
        'https://core.svn.wordpress.org/tags/6.9/wp-includes/js/dist/vendor/react.js',
      'xmlrpc.php': 'https://core.svn.wordpress.org/tags/6.9/xmlrpc.php',
    })
  })

  it('gives no answer for files of the site itself, unknown versions and odd names', async () => {
    const answers = await wordpressPublicOriginals(
      [
        'wp-content/uploads/report.php',
        'wp-content/mu-plugins/site.php',
        'wp-content/plugins/own-plugin/secret.php',
        'wp-content/plugins/Bad Slug/a.php',
        'wp-content/plugins/kadence-blocks/../x.php',
        'wp-config.php.bak',
        'notes.txt',
      ],
      site,
    )
    expect(answers.size).toBe(0)
  })

  it('reads each version file once and refuses a version that is not one', async () => {
    const asked: string[] = []
    const files: Record<string, string> = {
      'wp-content/plugins/odd/odd.php': ' * Version: <?php echo $v ?>',
    }
    const answers = await wordpressPublicOriginals(
      ['wp-content/plugins/odd/a.php', 'wp-content/plugins/odd/b.php'],
      async (path) => {
        asked.push(path)
        return path in files ? encoder.encode(files[path]) : null
      },
    )
    expect(answers.size).toBe(0)
    expect(asked).toEqual(['wp-content/plugins/odd/odd.php'])
  })

  it('escapes the segments of a path in the URL', async () => {
    const answers = await wordpressPublicOriginals(
      ['wp-content/plugins/kadence-blocks/languages/файл #1.json'],
      site,
    )
    expect([...answers.values()]).toEqual([
      'https://plugins.svn.wordpress.org/kadence-blocks/tags/3.7.8.2/languages/%D1%84%D0%B0%D0%B9%D0%BB%20%231.json',
    ])
  })
})

describe('wordpressPublicOriginals and the host of an original', () => {
  it('names only the three hosts of WordPress.org, whatever the files of the site hold', async () => {
    const hostile = reader({
      'wp-content/plugins/evil/evil.php': ' * Version: 1.0@attacker.example',
      'wp-content/plugins/kadence-blocks/kadence-blocks.php': ' * Version: 3.7.8.2',
      'wp-content/themes/t/style.css': 'Version: 1.0/../../attacker.example',
      'wp-includes/version.php': "$wp_version = '6.9@x';",
    })
    const answers = await wordpressPublicOriginals(
      [
        'wp-content/plugins/evil/a.php',
        'wp-content/plugins/kadence-blocks/@attacker.example/x.php',
        'wp-content/plugins/kadence-blocks/a/%2F..%2Fx.php',
        'wp-content/plugins/kadence-blocks/a#b?c.php',
        'wp-content/themes/t/a.php',
        'wp-includes/a.php',
      ],
      hostile,
    )
    // Versions that are not versions name nothing; what is named stays on its host.
    expect([...answers.keys()]).toEqual([
      'wp-content/plugins/kadence-blocks/@attacker.example/x.php',
      'wp-content/plugins/kadence-blocks/a/%2F..%2Fx.php',
      'wp-content/plugins/kadence-blocks/a#b?c.php',
    ])
    for (const url of answers.values()) {
      const parsed = new URL(url)
      expect(parsed.protocol).toBe('https:')
      expect(parsed.hostname).toBe('plugins.svn.wordpress.org')
      expect(parsed.search).toBe('')
      expect(parsed.hash).toBe('')
      expect(parsed.username + parsed.password).toBe('')
    }
  })
})
