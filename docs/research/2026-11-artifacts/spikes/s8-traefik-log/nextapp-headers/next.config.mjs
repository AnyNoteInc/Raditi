// Which Referrer-Policy wins on /a: the global one of next.config, a later entry for /a, the proxy, a route?
export default {
  output: 'standalone',
  poweredByHeader: false,
  async headers() {
    return [
      { source: '/:path*', headers: [{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }] },
      { source: '/a', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
    ]
  },
}
