import { describe, expect, it } from 'vitest'

import { bitrixAdapter } from './bitrix.ts'
import { wordpressAdapter } from './wordpress.ts'

const denied = (path: string, method = 'GET', postData: string | null = null) =>
  wordpressAdapter.browserRequestDenied({ path, method, postData })

describe('wordpressAdapter.browserRequestDenied', () => {
  it('lets the public pages, assets and the editor of content through', () => {
    for (const path of [
      '/',
      '/about/',
      '/?p=42',
      '/wp-content/themes/twentytwentyfive/style.css',
      '/wp-admin/users.php',
      '/WP-ADMIN/Plugins.php',
      '/wp-admin/%70lugins.php',
      '/wp-admin/admin.php?page=wc-settings',
      '/wp-admin/post.php?post=42&action=edit',
      '/wp-json/wp/v2/pages/42',
    ])
      expect(denied(path), path).toBe(false)
  })

  it('opens the admin, REST API and media library of the preview', () => {
    for (const path of [
      '/wp-admin/edit-comments.php',
      '/wp-admin/options-general.php',
      '/wp-admin/network/',
      '/wp-json/wp/v2/media',
      '/index.php/wp-json/wp/v2/comments',
      '/?rest_route=/wp/v2/media/12',
      '/wp-content/uploads/2024/05/resume.pdf',
      '/wp-content/uploads/2024/05/backup.zip',
    ])
      expect(denied(path), path).toBe(false)
    expect(
      denied('/wp-admin/admin-ajax.php', 'POST', 'action=wp-privacy-export-personal-data'),
    ).toBe(false)
    expect(denied('/wp-json/wc-admin/options', 'POST', '{"a":1}')).toBe(false)
  })

  it('fails closed on anything that is not a path of the site', () => {
    for (const path of [
      '',
      'wp-admin/users.php',
      '//evil.test/',
      'https://evil.test/',
      '/%E0%A4%A',
      '/wp-content/uploads/..%2fprivate',
      '/?rest_route=%25zz',
    ])
      expect(denied(path), path).toBe(true)
  })
})

describe('bitrixAdapter.browserRequestDenied', () => {
  it('opens nothing before stage 3', () => {
    expect(bitrixAdapter.browserRequestDenied({ path: '/', method: 'GET', postData: null })).toBe(
      true,
    )
  })
})
