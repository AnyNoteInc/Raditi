import { describe, expect, it } from 'vitest'
import { isRestRequestDenied, isWpCliCommandDenied } from './wordpress-mcp-policy.ts'

describe('isWpCliCommandDenied', () => {
  it.each([
    'wp user list',
    'role create shop-assistant Assistant',
    'plugin install woocommerce',
    'theme activate twentytwentyfive',
    'wc shop_order list',
    'post delete 12 --force',
    'post list --post_type=shop_order_refund,user_request',
    'option get smtp_password',
    'option list',
    'db query SELECT',
    'eval echo',
    'wp --require=setup.php post list',
  ])('permits %s on the selected site', (command) => {
    expect(isWpCliCommandDenied(command.split(' '))).toBe(false)
  })

  it.each(
    [
      [],
      ['wp'],
      ['@prod', 'post', 'list'],
      ['post', 'list', '--ssh=example.test'],
      ['post', 'list', '--http=https://example.test'],
      ['post', 'list', '--url=https://example.test'],
      ['post', 'list', '--PATH', '/tmp/other'],
      ['post', 'list', '--user=admin'],
      ['post', 'list', '--'],
      ['post', 'get', '1\0'],
    ].map((args) => [args] as const),
  )('refuses ambiguous or retargeted argv %j', (args) => {
    expect(isWpCliCommandDenied(args)).toBe(true)
  })
})

describe('isRestRequestDenied', () => {
  it.each([
    ['GET', '/wp/v2/comments?_embed=replies'],
    ['POST', '/wp-json/wc-admin/options'],
    ['PATCH', '/wc-admin/onboarding/profile'],
    ['DELETE', '/wp/v2/posts/5'],
    ['POST', '/wp/v2/posts/5?_method=DELETE'],
    ['POST', '/?rest_route=/batch/v1'],
  ])('permits %s %s', (method, route) => {
    expect(isRestRequestDenied(method, route)).toBe(false)
  })

  it.each([
    ['GET', '/wp/v2/posts/5?_method=DELETE'],
    ['HEAD', '/?rest_route=/wp/v2/posts/5&%20.method=POST'],
    ['GET', '/wp/v2/posts/../comments'],
    ['GET', '/wp/v2/%zz'],
    ['POST', '/?rest_route=%25zz'],
  ])('refuses ambiguous paths and reads disguised as writes: %s %s', (method, route) => {
    expect(isRestRequestDenied(method, route)).toBe(true)
  })
})
