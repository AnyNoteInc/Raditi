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
      '/wp-admin/post.php?post=42&action=edit',
      '/wp-json/wp/v2/pages/42',
    ])
      expect(denied(path), path).toBe(false)
  })

  it('refuses the admin pages of the policy, whatever the case or the encoding', () => {
    for (const path of [
      '/wp-admin/users.php',
      '/WP-ADMIN/Plugins.php',
      '/wp-admin/%70lugins.php',
      '/wp-admin/options-general.php',
      '/wp-admin/admin.php?page=wc-settings',
      '/wp-admin/network/',
    ])
      expect(denied(path), path).toBe(true)
  })

  it('reads the action of admin-ajax.php in the query, a form and a multipart body', () => {
    expect(denied('/wp-admin/admin-ajax.php?action=install-plugin', 'POST')).toBe(true)
    expect(denied('/wp-admin/admin-ajax.php', 'POST', 'action=delete-plugin&slug=x')).toBe(true)
    const multipart =
      '--b\r\nContent-Disposition: form-data; name="action"\r\n\r\nupdate-theme\r\n--b--\r\n'
    expect(denied('/wp-admin/admin-ajax.php', 'POST', multipart)).toBe(true)
    expect(denied('/wp-admin/admin-ajax.php', 'POST', 'action=heartbeat')).toBe(false)
  })

  it('refuses the REST routes of the policy by path and by rest_route', () => {
    expect(denied('/wp-json/wp/v2/users')).toBe(true)
    expect(denied('/index.php/wp-json/wp/v2/users/1')).toBe(true)
    expect(denied('/?rest_route=/wp/v2/users')).toBe(true)
    expect(denied('/?rest_route=/wp/v2/settings', 'POST')).toBe(true)
    expect(denied('/?rest_route=/wp/v2/posts/42')).toBe(false)
  })

  it('fails closed on anything that is not a path of the site', () => {
    for (const path of [
      '',
      'wp-admin/users.php',
      '//evil.test/',
      'https://evil.test/',
      '/%E0%A4%A',
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
