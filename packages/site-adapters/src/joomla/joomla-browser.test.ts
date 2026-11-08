import { describe, expect, it } from 'vitest'

import { joomlaBrowserRequestDenied } from './joomla-browser.ts'

const denied = (path: string, method = 'GET', postData: string | null = null) =>
  joomlaBrowserRequestDenied({ path, method, postData })

describe('joomlaBrowserRequestDenied (Т42)', () => {
  it.each([
    '/ADMINISTRATOR/index.php',
    '/administrator/',
    '/%61dministrator/',
    '/api/index.php/v1/content',
    '/installation/index.php',
    '/cli/joomla.php',
    '/includes/defines.php',
    '/libraries/src/Version.php',
    '/cache/page/x.php',
    '/tmp/upload.zip',
    '/configuration.php',
    '/defines.php',
    '/templates/x/Configuration.PHP',
    '/images/price.pdf',
    '/images/',
    '/images/raditi',
    '/files/x.txt',
    '/images/raditi/..%2f..%2fadministrator/',
  ])('refuses %s', (path) => {
    expect(denied(path)).toBe(true)
  })

  it.each([
    '/',
    '/index.php/about',
    '/index.php?option=com_content&view=article&id=1',
    '/images/a.png',
    '/images/raditi/x.pdf',
    '/media/system/js/core.js',
    '/media/templates/site/cassiopeia/css/template.min.css',
    '/templates/x/css/template.css',
  ])('opens %s', (path) => {
    expect(denied(path)).toBe(false)
  })

  it('reads the path only, not the query nor the body of a form', () => {
    expect(denied('/index.php?option=com_users&task=user.login', 'POST', 'password=x')).toBe(false)
    expect(denied('/index.php', 'POST', 'option=com_config&task=config.save')).toBe(false)
  })

  it('fails closed on anything that is not a path of the site', () => {
    for (const path of [
      '',
      'administrator/',
      '//evil.test/',
      'https://evil.test/',
      '/%E0%A4%A',
      // A backslash after the first slash is a second slash to the URL parser: another host.
      '/\\evil.test/x',
      '/\\evil.test/',
    ])
      expect(denied(path), path).toBe(true)
  })
})
