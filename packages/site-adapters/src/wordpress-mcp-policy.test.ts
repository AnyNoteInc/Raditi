import { describe, expect, it } from 'vitest'
import {
  isAdminAjaxActionDenied,
  isAdminUrlDenied,
  isProtectedOption,
  isRestRequestDenied,
  isWpCliCommandDenied,
  wordpressMcpPolicy,
} from './wordpress-mcp-policy.ts'

const wp = (command: string) => command.split(' ')

describe('wordpressMcpPolicy', () => {
  it('covers the areas spec §11 and CLAUDE.md rule 4 keep from the agent', () => {
    expect(wordpressMcpPolicy.wpCli.deniedCommands).toEqual(
      expect.arrayContaining([
        'user',
        'plugin',
        'theme',
        'wc',
        'core',
        'db',
        'config',
        'eval',
        'eval-file',
        'shell',
        'package',
      ]),
    )
    expect(wordpressMcpPolicy.rest.deniedRoutes).toEqual(
      expect.arrayContaining([
        '/wp/v2/users',
        '/wp/v2/plugins',
        '/wp/v2/themes',
        '/wp/v2/settings',
        '/wc/*/orders',
        '/wc/*/customers',
        '/wc/*/payment_gateways',
        '/wc/*/settings',
      ]),
    )
    expect(wordpressMcpPolicy.admin.deniedPages).toEqual(
      expect.arrayContaining([
        'plugins.php',
        'plugin-install.php',
        'themes.php',
        'users.php',
        'user-new.php',
        'profile.php',
        'options-general.php',
        'admin.php?page=wc-settings',
        'admin.php?page=wc-orders',
        'edit.php?post_type=shop_order',
      ]),
    )
    expect(wordpressMcpPolicy.maxChangedObjectsPerTurn).toBe(20)
  })

  it('cannot be changed at runtime', () => {
    expect(Object.isFrozen(wordpressMcpPolicy)).toBe(true)
    expect(Object.isFrozen(wordpressMcpPolicy.wpCli.deniedCommands)).toBe(true)
    expect(Object.isFrozen(wordpressMcpPolicy.admin)).toBe(true)
    expect(() => (wordpressMcpPolicy.protectedOptions as string[]).pop()).toThrow()
  })
})

describe('isWpCliCommandDenied', () => {
  it.each([
    'post list --post_type=page --format=json',
    'post update 12 --post_title=Контакты',
    'post meta update 12 price 1990',
    'option get blogname',
    'option update blogdescription Цветы_с_доставкой',
    'menu item add-post main-menu 12',
    'media import /workspace/inbox/photo.jpg --post_id=12',
    'term list category',
    'wp post get 12',
  ])('allows %s', (command) => {
    expect(isWpCliCommandDenied(wp(command))).toBe(false)
  })

  it.each([
    'user list',
    'user create hacker h@x.ru --role=administrator',
    'plugin install wp-file-manager --activate',
    'theme activate twentytwentyfive',
    'wc shop_order list --user=1',
    'core update',
    'db export -',
    'db query SELECT',
    'config get DB_PASSWORD',
    'eval phpinfo();',
    'eval-file /tmp/x.php',
    'shell',
    'package install x',
    'search-replace old new',
    'cron event run --due-now',
    'role create shop',
    'super-admin add x',
    'maintenance-mode activate',
    'rewrite flush --hard',
    'login create admin',
    'USER list',
  ])('denies the command group of %s', (command) => {
    expect(isWpCliCommandDenied(wp(command))).toBe(true)
  })

  it.each([
    'post delete 12 --force',
    'term delete category 5',
    'comment delete 3',
    'menu delete main',
    'post generate --count=500',
    'media regenerate --yes',
    'option list',
  ])('denies the subcommand %s', (command) => {
    expect(isWpCliCommandDenied(wp(command))).toBe(true)
  })

  it.each([
    'option update active_plugins []',
    'option delete template',
    'option update stylesheet evil',
    'option update siteurl https://evil.example',
    'option patch update home x',
    'option get admin_email',
    'option update users_can_register 1',
    'option update default_role administrator',
    'option update wp_user_roles {}',
    'option get woocommerce_yookassa_settings',
    'option get mailserver_pass',
    'option get yookassa_shop_password',
    'option update SiteURL https://evil.example',
  ])('denies protected options: %s', (command) => {
    expect(isWpCliCommandDenied(wp(command))).toBe(true)
  })

  it.each([
    'post list --exec=system("id");',
    'post list --require=/tmp/x.php',
    'post list --ssh=user@other-host',
    'post list --http=https://other.example',
    'post list --path=/var/www/other',
    'post list --url=https://other.example',
    'post list --user=admin',
    'post list --USER=admin',
  ])('denies global flags that run code or change the target: %s', (command) => {
    expect(isWpCliCommandDenied(wp(command))).toBe(true)
  })

  it('denies orders and personal data requests by post type', () => {
    expect(isWpCliCommandDenied(wp('post list --post_type=shop_order'))).toBe(true)
    expect(isWpCliCommandDenied(wp('post list --post_type=page,shop_order_refund'))).toBe(true)
    expect(isWpCliCommandDenied(wp('post list --post_type=user_request'))).toBe(true)
    expect(isWpCliCommandDenied(wp('post create --post_type=Shop_Order'))).toBe(true)
  })

  it('fails closed on empty, aliased and ambiguous input', () => {
    expect(isWpCliCommandDenied([])).toBe(true)
    expect(isWpCliCommandDenied(['wp'])).toBe(true)
    expect(isWpCliCommandDenied(wp('@prod post list'))).toBe(true)
    expect(isWpCliCommandDenied(wp('post list @prod'))).toBe(true)
    expect(isWpCliCommandDenied(['post', 'list', '--'])).toBe(true)
    expect(isWpCliCommandDenied(['post', 'get', '1\0'])).toBe(true)
  })
})

describe('isProtectedOption', () => {
  it('matches exact names, wildcards and case-insensitively', () => {
    for (const name of [
      'active_plugins',
      'template',
      'stylesheet',
      'siteurl',
      'home',
      'admin_email',
      'users_can_register',
      'default_role',
      'wp_user_roles',
      'woocommerce_stripe_settings',
      'woocommerce_gateway_order',
      'mailserver_login',
      'some_plugin_api_key',
      'ADMIN_EMAIL',
    ]) {
      expect(isProtectedOption(name)).toBe(true)
    }
    for (const name of ['blogname', 'blogdescription', 'theme_mods_shop', 'homepage_title']) {
      expect(isProtectedOption(name)).toBe(false)
    }
  })
})

describe('isRestRequestDenied', () => {
  it.each([
    ['GET', '/wp/v2/pages?per_page=100'],
    ['POST', '/wp/v2/pages/12'],
    ['PUT', '/wp-json/wp/v2/posts/5'],
    ['POST', '/wp/v2/media'],
    ['GET', '/wp/v2/menu-items?menus=3'],
    ['GET', '/wc/v3/products/15'],
    ['POST', '/wc/v3/products/15'],
  ])('allows %s %s', (method, route) => {
    expect(isRestRequestDenied(method, route)).toBe(false)
  })

  it.each([
    ['GET', '/wp/v2/users'],
    ['GET', '/wp/v2/users/me'],
    ['POST', '/wp/v2/users/1/application-passwords'],
    ['POST', '/wp/v2/plugins'],
    ['POST', '/wp/v2/themes/twentytwentyfive'],
    ['POST', '/wp/v2/settings'],
    ['GET', '/wc/v3/orders'],
    ['GET', '/wc/v2/orders/15/notes'],
    ['GET', '/wc/v3/customers'],
    ['POST', '/wc/v3/payment_gateways/yookassa'],
    ['POST', '/wc/v3/settings/checkout'],
    ['POST', '/wc/v3/webhooks'],
    ['POST', '/wc/store/v1/checkout'],
    ['GET', '/wc-analytics/reports/customers'],
    ['POST', '/batch/v1'],
    ['GET', '/oembed/1.0/proxy?url=http://169.254.169.254/'],
  ])('denies %s %s', (method, route) => {
    expect(isRestRequestDenied(method, route)).toBe(true)
  })

  it('denies deletions and method overrides: they go through wp_delete', () => {
    expect(isRestRequestDenied('DELETE', '/wp/v2/pages/12')).toBe(true)
    expect(isRestRequestDenied('delete', '/wp/v2/pages/12')).toBe(true)
    expect(isRestRequestDenied('POST', '/wp/v2/pages/12?_method=DELETE')).toBe(true)
  })

  it('normalizes the route before matching', () => {
    for (const route of [
      '/WP/V2/USERS',
      '//wp/v2//users/',
      '/wp-json/wp/v2/users',
      '/index.php/wp-json/wp/v2/users',
      '/wp/v2/./users',
      '/wp/v2/%75sers',
      '/wp/v2/pages/../users',
      '/wp/v2/%2575sers',
      '/wp/v2/%zz',
      '/?rest_route=/wp/v2/users',
      '/wp/v2/pages?rest_route=/wp/v2/users',
    ]) {
      expect(isRestRequestDenied('GET', route)).toBe(true)
    }
  })
})

describe('isAdminUrlDenied', () => {
  it.each([
    'https://shop.example.ru/wp-admin/',
    'https://shop.example.ru/wp-admin/post.php?post=12&action=edit',
    '/wp-admin/edit.php?post_type=page',
    '/wp-admin/customize.php',
    '/wp-admin/nav-menus.php',
    '/wp-admin/upload.php',
    '/wp-admin/admin.php?page=wpcf7',
    '/wp-admin/edit.php?post_type=product',
    '/shop/some-page/',
  ])('allows %s', (url) => {
    expect(isAdminUrlDenied(url)).toBe(false)
  })

  it.each([
    'https://shop.example.ru/wp-admin/plugins.php',
    '/wp-admin/plugin-install.php?tab=upload',
    '/wp-admin/plugin-editor.php',
    '/wp-admin/theme-editor.php',
    '/wp-admin/themes.php',
    '/wp-admin/users.php',
    '/wp-admin/user-new.php',
    '/wp-admin/profile.php',
    '/wp-admin/options-general.php',
    '/wp-admin/options.php',
    '/wp-admin/admin.php?page=wc-settings&tab=checkout',
    '/wp-admin/admin.php?page=wc-orders&action=edit&id=5',
    '/wp-admin/edit.php?post_type=shop_order',
    '/wp-admin/network/plugins.php',
    '/blog/wp-admin/plugins.php',
    '/WP-ADMIN/Plugins.php',
    '/wp-admin//plugins.php',
    '/wp-admin/./plugins.php',
    '/wp-admin/x/../plugins.php',
    '/wp-admin/plugin%73.php',
    '/wp-admin/admin.php?page=dashboard&page=wc-settings',
    '/wp-admin/admin.php?page=WC-Settings',
    '/wp-admin/%zz',
  ])('denies %s', (url) => {
    expect(isAdminUrlDenied(url)).toBe(true)
  })
})

describe('isAdminAjaxActionDenied', () => {
  it('denies plugin and theme installs and personal data tools', () => {
    for (const action of [
      'install-plugin',
      'update-theme',
      'Delete-Plugin',
      'toggle-auto-updates',
    ]) {
      expect(isAdminAjaxActionDenied(action)).toBe(true)
    }
    expect(isAdminAjaxActionDenied('heartbeat')).toBe(false)
    expect(isAdminAjaxActionDenied('query-attachments')).toBe(false)
  })
})
