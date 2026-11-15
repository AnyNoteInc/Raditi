import type { SiteBrowserRequest } from '@repo/domain'
import { getSiteAdapter } from '@repo/site-adapters'
import { describe, expect, it } from 'vitest'

import { readOnlyPolicy } from './read-only-policy.ts'

const SITE = 'https://site.example.test/'
const wordpress = getSiteAdapter('wordpress').browserTaskPolicy({ url: SITE })

const ask = (method: string, path: string, postData: string | null = null): SiteBrowserRequest => ({
  method,
  path,
  postData,
})

/** The policy of a session in the state given; the state may be changed after it is made. */
function sessionPolicy(state: { readOnly: boolean; signingIn?: boolean }) {
  return readOnlyPolicy(wordpress, {
    readOnly: () => state.readOnly,
    signingIn: () => state.signingIn ?? false,
  })
}

/** What the pages of WordPress's admin send when the agent saves, deletes or changes something. */
const WRITES = [
  // «Сохранить изменения» of options-general.php: its form posts to options.php.
  ask('POST', '/wp-admin/options.php', 'option_page=general&blogname=Акции&_wpnonce=abc'),
  // Quick Edit «Обновить» or Enter in its title: an XHR of inline-save.
  ask('POST', '/wp-admin/admin-ajax.php', 'action=inline-save&post_ID=12&post_title=Акция'),
  // The block editor's autosave and save, the REST deletion, the method override.
  ask('POST', '/wp-json/wp/v2/posts/12/autosaves', '{"title":"Акция"}'),
  ask('PUT', '/wp-json/wp/v2/posts/12', '{"status":"publish"}'),
  ask('DELETE', '/wp-json/wp/v2/posts/12?force=true'),
  ask('PATCH', '/wp-json/wp/v2/settings'),
  // «Опубликовать» of customize.php, a menu, a widget, a WooCommerce order of HPOS.
  ask('POST', '/wp-admin/customize.php', 'wp_customize=on&customize_changeset_status=publish'),
  ask('POST', '/wp-admin/nav-menus.php?action=update', 'menu=3'),
  ask('POST', '/wp-admin/admin.php?page=wc-orders&action=edit&id=7', 'order_status=wc-completed'),
  ask('POST', '/wp-admin/admin-post.php', 'action=export'),
  // A link with its nonce: deactivate or delete a plugin, trash a post, approve a comment.
  ask('GET', '/wp-admin/plugins.php?action=deactivate&plugin=akismet%2Fakismet.php&_wpnonce=abc'),
  ask('GET', '/wp-admin/plugins.php?action=delete-selected&checked%5B0%5D=hello.php&_wpnonce=abc'),
  ask('GET', '/wp-admin/post.php?post=12&action=trash&_wpnonce=abc'),
  ask('GET', '/wp-admin/comment.php?c=4&action=approvecomment&_wpnonce=abc'),
  // «Применить» of a list: its form sends the chosen action by GET with the nonce of the list.
  ask('GET', '/wp-admin/edit.php?action=trash&post%5B%5D=12&_wpnonce=abc&_wp_http_referer=x'),
  ask('GET', '/wp-admin/admin-ajax.php?action=woocommerce_mark_order_status&_wpnonce=abc'),
  // A GET that runs an action without a nonce: a hook of a plugin (WordPress's own word).
  ask('GET', '/wp-admin/admin-ajax.php?action=wp-remove-post-lock&post_ID=12'),
  ask('GET', '/blog/wp-admin/admin-post.php?action=export_csv'),
  // «Очистить корзину» of a list: its form sends no `action`, only the button.
  ask('GET', '/wp-admin/edit.php?post_status=trash&action=-1&delete_all=1&action2=-1&_wpnonce=abc'),
  ask('GET', '/wp-admin/edit-comments.php?comment_status=spam&delete_all2=1&_wpnonce=abc'),
]

/** What reading the admin sends. */
const READS = [
  ask('GET', '/wp-admin/edit.php'),
  ask('GET', '/wp-admin/edit.php?s=%D0%B0%D0%BA%D1%86%D0%B8%D1%8F&post_status=all&paged=2'),
  ask('GET', '/wp-admin/post.php?post=12&action=edit'),
  ask('GET', '/wp-admin/admin.php?page=flamingo_inbound'),
  ask('GET', '/wp-admin/load-styles.php?c=1&dir=ltr&load%5Bchunk_0%5D=dashicons&ver=7.1'),
  ask('GET', '/wp-json/wp/v2/posts/12?context=edit&_locale=user'),
  ask('HEAD', '/wp-admin/edit.php'),
  ask('OPTIONS', '/wp-json/wp/v2/posts'),
  // A nonce whose value is empty carries nothing to act with.
  ask('GET', '/wp-admin/edit.php?s=a&_wpnonce='),
  // «Фильтр» and the search of a list: its form carries the nonce of its bulk actions, none chosen.
  ask(
    'GET',
    '/wp-admin/edit.php?s=%D0%B0&post_status=all&post_type=post&_wpnonce=abc&_wp_http_referer=%2Fwp-admin%2Fedit.php&action=-1&m=0&cat=0&filter_action=%D0%A4%D0%B8%D0%BB%D1%8C%D1%82%D1%80&paged=1&action2=-1',
  ),
  ask(
    'GET',
    '/wp-admin/upload.php?mode=list&attachment-filter=post_mime_type%3Aimage&action=-1&_wpnonce=abc',
  ),
  ask(
    'GET',
    '/blog/wp-admin/edit-comments.php?comment_status=all&s=&action=-1&action2=-1&_wpnonce=abc',
  ),
]

describe('readOnlyPolicy (docs/plan/82-scheduled-tasks.md, Зп28)', () => {
  it('sends the site only reads while the agent works in a pass without its client', () => {
    const policy = sessionPolicy({ readOnly: true })
    for (const request of WRITES) {
      expect(policy.requestDenied(request), JSON.stringify(request)).toBe(true)
      expect(policy.requestDenied(request, 'agent'), JSON.stringify(request)).toBe(true)
    }
    for (const request of READS)
      expect(policy.requestDenied(request), JSON.stringify(request)).toBe(false)
  })

  it('asks the stack first: its word stands over the generic rule, its silence leaves it', () => {
    const filter = READS.find((request) => request.path.includes('filter_action'))!
    const lock = ask('GET', '/wp-admin/admin-ajax.php?action=wp-remove-post-lock&post_ID=12')
    // A stack that says nothing of its admin: a nonce in a read is an action, a plain GET a read.
    const { readOnlyDenied: _own, ...plain } = wordpress
    const generic = readOnlyPolicy(plain, { readOnly: () => true, signingIn: () => false })
    expect(generic.requestDenied(filter)).toBe(true)
    expect(generic.requestDenied(lock)).toBe(false)
    // A stack whose word is null on everything: the generic rule decides each request.
    const silent = readOnlyPolicy(
      { ...wordpress, readOnlyDenied: () => null },
      { readOnly: () => true, signingIn: () => false },
    )
    expect(silent.requestDenied(filter)).toBe(true)
    expect(silent.requestDenied(WRITES[0]!)).toBe(true)
    expect(silent.requestDenied(READS[0]!)).toBe(false)
  })

  it('limits nothing of an ordinary pass, nor of the client at the controls', () => {
    const state = { readOnly: false }
    const policy = sessionPolicy(state)
    for (const request of [...WRITES, ...READS])
      expect(policy.requestDenied(request), JSON.stringify(request)).toBe(false)
    // The same session once an action of a pass without the client came, and after the next one.
    state.readOnly = true
    expect(policy.requestDenied(WRITES[0]!)).toBe(true)
    // The client took the browser: they are there, and their own controls go to the site.
    for (const request of WRITES) expect(policy.requestDenied(request, 'user')).toBe(false)
    state.readOnly = false
    expect(policy.requestDenied(WRITES[0]!)).toBe(false)
  })

  it('sends the saved sign-in alone, and only while the session sends it (Б36)', () => {
    const state = { readOnly: true, signingIn: false }
    const policy = sessionPolicy(state)
    const form = ask('POST', '/wp-login.php', 'log=admin&pwd=secret&wp-submit=Log+In')
    expect(policy.requestDenied(form)).toBe(true)
    state.signingIn = true
    expect(policy.requestDenied(form)).toBe(false)
    expect(policy.requestDenied(ask('POST', '/blog/wp-login.php?redirect_to=%2F', 'log=a'))).toBe(
      false,
    )
    // Another form of the sign-in page — a reset sends a letter — and any other write meanwhile.
    expect(policy.requestDenied(ask('POST', '/wp-login.php?action=lostpassword', 'u=a'))).toBe(true)
    expect(policy.requestDenied(WRITES[0]!)).toBe(true)
  })

  it('keeps what the stack denies and the rest of its policy', () => {
    const policy = sessionPolicy({ readOnly: false })
    // WordPress's own refusal stands in every pass: a read that asks to run as a write.
    expect(policy.requestDenied(ask('GET', '/wp-json/wp/v2/posts/12?_method=DELETE'))).toBe(true)
    expect(policy.startPath).toBe(wordpress.startPath)
    expect(policy.extraHosts).toBe(wordpress.extraHosts)
    expect(policy.signIn).toBe(wordpress.signIn)
    expect(policy.pageDenied).toBe(wordpress.pageDenied)
    expect(Object.isFrozen(policy)).toBe(true)
    // A policy that cannot read what it is asked denies it (page-rules reads a throw so).
    const broken = readOnlyPolicy(
      {
        ...wordpress,
        signIn: {
          ...wordpress.signIn!,
          isSignInPage: () => {
            throw new Error('unreadable')
          },
        },
      },
      { readOnly: () => true, signingIn: () => true },
    )
    expect(() => broken.requestDenied(ask('POST', '/wp-login.php', 'log=a'))).toThrow()
  })
})
