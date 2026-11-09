import {
  browserAllowedHosts,
  browserCheckpointRefSchema,
  browserFeedObjectOf,
  browserToolNames,
  browserVerifiedObjectSchema,
  isBrowserVerificationPlan,
  type BrowserCheckpointRef,
  type BrowserVerificationReply,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { wordpressAdapter } from './wordpress.ts'

const site = { url: 'https://news.example.ru/' }
const policy = wordpressAdapter.browserTaskPolicy(site)
const denied = (path: string, method = 'GET', postData: string | null = null) =>
  policy.requestDenied({ path, method, postData })

const multipart = (fields: Record<string, string>, file?: { name: string; text: string }) => {
  const parts = Object.entries(fields).map(
    ([name, value]) =>
      `--b0und\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  )
  if (file)
    parts.push(
      `--b0und\r\nContent-Disposition: form-data; name="${file.name}"; filename="note.txt"\r\n` +
        `Content-Type: text/plain\r\n\r\n${file.text}\r\n`,
    )
  return `${parts.join('')}--b0und--\r\n`
}

describe('wordpressAdapter.browserTaskPolicy: start and hosts', () => {
  it('starts at the list of posts below the folder of the site', () => {
    expect(policy.startPath).toBe('/wp-admin/edit.php')
    expect(wordpressAdapter.browserTaskPolicy({ url: 'https://news.example.ru' }).startPath).toBe(
      '/wp-admin/edit.php',
    )
    expect(wordpressAdapter.browserTaskPolicy({ url: 'https://example.ru/blog' }).startPath).toBe(
      '/blog/wp-admin/edit.php',
    )
    expect(wordpressAdapter.browserTaskPolicy({ url: 'not an address' }).startPath).toBe(
      '/wp-admin/edit.php',
    )
    expect(policy.pageDenied(policy.startPath)).toBe(false)
  })

  it.each(['/wp-admin', '/wp-admin/', '/wp-admin/index.php', '/blog/wp-admin/index.php?x=1'])(
    'opens the dashboard %s',
    (path) => {
      expect(policy.pageDenied(path)).toBe(false)
    },
  )

  it('needs no host besides the site, and the allowlist takes it as it is', () => {
    expect(policy.extraHosts).toEqual([])
    expect(browserAllowedHosts(site.url, policy.extraHosts, [])).toEqual([
      'news.example.ru:443',
      'www.news.example.ru:443',
    ])
  })
})

describe('wordpressAdapter.browserTaskPolicy: the sign-in form (Б36)', () => {
  const form = policy.signIn

  it('is WordPress’s own login form, in the site’s folder or at its root', () => {
    expect(form).toMatchObject({
      login: '#loginform #user_login',
      password: '#loginform #user_pass',
      submit: '#loginform #wp-submit',
    })
    for (const path of [
      '/wp-login.php',
      '/wp-login.php?redirect_to=https%3A%2F%2Fnews.example.ru%2Fwp-admin%2Fedit.php&reauth=1',
      '/wp-login.php?action=login',
      '/wp-login.php?loggedout=true',
      '/blog/wp-login.php?action=',
      '/WP-LOGIN.PHP',
    ])
      expect(form?.isSignInPage(path), path).toBe(true)
  })

  it('is never another form of the same page, nor another page', () => {
    for (const path of [
      '/wp-login.php?action=lostpassword',
      '/wp-login.php?action=rp&key=x',
      '/wp-login.php?action=register',
      '/wp-login.php?action=validate_2fa',
      '/wp-admin/edit.php',
      '/wp-login.php.bak',
      '/news/wp-login',
    ])
      expect(form?.isSignInPage(path), path).toBe(false)
  })

  it('lets the form be sent: signing in is no action the task is refused', () => {
    expect(policy.pageDenied('/wp-login.php?redirect_to=%2Fwp-admin%2F&reauth=1')).toBe(false)
    expect(denied('/wp-login.php', 'POST', 'log=admin&pwd=x&wp-submit=Log+In')).toBe(false)
  })
})

describe('wordpressAdapter.browserTaskPolicy: pages', () => {
  it.each([
    '/',
    '/2026/10/novost/',
    '/?p=42',
    '/wp-admin/edit.php',
    '/wp-admin/edit.php?post_type=page',
    '/wp-admin/edit.php?post_type=product',
    '/wp-admin/edit.php?post_status=trash&post_type=post',
    '/wp-admin/post-new.php',
    '/wp-admin/post-new.php?post_type=page',
    '/wp-admin/post.php?post=12&action=edit',
    '/wp-admin/post.php?post=12&action=edit&classic-editor',
    '/wp-admin/upload.php',
    '/wp-admin/upload.php?mode=list&action=-1&action2=-1',
    '/wp-admin/media-new.php',
    '/wp-admin/edit-tags.php?taxonomy=category',
    '/wp-admin/term.php?taxonomy=post_tag&tag_ID=4',
    '/wp-admin/admin.php?page=wpcf7',
    '/wp-admin/revision.php?revision=5',
    '/wp-login.php',
    '/wp-login.php?redirect_to=%2Fwp-admin%2F&reauth=1',
    '/wp-login.php?action=confirm_admin_email',
    '/wp-login.php?action=lostpassword',
    '/wp-content/uploads/2026/10/photo.jpg',
    '/wp-content/uploads/2026/10/photo-1024x768.webp?ver=2',
    '/wp-content/themes/twentytwentyfive/style.css',
    '/blog/wp-admin/post-new.php',
    // Form entries (заявки), leads and subscribers: the client's own data, and their export
    // (the owner's decision of 09.11.2026).
    '/wp-admin/admin.php?page=flamingo',
    '/wp-admin/admin.php?page=wpforms-entries',
    '/wp-admin/edit.php?post_type=feedback',
    '/wp-admin/admin.php?page=gf_entries&id=1',
    '/wp-admin/admin.php?page=formidable-entries',
    '/wp-admin/admin.php?page=e-form-submissions',
    '/wp-admin/edit.php?post_type=nf_sub',
    '/wp-admin/admin.php?page=mailpoet-subscribers',
    '/wp-admin/admin.php?page=cfdb7-list.php&fid=12',
    '/wp-admin/admin.php?page=fluent_forms_all_entries',
    '/wp-admin/admin.php?page=fluent_forms&route=entries&form_id=1',
    '/wp-admin/admin.php?page=forminator-entries',
    '/wp-admin/admin.php?page=evf-entries',
    '/wp-admin/edit.php?post_type=x&page=forminator-entries',
    // Orders, the shop's customers and every export: the client's own data (09.11.2026, ДС7).
    '/wp-admin/admin.php?page=wc-orders',
    '/wp-admin/admin.php?page=wc-orders&action=edit&id=5',
    '/wp-admin/admin.php?page=wc-admin&path=/customers',
    '/wp-admin/edit.php?post_type=shop_order',
    '/wp-admin/admin.php?page=crm-customers',
    '/wp-admin/export.php',
    '/wp-admin/export.php?download=true&content=all',
    '/wp-admin/admin.php?page=some-plugin&action=export_entries',
    '/wp-admin/admin.php?page=pmxe-admin-export&action=wpallexport',
    '/wp-admin/admin.php?page=fluent_forms&route=entries&form_id=3&action=export',
    '/wp-admin/admin.php?page=cfdb7-list.php&fid=12&action=cfdb7_export_csv',
    '/wp-admin/admin.php?page=reports&action=wc_order_export',
    '/wp-admin/admin.php?page=crm&action=export-orders',
    // Users and their access.
    '/wp-admin/users.php',
    '/wp-admin/user-new.php',
    '/wp-admin/user-edit.php?user_id=2',
    '/wp-admin/profile.php',
    '/wp-admin/authorize-application.php?app_name=x',
    // Plugins, themes and the look of the site.
    '/wp-admin/plugins.php',
    '/wp-admin/plugin-install.php?tab=upload',
    '/wp-admin/plugin-editor.php',
    '/wp-admin/themes.php',
    '/wp-admin/theme-install.php',
    '/wp-admin/theme-editor.php',
    '/wp-admin/customize.php',
    '/wp-admin/customize.php?return=%2Fwp-admin%2F',
    '/wp-admin/site-editor.php',
    '/wp-admin/widgets.php',
    '/wp-admin/nav-menus.php',
    '/wp-admin/edit.php?post_type=wp_navigation',
    '/wp-admin/post-new.php?post_type=wp_template',
    // Payments and refunds.
    '/wp-admin/admin.php?page=wc-settings&tab=checkout',
    '/wp-admin/edit.php?post_type=shop_order_refund',
    // A plugin's screen of the site's accounts.
    '/wp-admin/admin.php?page=newsletter_users_index',
    // Spelt otherwise.
    '/WP-ADMIN/Users.php',
    '/wp-admin/%75sers.php',
    '/wp-admin//plugins.php',
    '/wp-admin/x/../plugins.php',
    '/wp-admin/users.php/x',
    '/wp-admin/customize.php/x',
    '/blog/wp-admin/plugins.php',
    '/wp-admin/update.php?action=upload-plugin',
  ])('opens %s', (path) => {
    expect(policy.pageDenied(path)).toBe(false)
    expect(denied(path)).toBe(false)
  })

  it.each([
    // Settings, the core's and a plugin's.
    '/wp-admin/options.php',
    '/wp-admin/options-general.php',
    '/wp-admin/options-general.php?page=some-plugin',
    '/wp-admin/options-writing.php',
    '/wp-admin/options-reading.php',
    '/wp-admin/options-discussion.php',
    '/wp-admin/options-media.php',
    '/wp-admin/options-permalink.php',
    '/wp-admin/options-privacy.php',
    '/wp-admin/options-connectors.php',
    // Tools, updates, Site Health.
    '/wp-admin/tools.php',
    '/wp-admin/import.php',
    '/wp-admin/admin.php?import=wordpress',
    '/wp-admin/export-personal-data.php',
    '/wp-admin/erase-personal-data.php',
    '/wp-admin/site-health.php',
    '/wp-admin/site-health.php?tab=debug',
    '/wp-admin/update-core.php',
    '/wp-admin/upgrade.php',
    '/wp-admin/maint/repair.php',
    // Comments.
    '/wp-admin/edit-comments.php',
    '/wp-admin/comment.php?action=editcomment&c=3',
    // The network admin and multisite.
    '/wp-admin/network/',
    '/wp-admin/network/plugins.php',
    '/wp-admin/user/',
    '/wp-admin/ms-sites.php',
  ])('opens formerly restricted admin pages at %s', (path) => {
    expect(policy.pageDenied(path)).toBe(false)
    expect(denied(path)).toBe(false)
  })

  it.each([
    '/wp-admin/post.php?post=12&action=trash&_wpnonce=abc',
    '/wp-admin/post.php?post=12&action=delete&_wpnonce=abc',
    '/wp-admin/post.php?post=12&action=untrash&_wpnonce=abc',
    '/wp-admin/post.php?post=12&action=Trash',
    '/wp-admin/edit.php?action=trash&post%5B%5D=12',
    '/wp-admin/edit.php?action=-1&action2=delete&post[]=1&post[]=2',
    '/wp-admin/edit.php?post_status=trash&delete_all=Empty+Trash',
    '/wp-admin/edit.php?post_status=trash&delete.all=1',
    '/wp-admin/upload.php?action=delete&media[]=5',
    '/wp-admin/edit-tags.php?action=delete&taxonomy=category&tag_ID=3',
    // Money: a refund by an action of its own.
    '/wp-admin/admin.php?page=wc-orders&action=woocommerce_refund_line_items',
  ])('opens deletion and refunds at %s', (path) => {
    expect(policy.pageDenied(path)).toBe(false)
  })

  it('keeps bulk editing open', () => {
    expect(policy.pageDenied('/wp-admin/edit.php?action=edit&bulk_edit=Update&post[]=1')).toBe(
      false,
    )
  })

  it.each([
    '/xmlrpc.php',
    '/xmlrpc.php/x',
    '/wp-comments-post.php',
    '/wp-trackback.php?p=1',
    '/wp-signup.php',
    '/wp-activate.php?key=x',
    '/wp-login.php?action=register',
  ])('opens the site script %s', (path) => {
    expect(policy.pageDenied(path)).toBe(false)
  })

  it.each([
    '/wp-content/uploads/2024/05/resume.pdf',
    '/wp-content/uploads/2024/05/orders.csv',
    '/wp-content/uploads/2024/05/request.txt',
    '/wp-content/uploads/2024/05/',
    '/WP-CONTENT/Uploads/2024/05/resume.pdf',
    '/blog/wp-content/uploads/forms/entry-1.json',
  ])('opens a document of the media library %s', (path) => {
    expect(policy.pageDenied(path)).toBe(false)
  })

  it.each([
    'wp-admin/users.php',
    '//evil.example/x',
    '',
    'https://other.example/wp-admin/',
    '/wp-admin/%zz',
  ])('closes what is not a path of the site: %s', (path) => {
    expect(policy.pageDenied(path)).toBe(true)
  })
})

describe('wordpressAdapter.browserTaskPolicy: requests', () => {
  it.each([
    ['/wp-json/wp/v2/posts/12?force=true', 'DELETE', null],
    ['/?rest_route=/wp/v2/media/5', 'DELETE', null],
    ['/wp-json/wp/v2/users/2?force=true&reassign=1', 'DELETE', null],
    ['/wp-json/wp/v2/posts/12?_method=DELETE', 'POST', null],
    ['/wp-json/wp/v2/posts/12', 'POST', null],
    ['/wp-json/wp/v2/posts/12', 'POST', '{"status":"trash"}'],
    ['/wp-admin/edit.php?post_status=trash', 'POST', 'delete_all=1'],
  ])('opens deletion at %s for both controllers', (path, method, postData) => {
    expect(policy.requestDenied({ path, method, postData }, 'agent')).toBe(false)
    expect(policy.requestDenied({ path, method, postData }, 'user')).toBe(false)
  })

  it('allows POST overrides but refuses reads disguised as writes', () => {
    expect(denied('/wp-json/wp/v2/comments/12?_method=DELETE', 'POST')).toBe(false)
    expect(denied('/wp-json/wc-admin/options?_method=PATCH', 'POST')).toBe(false)
    expect(denied('/wp-json/wp/v2/posts/12?_method=DELETE', 'GET')).toBe(true)
    expect(denied('/wp-json/wp/v2/posts/12?_method=GET', 'GET')).toBe(false)
  })

  it('lets media be uploaded', () => {
    expect(denied('/wp-json/wp/v2/media', 'POST')).toBe(false)
    expect(denied('/?rest_route=/wp/v2/media', 'POST')).toBe(false)
    expect(denied('/wp-json/wp/v2/media', 'POST', multipart({ post: '12' }))).toBe(false)
    // The text of an uploaded file is no field of the form.
    const file = { name: 'file', text: 'action=delete-post&force=1&status=trash' }
    expect(denied('/wp-json/wp/v2/media', 'POST', multipart({}, file))).toBe(false)
    const upload = multipart(
      { name: 'photo.jpg', action: 'upload-attachment', post_id: '12' },
      file,
    )
    expect(denied('/wp-admin/async-upload.php', 'POST', upload)).toBe(false)
    expect(denied('/wp-admin/media-new.php', 'POST', multipart({ post_id: '0' }, file))).toBe(false)
    expect(denied('/wp-json/wp/v2/media?per_page=40&_locale=user')).toBe(false)
    expect(denied('/wp-json/wp/v2/media/5', 'POST', '{"alt_text":"Новость"}')).toBe(false)
  })

  it('lets a post or a page be written and saved', () => {
    const post = '{"title":"Открытие","content":"<!-- wp:paragraph -->","status":"publish"}'
    expect(denied('/wp-json/wp/v2/posts', 'POST', post)).toBe(false)
    expect(denied('/wp-json/wp/v2/posts/12', 'POST', post)).toBe(false)
    expect(denied('/wp-json/wp/v2/posts/12', 'PUT', post)).toBe(false)
    expect(denied('/wp-json/wp/v2/pages/7?_locale=user', 'POST', '{"status":"draft"}')).toBe(false)
    expect(denied('/wp-json/wp/v2/posts/12/autosaves', 'POST', post)).toBe(false)
    expect(denied('/wp-json/wp/v2/posts/12?context=edit')).toBe(false)
    expect(denied('/wp-json/wp/v2/posts/12', 'OPTIONS')).toBe(false)
    expect(denied('/wp-json/wp/v2/categories?per_page=100', 'GET')).toBe(false)
    expect(denied('/wp-json/wp/v2/tags', 'POST', '{"name":"События"}')).toBe(false)
    expect(denied('/wp-json/wp/v2/types/post?context=edit')).toBe(false)
    expect(denied('/wp-json/wp/v2/templates/lookup?slug=single')).toBe(false)
    expect(denied('/wp-json/wp/v2/global-styles/5?context=edit')).toBe(false)
  })

  it.each([
    ['POST', '/wp-json/wp/v2/users'],
    ['POST', '/wp-json/wp/v2/settings'],
    ['DELETE', '/wp-json/wp/v2/comments/5'],
    ['GET', '/wp-json/wp/v2/posts/5?_embed=replies,author'],
    ['GET', '/wp-json/wp/v2/block-directory/search?term=x'],
    ['POST', '/wp-json/batch/v1'],
    ['POST', '/?rest_route=/wp-abilities/v1/abilities/example/run'],
    ['GET', '/wp-json/oembed/1.0/proxy?url=https://example.com'],
    ['GET', '/wp-json/wp-block-editor/v1/url-details?url=https://example.com'],
    ['GET', '/wp-json/wp-site-health/v1/tests/background-updates'],
    ['POST', '/wp-json/wc-admin/options'],
    ['POST', '/wp-json/wc-analytics/admin/notes/5'],
    ['POST', '/?rest_route=/wc-admin/onboarding/profile'],
    ['POST', '/wp-json/wc/store/v1/checkout'],
    ['POST', '/wp-json/wc/v3/webhooks'],
  ])('opens %s %s', (method, path) => {
    expect(denied(path, method)).toBe(false)
  })

  it('passes plugin payloads and administrative actions through to WordPress', () => {
    expect(denied('/wp-json/plugin/v1/data', 'POST', '[{"value":"one"}]')).toBe(false)
    for (const action of [
      'delete-comment',
      'wp-privacy-export-personal-data',
      'health-check-site-status-result',
      'parse-embed',
      'oembed-cache',
      'inline-save',
      'post-quickdraft-save',
      'woocommerce_refund_line_items',
    ])
      expect(denied('/wp-admin/admin-ajax.php', 'POST', `action=${action}`), action).toBe(false)
  })

  it('lets the Classic Editor save its form and use Quick Draft', () => {
    const classic =
      'action=editpost&originalaction=editpost&post_ID=12&user_ID=1&post_title=Открытие&publish=Publish'
    expect(denied('/wp-admin/post.php', 'POST', classic)).toBe(false)
    expect(denied('/wp-admin/post.php', 'POST', multipart({ action: 'editpost' }))).toBe(false)
    expect(denied('/wp-admin/post.php', 'POST', 'action=post-quickdraft-save&post_title=x')).toBe(
      false,
    )
  })

  it('lets the client sign in register and comment', () => {
    expect(denied('/wp-login.php', 'POST', 'log=owner&pwd=secret&wp-submit=Log+In')).toBe(false)
    expect(denied('/wp-login.php?action=register', 'POST', 'user_login=x')).toBe(false)
    expect(denied('/wp-comments-post.php', 'POST', 'comment=x&comment_post_ID=12')).toBe(false)
  })
})

describe('wordpressAdapter.browserCheckpointOf', () => {
  const ref = (objectId: string, editUrl: string): BrowserCheckpointRef => ({
    kind: 'post',
    objectId,
    editUrl,
  })

  it('finds the post or page of the editor and the address that opens it again', () => {
    const editor = 'https://news.example.ru/wp-admin/post.php?post=12&action=edit'
    expect(wordpressAdapter.browserCheckpointOf(editor)).toEqual(ref('12', editor))
    expect(
      wordpressAdapter.browserCheckpointOf(
        'https://news.example.ru/wp-admin/post.php?post=12&action=edit&classic-editor&message=6#top',
      ),
    ).toEqual(ref('12', editor))
    expect(
      wordpressAdapter.browserCheckpointOf(
        'https://news.example.ru/wp-admin/post.php?action=edit&post=012',
      ),
    ).toEqual(ref('12', editor))
    expect(
      wordpressAdapter.browserCheckpointOf(
        'https://example.ru/blog/wp-admin/post.php?post=5&action=edit',
      ),
    ).toEqual(ref('5', 'https://example.ru/blog/wp-admin/post.php?post=5&action=edit'))
    expect(
      wordpressAdapter.browserCheckpointOf(
        'http://localhost:8080/wp-admin/post%2Ephp?post=3&action=edit',
      ),
    ).toEqual(ref('3', 'http://localhost:8080/wp-admin/post.php?post=3&action=edit'))
  })

  it('takes the last of repeated fields, as PHP does', () => {
    expect(
      wordpressAdapter.browserCheckpointOf(
        'https://news.example.ru/wp-admin/post.php?post=12&post=13&action=edit',
      )?.objectId,
    ).toBe('13')
    expect(
      wordpressAdapter.browserCheckpointOf(
        'https://news.example.ru/wp-admin/post.php?post=12&action=trash&action=edit',
      )?.objectId,
    ).toBe('12')
  })

  it('answers what the domain schema accepts', () => {
    const found = wordpressAdapter.browserCheckpointOf(
      'https://news.example.ru/wp-admin/post.php?post=12&action=edit',
    )
    expect(browserCheckpointRefSchema.safeParse(found).success).toBe(true)
  })

  it.each([
    'https://news.example.ru/wp-admin/post-new.php',
    'https://news.example.ru/wp-admin/post-new.php?post_type=page',
    'https://news.example.ru/wp-admin/post.php?post=12',
    'https://news.example.ru/wp-admin/post.php?post=12&action=Edit',
    'https://news.example.ru/wp-admin/post.php?post=12&action=edit&action=trash',
    'https://news.example.ru/wp-admin/post.php?post=abc&action=edit',
    'https://news.example.ru/wp-admin/post.php?post=0&action=edit',
    'https://news.example.ru/wp-admin/post.php?post=-1&action=edit',
    'https://news.example.ru/wp-admin/post.php?post=12abc&action=edit',
    'https://news.example.ru/wp-admin/post.php?post=12345678901234567890&action=edit',
    'https://news.example.ru/wp-admin/edit.php?post=12&action=edit',
    'https://news.example.ru/wp-admin/post.php/x?post=12&action=edit',
    'https://news.example.ru/wp-admin/sub/post.php?post=12&action=edit',
    'https://news.example.ru/post.php?post=12&action=edit',
    'https://owner:secret@news.example.ru/wp-admin/post.php?post=12&action=edit',
    'ftp://news.example.ru/wp-admin/post.php?post=12&action=edit',
    '/wp-admin/post.php?post=12&action=edit',
    'not an address',
  ])('finds no object at %s', (address) => {
    expect(wordpressAdapter.browserCheckpointOf(address)).toBeNull()
  })
})

describe('wordpressAdapter.browserCommitAction', () => {
  it('only treats a save as a post checkpoint when it comes from the post editor', () => {
    const action = (page: string) =>
      wordpressAdapter.browserCommitAction(
        'button',
        'Save',
        `https://site.example/wp-admin/${page}`,
      )
    expect(action('post.php?post=12&action=edit')).toBe('save')
    expect(action('post-new.php?post_type=page')).toBe('save')
    expect(action('admin.php?page=wc-settings&tab=checkout')).toBeNull()
    expect(action('user-edit.php?user_id=2')).toBeNull()
    expect(action('site-editor.php')).toBeNull()
  })

  it.each([
    ['Publish', 'publish'],
    ['Publish…', 'publish'],
    ['Publish...', 'publish'],
    ['Опубликовать', 'publish'],
    ['Опубликовать…', 'publish'],
    ['Schedule', 'publish'],
    ['Schedule…', 'publish'],
    ['Запланировать…', 'publish'],
    ['Submit for Review', 'publish'],
    ['Отправить на утверждение', 'publish'],
    ['Update', 'save'],
    ['Обновить', 'save'],
    ['Save', 'save'],
    ['Сохранить', 'save'],
    ['Save draft', 'save'],
    ['Save Draft', 'save'],
    [' SAVE  draft ', 'save'],
    ['Сохранить черновик', 'save'],
    ['Save as Pending', 'save'],
    ['Switch to draft', 'save'],
    ['Перевести в черновики', 'save'],
  ] as const)('a button «%s» does %s', (name, action) => {
    expect(wordpressAdapter.browserCommitAction('button', name)).toBe(action)
  })

  it.each([
    ['link', 'Publish'],
    ['menuitem', 'Save'],
    ['textbox', 'Опубликовать'],
    ['button', 'Preview'],
    ['button', 'Просмотр'],
    ['button', 'Move to trash'],
    ['button', 'Переместить в корзину'],
    ['button', 'Cancel'],
    ['button', 'Отмена'],
    ['button', 'Saved'],
    ['button', 'Publishing'],
    ['button', 'Publish: Immediately'],
    ['button', 'Set featured image'],
    ['button', ''],
  ])('a %s «%s» commits nothing', (role, name) => {
    expect(wordpressAdapter.browserCommitAction(role, name)).toBeNull()
  })
})

describe('wordpressAdapter.browserVerification', () => {
  const editUrl = 'https://news.example.ru/wp-admin/post.php?post=12&action=edit'
  const ref: BrowserCheckpointRef = { kind: 'post', objectId: '12', editUrl }
  const plan = wordpressAdapter.browserVerification(ref)

  const object = (overrides: Record<string, unknown> = {}) => ({
    id: 12,
    status: 'publish',
    title: { raw: 'Открытие нового офиса', rendered: 'Открытие нового офиса' },
    link: 'https://news.example.ru/2026/10/otkrytie/',
    featured_media: 31,
    content: { raw: '<!-- wp:paragraph --><p>Текст</p><!-- /wp:paragraph -->', rendered: '' },
    ...overrides,
  })
  const replies = (
    post: Partial<BrowserVerificationReply>,
    page: Partial<BrowserVerificationReply> = { status: 404, body: null },
  ): BrowserVerificationReply[] => [
    { id: 'nonce', status: 200, body: '0123456789' },
    { id: 'post', status: 200, body: null, ...post },
    { id: 'page', status: 404, body: null, ...page },
  ]

  it('reads the nonce, then the post and the page, GET only, through the sign-in of the session', () => {
    expect(isBrowserVerificationPlan(plan)).toBe(true)
    expect(plan.steps).toEqual([
      {
        id: 'nonce',
        method: 'GET',
        path: '/wp-admin/admin-ajax.php?action=rest-nonce',
        readAs: 'text',
      },
      {
        id: 'post',
        method: 'GET',
        path: '/?rest_route=/wp/v2/posts/12&context=edit&_fields=id,status,title,link,featured_media,content',
        headers: { 'X-WP-Nonce': { fromStep: 'nonce' } },
        readAs: 'json',
      },
      {
        id: 'page',
        method: 'GET',
        path: '/?rest_route=/wp/v2/pages/12&context=edit&_fields=id,status,title,link,featured_media,content',
        headers: { 'X-WP-Nonce': { fromStep: 'nonce' } },
        readAs: 'json',
      },
    ])
  })

  it('reads a site in a folder below its own folder', () => {
    const inFolder = wordpressAdapter.browserVerification({
      kind: 'post',
      objectId: '5',
      editUrl: 'https://example.ru/blog/wp-admin/post.php?post=5&action=edit',
    })
    expect(isBrowserVerificationPlan(inFolder)).toBe(true)
    expect(inFolder.steps.map((step) => step.path)).toEqual([
      '/blog/wp-admin/admin-ajax.php?action=rest-nonce',
      '/blog/?rest_route=/wp/v2/posts/5&context=edit&_fields=id,status,title,link,featured_media,content',
      '/blog/?rest_route=/wp/v2/pages/5&context=edit&_fields=id,status,title,link,featured_media,content',
    ])
  })

  it('makes no read of an object WordPress does not number', () => {
    const none = wordpressAdapter.browserVerification({ kind: 'post', objectId: 'abc', editUrl })
    expect(isBrowserVerificationPlan(none)).toBe(false)
    expect(none.read([])).toEqual({ state: 'unreadable' })
  })

  it('finds a published post with its title, address, images, files and featured image', () => {
    const content = [
      '<!-- wp:paragraph --><p>Мы открылись. <a href="https://example.org/map">Карта</a></p><!-- /wp:paragraph -->',
      '<!-- wp:image {"id":31} --><figure class="wp-block-image"><a href="https://news.example.ru/wp-content/uploads/2026/10/office.jpg"><img src="https://news.example.ru/wp-content/uploads/2026/10/office.jpg" alt=""/></a></figure><!-- /wp:image -->',
      '<!-- wp:gallery --><figure class="wp-block-gallery"><!-- wp:image --><figure><IMG src="/wp-content/uploads/a.png"/></figure><!-- /wp:image --></figure><!-- /wp:gallery -->',
      '<!-- wp:file {"id":40,"href":"https://news.example.ru/wp-content/uploads/2026/10/price.pdf"} --><div class="wp-block-file"><a href="https://news.example.ru/wp-content/uploads/2026/10/price.pdf">Прайс</a><a href="https://news.example.ru/wp-content/uploads/2026/10/price.pdf" class="wp-block-file__button" download>Скачать</a></div><!-- /wp:file -->',
      '<p><a href="/wp-content/uploads/2026/10/rules.docx?ver=2">Правила</a></p>',
    ].join('\n')
    const reading = plan.read(replies({ body: object({ content: { raw: content } }) }))
    expect(reading).toEqual({
      state: 'verified',
      object: {
        kind: 'post',
        objectId: '12',
        title: 'Открытие нового офиса',
        status: 'publish',
        url: 'https://news.example.ru/2026/10/otkrytie/',
        editUrl,
        images: 2,
        files: 2,
        featuredImage: true,
      },
    })
    if (reading.state !== 'verified') throw new Error('not verified')
    expect(browserVerifiedObjectSchema.safeParse(reading.object).success).toBe(true)
    expect(browserFeedObjectOf({ ref, state: 'verified', verified: reading.object })).toMatchObject(
      { kind: 'post', status: 'published', url: 'https://news.example.ru/2026/10/otkrytie/' },
    )
  })

  it('counts the images and links of the Classic Editor', () => {
    const content =
      '<p>Текст</p><img class="alignnone" src="/wp-content/uploads/1.jpg"><img src="/wp-content/uploads/2.jpg">' +
      '<a href=\'/wp-content/uploads/2026/10/price.pdf\'>Прайс</a> <a href="/wp-content/uploads/3.jpg">Фото</a>'
    const reading = plan.read(replies({ body: object({ content: { raw: content } }) }))
    expect(reading).toMatchObject({ state: 'verified', object: { images: 2, files: 1 } })
  })

  it.each([
    ['publish', 'publish', true],
    ['private', 'private', true],
    ['draft', 'draft', false],
    ['pending', 'pending', false],
    ['future', 'future', false],
    ['trash', 'trash', false],
    ['auto-draft', 'unknown', false],
    ['archived', 'unknown', false],
  ] as const)('maps the status %s to %s', (status, expected, linked) => {
    const reading = plan.read(replies({ body: object({ status }) }))
    expect(reading).toMatchObject({ state: 'verified', object: { status: expected } })
    if (reading.state !== 'verified') throw new Error('not verified')
    expect(reading.object.url !== undefined).toBe(linked)
  })

  it('finds a page when the number is not a post', () => {
    const reading = plan.read(
      replies(
        { status: 404, body: { code: 'rest_post_invalid_id' } },
        { status: 200, body: object({ status: 'draft', featured_media: 0 }) },
      ),
    )
    expect(reading).toMatchObject({
      state: 'verified',
      object: { objectId: '12', status: 'draft', featuredImage: false },
    })
  })

  it('reports an object neither read finds as missing', () => {
    expect(plan.read(replies({ status: 404, body: { code: 'rest_post_invalid_id' } }))).toEqual({
      state: 'missing',
    })
  })

  it.each([
    ['the session is not signed in', { status: 401 }, undefined],
    ['the account has no rights to it', { status: 403 }, undefined],
    ['the site failed', { status: 500 }, undefined],
    ['the page read is refused', { status: 404 }, { status: 403 }],
    ['the body did not read', { status: 200, body: null }, undefined],
    ['another object answered', { status: 200, body: object({ id: 13 }) }, undefined],
    ['no raw title came', { status: 200, body: object({ title: { rendered: 'x' } }) }, undefined],
    [
      'no raw content came',
      { status: 200, body: object({ content: { rendered: 'x' } }) },
      undefined,
    ],
  ] as const)('reads nothing when %s', (_, post, page) => {
    expect(plan.read(replies(post, page))).toEqual({ state: 'unreadable' })
  })

  it('reads nothing when a reply is missing', () => {
    expect(plan.read([{ id: 'nonce', status: 200, body: 'x' }])).toEqual({ state: 'unreadable' })
    expect(
      plan.read([
        { id: 'nonce', status: 200, body: 'x' },
        { id: 'post', status: 404, body: null },
      ]),
    ).toEqual({ state: 'unreadable' })
  })

  it('cuts a long title without halving a character, and drops an address it cannot trust', () => {
    const long = `${'а'.repeat(999)}😀 и дальше`
    const reading = plan.read(replies({ body: object({ title: { raw: long } }) }))
    expect(reading).toMatchObject({ state: 'verified', object: { title: 'а'.repeat(999) } })
    for (const link of [
      'javascript:alert(1)',
      'https://owner:secret@news.example.ru/x/',
      'https://news.example.ru/a b/',
      'not an address',
      `https://news.example.ru/${'x'.repeat(2100)}`,
    ]) {
      const unsafe = plan.read(replies({ body: object({ link }) }))
      expect(unsafe, link).toMatchObject({ state: 'verified' })
      if (unsafe.state === 'verified') expect(unsafe.object.url, link).toBeUndefined()
    }
  })

  it('takes a type without featured images as having none', () => {
    const body = object()
    delete (body as { featured_media?: number }).featured_media
    expect(plan.read(replies({ body }))).toMatchObject({
      state: 'verified',
      object: { featuredImage: false },
    })
  })
})

describe('wordpressAdapter.browserGuide', () => {
  const guide = wordpressAdapter.browserGuide()

  it('is a Markdown list', () => {
    const lines = guide.trimEnd().split('\n')
    expect(lines.length).toBeGreaterThan(10)
    for (const line of lines) expect(line, line).toMatch(/^(?:- | {2})\S/)
  })

  it('names only tools the agent has, and the rules of the checkpoint and the sign-in', () => {
    const tools = new Set<string>(browserToolNames)
    for (const [name] of guide.matchAll(/\bweb_[a-z]+\b/g)) expect(tools.has(name), name).toBe(true)
    for (const fact of [
      'web_help',
      'web_upload',
      'web_verify',
      '/wp-admin/post-new.php',
      'BROWSER_CHECKPOINT_UNVERIFIED',
      'Submit for Review',
      'Never type or guess a login or',
      'the platform fills the WordPress login form',
      'issue refunds or delete items',
      'never start a second one',
      'web_screenshot',
    ])
      expect(guide).toContain(fact)
  })

  it('names no particular site', () => {
    expect(guide).not.toMatch(/https?:\/\//)
  })
})
